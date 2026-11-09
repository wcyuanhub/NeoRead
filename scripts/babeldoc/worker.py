"""Offline BabelDOC adapter. Document prose is read from a private job snapshot.

No provider credentials or network translation are used. The pinned upstream
paragraph hook preserves BabelDOC's formula/style processing and typesetter.
"""
import argparse
import json
import logging
import os
from pathlib import Path
import re
import shutil
import socket
import sys
import unicodedata

from formulas import coverage_summary, math_signature, restore_formulas, restore_sentences


VERSION = "0.6.4"


def normalized(text):
    text = unicodedata.normalize("NFKC", text).casefold()
    return "".join(c for c in text if c.isalnum())


def plain_target(text):
    # Keep math until formula placeholders have been restored below.
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"(?m)^\s{0,3}#{1,6}\s+", "", text)
    return re.sub(r"(\*\*|__|`)", "", text).strip()


class SavedTranslations:
    """Match contiguous complete sentences; never duplicate a whole paragraph
    into a smaller fragment just because the two boxes intersect.
    """
    def __init__(self, blocks):
        self.pages = {}
        for block in blocks:
            self.pages.setdefault(block["page"], []).append(block)

    def match(self, page, text, box, width, height):
        from rapidfuzz.fuzz import ratio

        query = normalized(text)
        if not query:
            return None
        candidates = []
        for block in self.pages.get(page, []):
            bounds = block["bounds"]
            bx, by = bounds["x"] * width, bounds["y"] * height
            bw, bh = bounds["width"] * width, bounds["height"] * height
            # BabelDOC coordinates have bottom-left origin.
            px, py = (box.x + box.x2) / 2, height - (box.y + box.y2) / 2
            if not (bx - 6 <= px <= bx + bw + 6 and by - 6 <= py <= by + bh + 6):
                continue
            sentences = block["sentences"]
            variants = [(block["text"], "\n".join(s["target"] for s in sentences), (block["id"], 0, len(sentences) - 1))]
            for start in range(len(sentences)):
                source, target = "", []
                for end in range(start, len(sentences)):
                    sentence = sentences[end]
                    source += sentence.get("anchor") or sentence["source"]
                    target.append(sentence["target"])
                    variants.append((source, "\n".join(target), (block["id"], start, end)))
            for source, target, key in variants:
                value = normalized(source)
                if not value or min(len(value), len(query)) / max(len(value), len(query)) < .84:
                    continue
                # A fuzzy whole-paragraph score can still accept a truncated
                # final sentence. Require agreement at both fragment edges.
                edge = min(24, len(query), len(value))
                if ratio(query[:edge], value[:edge]) < 90 or ratio(query[-edge:], value[-edge:]) < 90:
                    continue
                score = ratio(query, value)
                if score >= 92:
                    candidates.append((score, target, key))
        candidates.sort(key=lambda c: c[0], reverse=True)
        if not candidates:
            return None
        best = candidates[0]
        # Equal-looking short text in overlapping blocks is ambiguous.
        if any(c[2][0] != best[2][0] and c[0] >= best[0] - 1 for c in candidates[1:]):
            return None
        return best[1], best[2]


