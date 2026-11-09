// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PDFBlock, TranslationBlock, Annotation } from "@neoread/core";
import type { PDFTypesetPositionBlock } from "@neoread/api";
import {
  currentPosition,
  readingGlyphLinks,
  TypesetSentences,
  positionBounds,
} from "./TypesetTextLayer";
import { translatedSelection } from "./selection";
import { translatedAnnotationRanges } from "./annotations";
const block: PDFBlock = {
  id: "p1-b1",
  page: 1,
  label: "text",
  text: "First. Second.",
  bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
};
const saved: TranslationBlock = {
  blockId: block.id,
  status: "complete",
  sourceHash: "hash",
  sentences: [
    { source: "First.", target: "第一句。" },
    { source: "Second.", target: "第二句 [12]。" },
  ],
};
const position: PDFTypesetPositionBlock = {
  blockId: block.id,
  page: 1,
  sourceHash: "hash",
  targets: saved.sentences.map((s) => s.target),
  status: "mapped",
  sentences: saved.sentences.map((s, index) => ({
    index,
    glyphs: [...s.target].map((text, i) => ({
      text,
      bounds: {
        x: 0.1 + i * 0.015,
        y: 0.1 + index * 0.04,
        width: 0.015,
        height: 0.02,
      },
    })),
  })),
};
it("validates source, exact targets and every glyph before enabling semantic selection", () => {
  expect(currentPosition(position, block, saved)).toBe(position);
  expect(
    currentPosition(position, block, { ...saved, sourceHash: "different" }),
  ).toBeUndefined();
  expect(
    currentPosition(position, block, {
      ...saved,
      sentences: [{ source: "First.", target: "Changed." }],
    }),
  ).toBeUndefined();
  expect(
    currentPosition(
      {
        ...position,
        sentences: [
          {
            index: 0,
            glyphs: [
              { text: "x", bounds: { x: NaN, y: 0, width: 1, height: 1 } },
            ],
          },
        ],
      },
      block,
      saved,
    ),
  ).toBeUndefined();
});
it("shares sentence selection, annotation restoration and citation navigation with continuous text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const measure = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as CanvasRenderingContext2D);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    onCitation = vi.fn();
  await act(async () =>
    root.render(
      <section data-translation-block={block.id}>
        <TypesetSentences
          position={position}
          bounds={positionBounds(position)}
          width={600}
          height={800}
          onCitation={onCitation}
        />
      </section>,
    ),
  );
  const sentence = host.querySelector('[data-sentence="1"]')!;
  const range = document.createRange();
  range.selectNodeContents(sentence);
  range.getBoundingClientRect = () => new DOMRect(10, 20, 100, 20);
  const selection = translatedSelection(
    host,
    range,
    [block],
    [saved],
  )!.selection;
  expect(selection.text).toBe("第二句 [12]。");
  expect(
    host.querySelector<HTMLElement>(".pdf-typeset-glyph")!.style.transform,
  ).toContain("scaleX");
  expect(selection.location.translation).toMatchObject({
    sourceHash: "hash",
    sentenceIndexes: [1],
    start: 4,
    ranges: [expect.objectContaining({ wholeSentence: true })],
  });
  const mark: Annotation = {
    id: "a",
    documentId: "d",
    kind: "highlight",
    quote: selection.text,
    note: "",
    color: "#e6b94c",
    createdAt: "",
    location: selection.location,
  };
  expect(
    translatedAnnotationRanges(host, [mark], [saved])[0].range.toString(),
  ).toBe("第二句 [12]。");
  await act(async () =>
    host
      .querySelector("a")!
      .dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
  );
  expect(onCitation).toHaveBeenCalledWith(block.id, "12");
  // A different renderer may add spaces before the same sentence. The saved
  // range must still resolve within its exact sentence window.
  host
    .querySelector('[data-sentence="0"]')!
    .prepend(document.createTextNode("  "));
  expect(
    translatedAnnotationRanges(host, [mark], [saved])[0].range.toString(),
  ).toBe("第二句 [12]。");
  await act(async () => root.unmount());
  host.remove();
  measure.mockRestore();
  vi.unstubAllGlobals();
});
it("retains the actual citation and figure glyph ranges", () => {
  const text = "见 [3–5, 8] 和图 2。";
  expect(
    readingGlyphLinks(text).map((l) => [text.slice(l.start, l.end), l.label]),
  ).toEqual([
    ["图 2", "figure:2"],
    ["3", "3"],
    ["5", "5"],
    ["8", "8"],
  ]);
});
it("does not save a mixed unmapped original and mapped translation as a translated mark", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div data-typeset-original>unmapped</div><section data-translation-block="p1-b1"><span data-sentence="0">第一句。</span></section>';
  const range = document.createRange();
  range.selectNodeContents(host);
  expect(translatedSelection(host, range, [block], [saved])).toBeUndefined();
});
