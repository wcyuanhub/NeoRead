import unittest
from types import SimpleNamespace
from worker import SavedTranslations, normalized, restore_formulas


class SavedTranslationTests(unittest.TestCase):
    def setUp(self):
        self.block = {
            "id": "p1-b1", "page": 1, "text": "First sentence. Second sentence.",
            "bounds": {"x": .1, "y": .2, "width": .4, "height": .3},
            "sentences": [
                {"source": "First sentence.", "target": "第一句。"},
                {"source": "Second sentence.", "target": "第二句。"},
            ],
        }
        self.box = SimpleNamespace(x=60, y=400, x2=280, y2=600)

    def test_paragraph_and_sentence_split_reuse_saved_translation(self):
        saved = SavedTranslations([self.block])
        self.assertEqual(saved.match(1, self.block["text"], self.box, 600, 800)[0], "第一句。\n第二句。")
        self.assertEqual(saved.match(1, "Second sentence.", self.box, 600, 800)[0], "第二句。")

    def test_never_fill_a_partial_sentence_with_the_whole_translation(self):
        saved = SavedTranslations([self.block])
        self.assertIsNone(saved.match(1, "First", self.box, 600, 800))
        self.assertIsNone(saved.match(1, "First sentence. Second sent", self.box, 600, 800))
        self.assertIsNone(saved.match(2, self.block["text"], self.box, 600, 800))
        outside = SimpleNamespace(x=400, y=400, x2=500, y2=600)
        self.assertIsNone(saved.match(1, self.block["text"], outside, 600, 800))

    def test_overlapping_identical_blocks_are_ambiguous(self):
        second = {**self.block, "id": "p1-b2"}
        self.assertIsNone(SavedTranslations([self.block, second]).match(1, self.block["text"], self.box, 600, 800))

    def test_extraction_ligatures_and_line_breaks(self):
        self.assertEqual(normalized("ofﬁce inter-\nnational"), normalized("office international"))

    def test_math_stays_vector_and_mismatches_are_rejected(self):
        self.assertEqual(restore_formulas("其中 $x^2$ 为常数。", [("<b1>", "x2")]), "其中 <b1> 为常数。")
        self.assertIsNone(restore_formulas("缺失公式。", [("<b1>", "x2")]))
        self.assertIsNone(restore_formulas("$x$ 和 $y$", [("<b1>", "x")]))
        self.assertIsNone(restore_formulas("$y$ 和 $x$", [("<b1>", "x"), ("<b2>", "y")]))
        self.assertIsNone(restore_formulas("$x-y$", [("<b1>", "x+y")]))

    def test_citations_and_stars_are_not_treated_as_missing_math(self):
        self.assertEqual(restore_formulas("参见 [12]，其中 $x$ 为常量。", [("<b1>", "[12],"), ("<b2>", "x")]), "参见 <b1>其中 <b2> 为常量。")
        self.assertEqual(restore_formulas("∗ 贡献相同。", [("<b1>", "∗")]), "<b1> 贡献相同。")
        self.assertIsNone(restore_formulas("[12] 和 [12]", [("<b1>", "[12]")]))

    def test_detached_accents_do_not_reject_a_translated_paragraph(self):
        self.assertEqual(restore_formulas("参见 Barták 1999。", [("<b1>", "´")]), "参见 Barták 1999。")

    def test_only_unambiguous_footnote_markers_are_restored(self):
        self.assertEqual(restore_formulas("作者 1，作者乙", [("<b1>", "1,")]), "作者 <b1>作者乙")
        self.assertIsNone(restore_formulas("模型 R1 与 GPT-1", [("<b1>", "1")]))
        self.assertIsNone(restore_formulas("脚注 1 和 1", [("<b1>", "1")]))


if __name__ == "__main__":
    unittest.main()