def emit(**value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--assets", required=True)
    args = parser.parse_args()
    os.environ["NEOREAD_BABELDOC_CACHE"] = str(Path(args.assets).resolve())
    os.environ["TIKTOKEN_CACHE_DIR"] = str(Path(args.assets).resolve() / "tiktoken")
    os.environ["NEOREAD_BABELDOC_WORK"] = str(Path(args.output).resolve().parent)
    # Upstream logs may contain entire paragraphs and translation outputs.
    logging.disable(logging.CRITICAL)
    from babeldoc.const import __version__
    if __version__ != VERSION:
        raise RuntimeError("runtime_version")
    from babeldoc.docvision.doclayout import DocLayoutModel
    import onnxruntime
    onnxruntime.disable_telemetry_events()
    from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode
    from babeldoc.format.pdf.document_il.midend import il_translator
    from babeldoc.format.pdf.document_il.utils.layout_helper import get_char_unicode_string
    from babeldoc.translator.translator import BaseTranslator
    from layout import capture_layout, source_typesetter

    def offline(*_args, **_kwargs):
        raise RuntimeError("offline_resource_missing")
    socket.socket.connect = offline
    socket.create_connection = offline
    snapshot = json.loads(Path(args.snapshot).read_text())
    saved = SavedTranslations(snapshot["blocks"])
    counts = {"translated": 0, "preserved": 0, "translatedCharacters": 0, "preservedCharacters": 0}
    records = []
    used = set()
    written, rejected = set(), {}
    blocks = {b["id"]: b for b in snapshot["blocks"]}
    adapter_failed = [False]
    layouts = {}
    layout_counts = {"sourceAnchored": 0, "centered": 0}

    class OfflineTranslator(BaseTranslator):
        name = "neoread-saved"
        def __init__(self):
            # Avoid upstream's global SQLite translation cache.
            self.lang_in, self.lang_out = "en", "zh-CN"
        def do_translate(self, *_args, **_kwargs):
            raise RuntimeError("unexpected_translation")
        def do_llm_translate(self, *_args, **_kwargs):
            raise NotImplementedError

    class SavedILTranslator(il_translator.ILTranslator):
        def translate_paragraph(self, paragraph, page, pbar=None, tracker=None,
                               page_font_map=None, xobj_font_map=None, **_kwargs):
            try:
                self.translation_config.raise_if_cancelled()
                original = paragraph.unicode or ""
                matched = saved.match(page.page_number + 1, original, paragraph.box,
                                      page.mediabox.box.x2 - page.mediabox.box.x,
                                      page.mediabox.box.y2 - page.mediabox.box.y)
                covered = set() if not matched else {(matched[1][0], i) for i in range(matched[1][1], matched[1][2] + 1)}
                if not matched or covered & used:
                    counts["preserved"] += 1
                    counts["preservedCharacters"] += len(original)
                    return
                source_layout = capture_layout(paragraph, page)
                text, translate_input = self.pre_translate_paragraph(paragraph, tracker, page_font_map, xobj_font_map)
                if not text or not translate_input:
                    counts["preserved"] += 1
                    counts["preservedCharacters"] += len(original)
                    rejected.update((key, "preprocess_unavailable") for key in covered)
                    return
                sentences = blocks[matched[1][0]]["sentences"][matched[1][1]:matched[1][2]+1]
                formulas = [p for p in translate_input.placeholders if isinstance(p, il_translator.FormulaPlaceholder)]
                target, completed = restore_sentences(
                    [plain_target(s["target"]) for s in sentences],
                    [s.get("anchor") or s["source"] for s in sentences],
                    [(p.placeholder, get_char_unicode_string(p.formula.pdf_character)) for p in formulas],
                    translate_input.unicode)
                rejected.update(((matched[1][0], matched[1][1]+i), "formula_unresolved")
                                for i in range(len(sentences)) if i not in completed)
                if target is None or not completed:
                    counts["preserved"] += 1
                    counts["preservedCharacters"] += len(original)
                    return
                translate_input.placeholders = [p for p in translate_input.placeholders if not isinstance(p, il_translator.FormulaPlaceholder) or p.placeholder in target]
                self.post_translate_paragraph(paragraph, tracker, translate_input, target)
                layouts[id(paragraph)] = source_layout
                records.append((paragraph, page.page_number + 1, matched[1]))
                used.update(covered)
                written.update((matched[1][0], matched[1][1]+i) for i in completed)
                counts["translated"] += 1
                counts["translatedCharacters"] += len(original)
            except Exception:
                # Upstream does not inspect paragraph futures. A partially
                # modified paragraph must prevent publication of the whole PDF.
                adapter_failed[0] = True
            finally:
                if pbar:
                    pbar.advance(1)

    # Pinned compatibility seam: high_level imports this class by value.
    import babeldoc.format.pdf.high_level as high_level
    high_level.ILTranslator = SavedILTranslator
    high_level.Typesetting = source_typesetter(high_level.Typesetting, layouts, layout_counts)
    work = Path(args.output).parent
    emit(type="stage", phase="parsing")
    config = TranslationConfig(
        translator=OfflineTranslator(), input_file=args.input,
        lang_in="en", lang_out="zh-CN", doc_layout_model=DocLayoutModel.load_available(),
        output_dir=work / "generated", working_dir=work / "working",
        no_dual=True, auto_extract_glossary=False, save_auto_extracted_glossary=False,
        use_rich_pbar=False, pool_max_workers=1, qps=1, min_text_length=1,
        watermark_output_mode=WatermarkOutputMode.NoWatermark,
    )
    phases = {
            "Parse PDF and Create Intermediate Representation": "parsing",
            "Parse Page Layout": "layout",
            "Parse Paragraphs": "paragraphs",
            "Parse Formulas and Styles": "formulas",
            "Translate Paragraphs": "mapping",
            "Typesetting": "typesetting",
            "Generate drawing instructions": "saving",
    }
    def progress(**event):
        if event["type"] == "progress_start" and event.get("stage") in phases:
            emit(type="stage", phase=phases[event["stage"]])
    # The synchronous upstream pipeline has no queue completion race. The
    # subprocess is cancelled by the server; callbacks only emit bounded stages.
    from babeldoc.progress_monitor import ProgressMonitor
    with ProgressMonitor(high_level.get_translation_stage(config), progress_change_callback=progress) as monitor:
        result = high_level.do_translate(monitor, config)
    if adapter_failed[0]:
        raise RuntimeError("engine_failed")
    if not counts["translated"] or not result.mono_pdf_path:
        raise RuntimeError("no_mapped_translation")
    import pymupdf
    with pymupdf.open(result.mono_pdf_path) as output, pymupdf.open(args.input) as original:
        if len(output) != len(original) or any(a.rect != b.rect for a, b in zip(output, original)):
            raise RuntimeError("page_mismatch")
    from positions import build_positions
    positions = build_positions(snapshot, records, result.mono_pdf_path, lambda text: math_signature(plain_target(text)))
    Path(args.output).with_name("positions.json").write_text(json.dumps(positions, ensure_ascii=True))
    shutil.copyfile(result.mono_pdf_path, args.output)
    emit(type="finish", **counts, **layout_counts,
         **coverage_summary(snapshot["blocks"], written, rejected))


if __name__ == "__main__":
    try:
        main()
    except BaseException as exc:
        code = str(exc) if str(exc) in {"runtime_version", "offline_resource_missing", "no_mapped_translation", "page_mismatch", "layout_overflow"} else "engine_failed"
        emit(type="error", reason=code)
        sys.exit(1)
