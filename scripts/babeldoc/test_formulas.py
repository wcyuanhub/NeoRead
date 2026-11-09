import unittest

from formulas import coverage_summary, restore_formulas, restore_sentences, split_sentences


class FormulaTests(unittest.TestCase):
    def test_bullets_and_ellipsis_brackets_are_literals_not_math(self):
        self.assertEqual(restore_formulas("• 语境修改：正文。", [("<b1>", "•")]), "<b1> 语境修改：正文。")
        self.assertEqual(restore_formulas("描述 [...] 后续。", [("<b1>", "["), ("<b2>", "]")]), "描述 <b1>...<b2> 后续。")
        self.assertIsNone(restore_formulas("• 重复 •", [("<b1>", "•")]))
        self.assertEqual(restore_formulas("• 一 • 二", [("<b1>", "•"), ("<b2>", "•")]), "<b1> 一 <b2> 二")

    def test_linear_math_can_mix_source_text_and_vector_fragments(self):
        source = "Place n queens on a n by n board where n <b1>."
        target = "在 $n \\times n$ 棋盘上放置 $n$ 个皇后，其中 $n = 9$。"
        result = restore_formulas(target, [("<b1>", "= 9")], source)
        self.assertEqual(result, "在 n × n 棋盘上放置 n 个皇后，其中 n <b1>。")

    def test_split_vector_fragments_are_grouped_without_dropping_symbols(self):
        self.assertEqual(restore_formulas("$x + y$。", [("<b1>", "x"), ("<b2>", "+ y")], "Use <b1> <b2>."), "<b1> <b2>。")
        self.assertEqual(restore_formulas("$n = 9$。", [("<b1>", "9")], "where n = <b1>."), "n = <b1>。")

    def test_new_or_lossy_math_is_not_invented(self):
        self.assertIsNone(restore_formulas("$n = 8$", [("<b1>", "= 9")], "n <b1>"))
        self.assertIsNone(restore_formulas("$n \\times n$", [], "n queens on an m by m board"))
        self.assertIsNone(restore_formulas("$x^2$", [], "x2"))
        self.assertIsNone(restore_formulas("$\\frac{x}{y}$", [], "x/y"))
        self.assertIsNone(restore_formulas("$x$", [("<b1>", "x + y")], "<b1>"))
        self.assertIsNone(restore_formulas("$x$", [], "x and x"))
        self.assertIsNone(restore_formulas("$x$", [], "extra"))

    def test_repeated_dimensions_are_matched_in_source_order(self):
        self.assertEqual(restore_formulas("$9 \\times 9$，$9 \\times 9$，$n$。",
                                         [("<b1>", "9×9"), ("<b2>", "9 × 9")],
                                         "<b1> then <b2> and n."), "<b1>，<b2>，n。")

    def test_exact_complex_math_stays_vector(self):
        self.assertEqual(restore_formulas("$x^2$", [("<b1>", "x2")], "<b1>"), "<b1>")
        self.assertIsNone(restore_formulas("$x-y$", [("<b1>", "x+y")], "<b1>"))

    def test_only_the_unresolved_sentence_stays_in_english(self):
        sources = ["First sentence.", "Use x squared.", "Last sentence."]
        source = "First sentence. Use <b1> squared. Last sentence."
        target, written = restore_sentences(["第一句。", "使用 $y^2$。", "最后一句。"], sources,
                                            [("<b1>", "x")], source)
        self.assertEqual(written, {0, 2})
        self.assertEqual(target, "第一句。\nUse <b1> squared. \n最后一句。")
        self.assertNotIn("$", target)

    def test_sentence_boundaries_cannot_split_vector_or_ligature(self):
        self.assertIsNone(split_sentences("<b1>", [("<b1>", "First Second")], ["First", "Second"]))
        self.assertIsNone(split_sentences("ﬁ", [], ["f", "i"]))
        self.assertIsNone(split_sentences("Different. Second.", [], ["First.", "Second."]))
        self.assertEqual(split_sentences('First. “Second.”', [], ['First.', '“Second.”']), ['First. ', '“Second.”'])

    def test_coverage_counts_saved_sentences_separately_from_coordinates(self):
        blocks = [{"id": "a", "sentences": [{}, {}, {}]}, {"id": "b", "sentences": [{}]}]
        result = coverage_summary(blocks, {("a", 0), ("a", 2)}, {("a", 1): "formula_unresolved"})
        self.assertEqual(result, {"savedSentences": 4, "writtenSentences": 2, "unwrittenSentences": 2,
                                  "unwrittenReasons": {"formula_unresolved": 1, "source_alignment": 1}})


if __name__ == "__main__":
    unittest.main()
