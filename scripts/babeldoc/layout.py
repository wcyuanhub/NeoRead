"""Source-anchored typography for the pinned BabelDOC typesetter.

Policies are captured before translation and keyed by IL object identity. They
never infer alignment from the Chinese text or move content to another column.
"""
from copy import deepcopy
from dataclasses import dataclass
from statistics import median

from positions import paragraph_characters


@dataclass(frozen=True)
class ParagraphLayout:
    alignment: str
    line_skip: float
    box: object


def capture_layout(paragraph, page):
    box = paragraph.box
    size = paragraph.pdf_style.font_size
    chars = [c for c in paragraph_characters(paragraph)
             if c.char_unicode and c.char_unicode.strip() and c.box
             and c.pdf_style and c.pdf_style.font_size >= size * .8]
    baselines = []
    for char in sorted(chars, key=lambda c: c.box.y, reverse=True):
        if not baselines or abs(baselines[-1] - char.box.y) > size * .35:
            baselines.append(char.box.y)
    gaps = [a - b for a, b in zip(baselines, baselines[1:]) if .8 * size < a - b < 2 * size]
    line_skip = max(1.18, min(1.30, median(gaps) / size)) if gaps else 1.18

    alignment = "left"
    center = (box.x + box.x2) / 2
    page_box = page.mediabox.box
    page_center = (page_box.x + page_box.x2) / 2
    # Full-width titles and short front matter retain the original page axis.
    front_matter = ((box.y + box.y2) / 2 > page_box.y + (page_box.y2 - page_box.y) * 2 / 3
                    and len(paragraph.unicode or "") < 240)
    if abs(center - page_center) <= max(4, size * .5) and (
            paragraph.layout_label == "title" or front_matter):
        alignment = "center"
    elif paragraph.layout_label == "title":
        # Infer the column axis from the nearest overlapping prose block, not
        # the title's tight glyph box (which also exists for left subheadings).
        neighbors = [p for p in page.pdf_paragraph if p is not paragraph
                     and p.layout_label == "plain text" and p.box
                     and min(p.box.x2, box.x2) > max(p.box.x, box.x)]
        if neighbors:
            neighbor = min(neighbors, key=lambda p: min(abs(p.box.y2 - box.y), abs(p.box.y - box.y2)))
            axis = (neighbor.box.x + neighbor.box.x2) / 2
            if abs(center - axis) <= max(4, size * .5):
                alignment = "center"
    return ParagraphLayout(alignment, line_skip, deepcopy(box))


def align_lines(units, box, alignment):
    if alignment == "left":
        return units
    lines = []
    tolerance = median(u.height for u in units) * .7 if units else 1
    for unit in units:
        # Formula ink includes superscript offsets. A real wrap also resets x;
        # a raised footnote at the right edge still belongs to the current line.
        wrapped = (lines and unit.box.x <= lines[-1][-1].box.x + .01
                   and abs(lines[-1][0].box.y - unit.box.y) > max(1, tolerance))
        if not lines or wrapped:
            lines.append([])
        lines[-1].append(unit)
    result = []
    for line in lines:
        left, right = min(u.box.x for u in line), max(u.box.x2 for u in line)
        offset = ((box.x + box.x2) - (left + right)) / 2
        for unit in line:
            # These units have already been scaled. A second scale would shrink
            # centered titles twice. Formula offsets are relative to the advance
            # origin, not the formula's ink bounding box.
            x, y = unit.box.x, unit.box.y
            if unit.formular:
                x -= unit.formular.x_offset
                y -= unit.formular.y_offset
            result.append(unit.relocate(x + offset, y, 1.0))
    return result


def source_typesetter(base, policies, statistics):
    """Override only successfully translated paragraphs; keep native rendering,
    font mapping, formula units, glyph output and render-order handling intact.
    """
    class SourceTypesetting(base):
        def preprocess_document(self, document, pbar):
            self.source_scales = {}
            super().preprocess_document(document, pbar)
            # Upstream clamps every paragraph to one document-wide modal scale.
            # A dense footnote must not shrink unrelated titles/body paragraphs.
            for page in document.page:
                for paragraph in page.pdf_paragraph:
                    if id(paragraph) in self.source_scales:
                        paragraph.optimal_scale = self.source_scales[id(paragraph)]

        def _get_optimal_scale(self, paragraph, page, units, use_english_line_break=True):
            scale = super()._get_optimal_scale(paragraph, page, units, use_english_line_break)
            if id(paragraph) in policies:
                self.source_scales[id(paragraph)] = scale
            return scale

        def _find_optimal_scale_and_layout(self, paragraph, page, units, initial_scale=1.0,
                                          use_english_line_break=True, apply_layout=False):
            policy = policies.get(id(paragraph))
            if not policy:
                return super()._find_optimal_scale_and_layout(
                    paragraph, page, units, initial_scale, use_english_line_break, apply_layout)
            # Stay in the source frame. In particular, never invoke upstream's
            # horizontal box expansion across the column gutter.
            box = policy.box
            for step in range(14):
                self.translation_config.raise_if_cancelled()
                scale = round(initial_scale - step * .02, 4)
                if scale < .74:
                    break
                for leading in (policy.line_skip, max(1.12, policy.line_skip - .06)):
                    placed, fits = super()._layout_typesetting_units(
                        units, box, scale, leading, paragraph, use_english_line_break)
                    if not fits:
                        continue
                    placed = align_lines(placed, box, policy.alignment)
                    if apply_layout:
                        from babeldoc.format.pdf.document_il import PdfParagraphComposition
                        paragraph.scale = scale
                        paragraph.box = deepcopy(box)
                        paragraph.pdf_paragraph_composition = []
                        for unit in placed:
                            chars, curves, forms = unit.render()
                            paragraph.pdf_paragraph_composition.extend(
                                PdfParagraphComposition(pdf_character=c) for c in chars)
                            page.pdf_curve.extend(curves)
                            page.pdf_form.extend(forms)
                        statistics["sourceAnchored"] += 1
                        if policy.alignment == "center":
                            statistics["centered"] += 1
                    return scale, placed if apply_layout else None
            # Do not publish clipped, microscopic or cross-column output.
            raise RuntimeError("layout_overflow")

    return SourceTypesetting
