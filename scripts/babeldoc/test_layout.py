import unittest
from copy import deepcopy
from types import SimpleNamespace as NS

from layout import ParagraphLayout, align_lines, capture_layout, source_typesetter


def box(x=50, y=100, x2=290, y2=200):
    return NS(x=x, y=y, x2=x2, y2=y2)


def paragraph(bounds, label="plain text", size=10, ys=()):
    chars = [NS(pdf_character=NS(char_unicode="a", box=box(y=y), pdf_style=NS(font_size=size)),
                pdf_formula=None, pdf_line=None, pdf_same_style_characters=None) for y in ys]
    return NS(box=bounds, layout_label=label, pdf_style=NS(font_size=size),
              unicode="Source text", pdf_paragraph_composition=chars, optimal_scale=None)


class Unit:
    def __init__(self, x, y, width=10, size=10):
        self.box = box(x, y, x + width, y + size)
        self.height = size
        self.formular = None

    def relocate(self, x, y, scale):
        return Unit(x, y, (self.box.x2 - self.box.x) * scale, self.height * scale)


class LayoutTests(unittest.TestCase):
    def test_original_column_axis_distinguishes_centered_and_left_titles(self):
        body = paragraph(box(320, 100, 560, 200), ys=(190, 179, 168))
        centered = paragraph(box(400, 210, 480, 225), "title")
        left = paragraph(box(320, 210, 430, 225), "title")
        page = NS(mediabox=NS(box=box(0, 0, 612, 792)), pdf_paragraph=[body, centered, left])
        self.assertEqual(capture_layout(centered, page).alignment, "center")
        self.assertEqual(capture_layout(left, page).alignment, "left")
        self.assertEqual(capture_layout(body, page).line_skip, 1.18)
        captured = capture_layout(body, page)
        body.box.x = 1
        self.assertEqual(captured.box.x, 320)

    def test_document_title_keeps_page_axis_and_original_leading(self):
        title = paragraph(box(96, 650, 516, 685), "title", 14, (670, 653))
        page = NS(mediabox=NS(box=box(0, 0, 612, 792)), pdf_paragraph=[title])
        captured = capture_layout(title, page)
        self.assertEqual(captured.alignment, "center")
        self.assertAlmostEqual(captured.line_skip, 17 / 14)

    def test_each_centered_line_keeps_its_size_and_vertical_position(self):
        units = [Unit(50, 180, size=8), Unit(60, 180, size=8), Unit(50, 168, size=8)]
        result = align_lines(units, box(), "center")
        self.assertEqual([u.height for u in result], [8, 8, 8])
        self.assertEqual([u.box.y for u in result], [180, 180, 168])
        for line in (result[:2], result[2:]):
            self.assertEqual((line[0].box.x + line[-1].box.x2) / 2, 170)
        self.assertEqual(units[0].box.x, 50)

    def test_fit_never_widens_the_source_frame_or_accepts_overflow(self):
        seen = []

        class Base:
            def _layout_typesetting_units(self, units, bounds, scale, leading, p, breaks):
                seen.append((deepcopy(bounds), scale, leading))
                return [Unit(bounds.x, bounds.y2 - 10)], scale <= .98

        p = paragraph(box())
        policy = ParagraphLayout("left", 1.18, deepcopy(p.box))
        cls = source_typesetter(Base, {id(p): policy}, {})
        engine = cls()
        engine.translation_config = NS(raise_if_cancelled=lambda: None)
        scale, _ = engine._find_optimal_scale_and_layout(p, None, [])
        self.assertEqual(scale, .98)
        self.assertTrue(all(b.x == 50 and b.x2 == 290 for b, _, _ in seen))

        Base._layout_typesetting_units = lambda *args: ([], False)
        with self.assertRaisesRegex(RuntimeError, "layout_overflow"):
            engine._find_optimal_scale_and_layout(p, None, [])

    def test_superscript_at_end_stays_with_the_centered_author_line(self):
        units = [Unit(50, 180), Unit(60, 180), Unit(70, 184, width=5, size=6)]
        result = align_lines(units, box(), "center")
        offsets = [a.box.x - b.box.x for a, b in zip(result, units)]
        self.assertEqual(offsets, [offsets[0]] * 3)
        self.assertEqual(result[-1].box.y, 184)
        self.assertEqual(result[-1].height, 6)

    def test_document_modal_scale_does_not_shrink_an_unrelated_title(self):
        p = paragraph(box(), "title")

        class Base:
            def preprocess_document(self, document, pbar):
                p.optimal_scale = self._get_optimal_scale(p, None, [])
                p.optimal_scale = .4  # upstream's document-wide clamp

            def _get_optimal_scale(self, *args):
                return 1.0

        engine = source_typesetter(Base, {id(p): ParagraphLayout("center", 1.18, p.box)}, {})()
        engine.preprocess_document(NS(page=[NS(pdf_paragraph=[p])]), None)
        self.assertEqual(p.optimal_scale, 1.0)


if __name__ == "__main__":
    unittest.main()
