// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { Annotation, PDFBlock, TranslationBlock } from "@neoread/core";
import type { PDFTypesetPositionBlock } from "@neoread/api";
import { typesetAnnotationRects } from "./typeset-annotation-rects";
const block: PDFBlock = {
  id: "b",
  page: 2,
  label: "text",
  text: "Source",
  bounds: { x: 0.8, y: 0.8, width: 0.1, height: 0.1 },
};
const translation: TranslationBlock = {
  blockId: "b",
  sourceHash: "h",
  status: "complete",
  sentences: [{ source: "Source", target: "第一句。第二句。" }],
};
const position: PDFTypesetPositionBlock = {
  blockId: "b",
  page: 2,
  sourceHash: "h",
  status: "mapped",
  targets: ["第一句。第二句。"],
  sentences: [
    {
      index: 0,
      glyphs: [..."第一句。第二句。"].map((text, i) => ({
        text,
        bounds: { x: 0.1 + i * 0.02, y: 0.2, width: 0.02, height: 0.03 },
      })),
    },
  ],
};
const annotation: Annotation = {
  id: "a",
  documentId: "d",
  kind: "note",
  quote: "第二句。",
  note: "note",
  color: "#facc15",
  createdAt: "",
  location: {
    type: "pdf",
    page: 2,
    rects: [block.bounds],
    translation: {
      blockId: "b",
      sourceHash: "h",
      sentenceIndexes: [0],
      start: 4,
      end: 8,
      ranges: [
        {
          blockId: "b",
          sourceHash: "h",
          sentenceIndexes: [0],
          start: 4,
          end: 8,
          quote: "第二句。",
          targetText: "第一句。第二句。",
        },
      ],
    },
  },
};
const placements = (p = position, t = translation, a = annotation) =>
  typesetAnnotationRects(
    { version: 1, revision: "r", blocks: [p] },
    [block],
    [t],
    [a],
  );
it("uses final glyph positions instead of the source rectangle", () => {
  const rects = placements().get("a")!;
  expect(rects).toHaveLength(1);
  expect(rects[0].page).toBe(2);
  expect(rects[0].rects).toHaveLength(4);
  expect(rects[0].rects[0].x).toBeCloseTo(0.18);
  expect(rects[0].rects[0].y).toBe(0.2);
});
it("skips unmapped or stale targets and never exports a partial multi-block mark", () => {
  expect(
    placements({ ...position, status: "fallback", sentences: [] }).size,
  ).toBe(0);
  expect(
    placements(position, {
      ...translation,
      sentences: [{ source: "Source", target: "Changed" }],
    }).size,
  ).toBe(0);
  const mark = structuredClone(annotation);
  mark.location.translation!.ranges!.push({
    ...mark.location.translation!.ranges![0],
    blockId: "missing",
  });
  expect(placements(position, translation, mark).size).toBe(0);
});
it("refuses ambiguous quote recovery or half a ligature", () => {
  const mark = structuredClone(annotation);
  const part = mark.location.translation!.ranges![0];
  part.start = 100;
  part.end = 101;
  part.quote = "句。";
  expect(placements(position, translation, mark).size).toBe(0);
  const p = {
    ...position,
    targets: ["fi"],
    sentences: [
      {
        index: 0,
        glyphs: [
          { text: "fi", bounds: position.sentences[0].glyphs[0].bounds },
        ],
      },
    ],
  };
  const t = { ...translation, sentences: [{ source: "Source", target: "fi" }] };
  Object.assign(part, { start: 0, end: 1, quote: "f", targetText: "fi" });
  expect(placements(p, t, mark).size).toBe(0);
});
