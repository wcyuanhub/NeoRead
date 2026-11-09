"""Offline, source-checked formula restoration for saved Markdown translations.

The layout parser's formula class also includes bullets and punctuation. Treat
those as literals; never require a Markdown math span for a list marker. Linear
math can span both ordinary source text and vector formula fragments. Complex
math still requires an exact vector match, not a lossy LaTeX-to-text conversion.
"""
from collections import Counter
import re
import unicodedata


MATH = re.compile(r"\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]")
SYMBOLS = {"\\cdot": "·", "\\times": "×", "\\leq": "≤", "\\geq": "≥",
           "\\neq": "≠", "\\alpha": "α", "\\beta": "β", "\\theta": "θ",
           "\\sigma": "σ"}
TOKEN = re.compile(r"\d+(?:\.\d+)?|[A-Za-z]+|[α-ωΑ-Ω]|[^\s]", re.UNICODE)


def math_signature(text):
    text = unicodedata.normalize("NFKC", text)
    for command, symbol in SYMBOLS.items():
        text = re.sub(re.escape(command) + r"(?![A-Za-z])", lambda _: symbol, text)
    text = re.sub(r"\\(?:mathrm|mathbf|mathit|text|left|right)\b", "", text)
    text = text.replace("−", "-")
    return re.sub(r"[\s${}_^]|\\[()[\]]", "", text)


def _linear_math(text):
    if text.startswith("$$"):
        text = text[2:-2]
    elif text.startswith("$"):
        text = text[1:-1]
    else:
        text = text[2:-2]
    for command, symbol in SYMBOLS.items():
        text = re.sub(re.escape(command) + r"(?![A-Za-z])", lambda _: symbol, text)
    text = unicodedata.normalize("NFKC", text).replace("−", "-").strip()
    tokens = list(TOKEN.finditer(text))
    # No scripts, fractions, commands, arbitrary words or grouping removal.
    # Their vector geometry must be preserved by the exact path instead.
    if not tokens or any(not re.fullmatch(r"\d+(?:\.\d+)?|[A-Za-zα-ωΑ-Ω]|[=+*/×·<>≤≥≠()-]", t[0]) for t in tokens):
        return None
    if text.count("(") != text.count(")"):
        return None
    return text, tokens


def _expand(source, formulas):
    """Return exact source text and whole-placeholder character intervals."""
    spans, chunks, cursor, size = [], [], 0, 0
    entries = []
    for placeholder, original in formulas:
        if source.count(placeholder) != 1:
            return None
        entries.append((source.index(placeholder), placeholder, original))
    for start, placeholder, original in sorted(entries):
        prefix = source[cursor:start]
        chunks.extend((prefix, original))
        size += len(prefix)
        spans.append((size, size + len(original), placeholder))
        size += len(original)
        cursor = start + len(placeholder)
    chunks.append(source[cursor:])
    return "".join(chunks), spans


def _restore_linear(target, formulas, source):
    expanded = _expand(source, formulas)
    if expanded is None:
        return None
    text, spans = expanded
    # Keep original offsets: source formulas and PDF line-break characters are
    # not reconstructed from fuzzy text. "n by n" is a literal dimension phrase.
    tokens = list(TOKEN.finditer(text))
    values = [unicodedata.normalize("NFKC", t[0]).replace("−", "-") for t in tokens]
    for i in range(1, len(values) - 1):
        if values[i] == "by" and all(re.fullmatch(r"\d+|[A-Za-z]", values[j]) for j in (i-1, i+1)):
            values[i] = "×"
    maths = []
    for match in MATH.finditer(target):
        linear = _linear_math(match[0])
        if linear is None:
            return None
        rendered, parts = linear
        maths.append((match, rendered, parts, [t[0] for t in parts]))
    occupied, restored, replacements = set(), set(), []
    # Match full expressions first. Then a remaining "$n$" cannot accidentally
    # consume the n inside a previously matched "$n = 9$" or "$n × n$".
    groups = {}
    for entry in maths:
        groups.setdefault(tuple(entry[3]), []).append(entry)
    for needle, entries in sorted(groups.items(), key=lambda item: -len(item[0])):
        candidates = []
        for start in range(len(tokens) - len(needle) + 1):
            end = start + len(needle)
            if tuple(values[start:end]) != needle or occupied.intersection(range(start, end)):
                continue
            left, right = tokens[start].start(), tokens[end-1].end()
            overlaps = [(a, b, p) for a, b, p in spans if a < right and b > left]
            # Never cut a vector expression at an inferred token boundary.
            if any(a < left or b > right for a, b, _ in overlaps):
                continue
            candidates.append((start, end, overlaps))
        # Extra occurrences are ambiguous (including an article "a"). Do not
        # choose an arbitrary source occurrence to justify new math in a target.
        if len(candidates) != len(entries):
            return None
        for (match, rendered, parts, _), (start, end, overlaps) in zip(entries, candidates):
            indices = set(range(start, end))
            if occupied & indices:
                return None
            occupied.update(indices)
            edits = []
            for a, b, placeholder in overlaps:
                inside = [i for i in range(start, end) if tokens[i].start() >= a and tokens[i].end() <= b]
                if not inside:
                    return None
                first, last = inside[0] - start, inside[-1] - start
                edits.append((parts[first].start(), parts[last].end(), placeholder))
                restored.add(placeholder)
            for a, b, placeholder in reversed(edits):
                rendered = rendered[:a] + placeholder + rendered[b:]
            replacements.append((match.start(), match.end(), rendered))
    if restored != {p for _, _, p in spans}:
        return None
    for a, b, rendered in sorted(replacements, reverse=True):
        target = target[:a] + rendered + target[b:]
    return target


