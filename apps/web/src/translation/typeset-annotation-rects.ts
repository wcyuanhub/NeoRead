import type { Annotation, PDFBlock, TranslationBlock } from "@neoread/core";
import type { PDFTypesetPositions } from "@neoread/api";
import { currentPosition, type TypesetRect } from "./TypesetTextLayer";
import { translatedAnnotationRanges } from "./annotations";

/** Resolve the same sentence/quote ranges as the reader, never source rects. */
export function typesetAnnotationRects(
  positions: PDFTypesetPositions,
  blocks: PDFBlock[],
  translations: TranslationBlock[],
  annotations: Annotation[],
) {
  const host = document.createElement("div");
  const glyphs: { node: HTMLElement; page: number; bounds: TypesetRect }[] = [];
  for (const block of blocks) {
    const position = currentPosition(
      positions.blocks.find((p) => p.blockId === block.id),
      block,
      translations.find((t) => t.blockId === block.id),
    );
    if (!position) continue;
    const section = document.createElement("section");
    section.dataset.translationBlock = block.id;
    for (const sentence of position.sentences) {
      const span = document.createElement("span");
      span.dataset.sentence = String(sentence.index);
      for (const glyph of sentence.glyphs) {
        const node = document.createElement("span");
        node.textContent = glyph.text;
        span.append(node);
        glyphs.push({ node, page: position.page, bounds: glyph.bounds });
      }
      section.append(span);
    }
    host.append(section);
  }
  const result = new Map<string, { page: number; rects: TypesetRect[] }[]>();
  for (const annotation of annotations) {
    const mark = annotation.location.translation;
    if (!mark || annotation.kind === "bookmark") continue;
    const ranges = translatedAnnotationRanges(host, [annotation], translations);
    // An annotation spanning several blocks must be placed whole.
    if (ranges.length !== (mark.ranges?.length ?? 1)) continue;
    const pages = new Map<number, TypesetRect[]>();
    let partialGlyph = false;
    for (const { range } of ranges) {
      for (const glyph of glyphs) {
        if (!range.intersectsNode(glyph.node)) continue;
        const clipped = document.createRange();
        clipped.selectNodeContents(glyph.node);
        if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0)
          clipped.setStart(range.startContainer, range.startOffset);
        if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0)
          clipped.setEnd(range.endContainer, range.endOffset);
        const text = clipped.toString();
        if (!text) continue;
        if (text !== glyph.node.textContent) partialGlyph = true;
        pages.set(glyph.page, [...(pages.get(glyph.page) ?? []), glyph.bounds]);
      }
    }
    if (!partialGlyph && pages.size)
      result.set(
        annotation.id,
        [...pages].map(([page, rects]) => ({ page, rects })),
      );
  }
  return result;
}
