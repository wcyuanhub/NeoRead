import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

import pymupdf
from positions import build_positions, sentence_slices


def glyph(text):
    return {'text': text, 'bounds': {'x': .1, 'y': .1, 'width': .01, 'height': .02}}


class PositionTests(unittest.TestCase):
    def test_repeated_sentences_are_split_in_order(self):
        values = list(map(glyph, 'Same. Same.'))
        slices = sentence_slices(values, ['Same.', 'Same.'])
        self.assertEqual([''.join(g['text'] for g in s) for s in slices], ['Same. ', 'Same.'])
        self.assertIsNone(sentence_slices(values, ['Same.', 'Missing.']))
        self.assertIsNone(sentence_slices(values, ['Same.']))
        self.assertIsNone(sentence_slices(values, ['...', 'Same.']))

    def test_ligature_must_not_cross_sentence_boundary(self):
        self.assertEqual(sentence_slices([glyph('ﬁ')], ['fi']), [[glyph('ﬁ')]])
        self.assertIsNone(sentence_slices([glyph('ﬁ')], ['f', 'i']))

    def test_opening_punctuation_stays_with_next_sentence(self):
        slices = sentence_slices(list(map(glyph, 'First. “Second.”')), ['First.', '“Second.”'])
        self.assertEqual([''.join(g['text'] for g in s) for s in slices], ['First. ', '“Second.”'])
        self.assertIsNone(sentence_slices(list(map(glyph, 'First. Second.')), ['First.', '“Second.”']))

    def test_geometry_and_final_pdf_text_must_both_agree(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'text.pdf'
            with pymupdf.open() as pdf:
                page = pdf.new_page(width=600, height=800)
                page.insert_text((60, 100), 'First. Second.')
                raw = page.get_text('rawdict')['blocks'][0]['lines'][0]['spans'][0]['chars']
                chars = []
                for c in raw:
                    x, y, x2, y2 = c['bbox']
                    chars.append(NS(char_unicode=c['c'], box=NS(x=x, y=800-y2, x2=x2, y2=800-y)))
                pdf.save(path)
            paragraph = NS(pdf_paragraph_composition=[NS(pdf_character=c) for c in chars])
            block = {'id': 'b', 'page': 1, 'sourceHash': 'hash', 'sentences': [
                {'target': 'First.'}, {'target': 'Second.'}]}
            snapshot = {'blocks': [block]}
            records = [(paragraph, 1, ('b', 0, 1))]
            def build():
                return build_positions(snapshot, records, path, lambda x: x)['blocks'][0]
            result = build()
            self.assertEqual(result['status'], 'mapped')
            self.assertEqual(''.join(g['text'] for g in result['sentences'][0]['glyphs']), 'First. ')
            self.assertEqual(result['targets'], ['First.', 'Second.'])
            chars[0].char_unicode = 'X'
            self.assertEqual(build()['status'], 'fallback')
            chars[0].char_unicode = 'F'
            chars[0].box.x += 100
            chars[0].box.x2 += 100
            self.assertEqual(build()['status'], 'fallback')
            chars[0].box.x -= 100
            chars[0].box.x2 -= 100
            block['sentences'][1]['target'] = 'Changed.'
            self.assertEqual(build()['status'], 'fallback')
            self.assertEqual(build()['sentences'], [])

    def test_missing_duplicate_or_partial_sentence_never_enables_block(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'text.pdf'
            with pymupdf.open() as pdf:
                pdf.new_page()
                pdf.save(path)
            snapshot = {'blocks': [{'id': 'b', 'page': 1, 'sourceHash': 'hash',
                                    'sentences': [{'target': 'First.'}]}]}
            result = build_positions(snapshot, [], path, lambda x: x)
            self.assertEqual(result['blocks'][0]['status'], 'fallback')
            self.assertEqual(result['blocks'][0]['sentences'], [])


if __name__ == '__main__':
    unittest.main()