def restore_formulas(target, formulas, source=None):
    remaining = []
    literals = {}
    for placeholder, original in formulas:
        if original and all(c in "´`ˊˋ¨ˆˇ˘˙˚˜˝" or unicodedata.combining(c) for c in original):
            continue
        if re.fullmatch(r"\d{1,3}[,.]?", original):
            digits = original.rstrip(",.")
            suffix = "[,，]" if original.endswith(",") else r"[.。]" if original.endswith(".") else ""
            pattern = r"(?<![\w-])" + re.escape(digits) + suffix + r"(?!\d)"
            maths = list(MATH.finditer(target))
            matches = [m for m in re.finditer(pattern, target)
                       if not any(a.start() < m.end() and a.end() > m.start() for a in maths)]
            if len(matches) == 1:
                match = matches[0]
                target = target[:match.start()] + placeholder + target[match.end():]
                continue
        if re.fullmatch(r"\[\d+(?:\s*[,–-]\s*\d+)*\][,.]?|[•●▪◦∗*†‡\[\]]", original):
            literal = original.rstrip(",.")
            suffix = "[,，]?" if original.endswith(",") else "[.。]?" if original.endswith(".") else ""
            literals.setdefault((literal, suffix), []).append(placeholder)
        else:
            remaining.append((placeholder, original))
    for (literal, suffix), placeholders in literals.items():
        matches = list(re.finditer(re.escape(literal) + suffix, target))
        if len(matches) != len(placeholders):
            return None
        for match, placeholder in reversed(list(zip(matches, placeholders))):
            target = target[:match.start()] + placeholder + target[match.end():]
    maths = list(MATH.finditer(target))
    if len(maths) == len(remaining) and all(math_signature(m[0]) == math_signature(original) for m, (_, original) in zip(maths, remaining)):
        for match, (placeholder, _) in reversed(list(zip(maths, remaining))):
            target = target[:match.start()] + placeholder + target[match.end():]
        return target
    if source is None:
        return None
    # Literal placeholders are already handled, but their expanded source still
    # supplies context. Only actual math placeholders must be consumed here.
    for placeholder, original in formulas:
        if (placeholder, original) not in remaining:
            source = source.replace(placeholder, original)
    return _restore_linear(target, remaining, source)


def split_sentences(source, formulas, sentences):
    """Split only an exact complete source sequence, outside placeholders."""
    expanded = _expand(source, formulas)
    if expanded is None:
        return None
    text, spans = expanded
    chars, offsets = [], []
    for i, char in enumerate(text):
        value = "".join(c for c in unicodedata.normalize("NFKC", char).casefold() if c.isalnum())
        chars.append(value)
        offsets.extend([i] * len(value))
    needles = ["".join(c for c in unicodedata.normalize("NFKC", s).casefold() if c.isalnum()) for s in sentences]
    if any(not n for n in needles) or "".join(chars) != "".join(needles):
        return None
    boundaries, offset = [0], 0
    for i, needle in enumerate(needles[:-1]):
        offset += len(needle)
        if offsets[offset] == offsets[offset-1]:
            return None
        boundary = offsets[offset]
        prefix = re.match(r"^[^\w]*", sentences[i+1])[0].strip()
        if prefix:
            cursor = boundary
            for c in reversed(prefix):
                while cursor and text[cursor-1].isspace():
                    cursor -= 1
                if not cursor or text[cursor-1] != c:
                    return None
                cursor -= 1
            boundary = cursor
        if any(a < boundary < b for a, b, _ in spans):
            return None
        boundaries.append(boundary)
    boundaries.append(len(text))
    result = []
    for a, b in zip(boundaries, boundaries[1:]):
        fragment = text[a:b]
        for x, y, placeholder in reversed(spans):
            if a <= x and y <= b:
                fragment = fragment[:x-a] + placeholder + fragment[y-a:]
        result.append(fragment)
    return result


def restore_sentences(targets, sources, formulas, source):
    """Keep a failed sentence in source form; translate its verified neighbors."""
    if not targets or len(targets) != len(sources):
        return None, set()
    target = restore_formulas("\n".join(targets), formulas, source)
    if target is not None:
        return target, set(range(len(targets)))
    fragments = split_sentences(source, formulas, sources)
    if fragments is None:
        return None, set()
    result, written = [], set()
    for i, (target, fragment) in enumerate(zip(targets, fragments)):
        local = [(p, original) for p, original in formulas if p in fragment]
        restored = restore_formulas(target, local, fragment)
        if restored is None:
            result.append(fragment)
        else:
            result.append(restored)
            written.add(i)
    return "\n".join(result), written


def coverage_summary(blocks, written, rejected):
    expected = {(b["id"], i) for b in blocks for i in range(len(b["sentences"]))}
    missing = expected - written
    return {"savedSentences": len(expected), "writtenSentences": len(expected & written),
            "unwrittenSentences": len(missing),
            "unwrittenReasons": dict(Counter(rejected.get(key, "source_alignment") for key in missing))}
