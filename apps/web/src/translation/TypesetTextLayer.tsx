import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
import type { PDFTypesetPositionBlock } from "@neoread/api";
import { citationHref } from "../reading-links";
import { figureReferences } from "../readers/figure-references";

export type TypesetBlockRenderer = (
  block: PDFBlock,
  content?: ReactNode,
  props?: { className: string; style: CSSProperties },
) => ReactNode;
export type TypesetRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** A source hash alone cannot validate geometry after retranslation. */
export function currentPosition(
  position: PDFTypesetPositionBlock | undefined,
  block: PDFBlock,
  translation?: TranslationBlock,
) {
  if (
    !position ||
    position.status !== "mapped" ||
    position.page !== block.page ||
    translation?.status !== "complete" ||
    position.sourceHash !== translation.sourceHash ||
    position.targets.length !== translation.sentences.length ||
    position.targets.some(
      (target, i) => target !== translation.sentences[i].target,
    ) ||
    position.sentences.length !== translation.sentences.length
  )
    return;
  if (
    position.sentences.some(
      (s, i) =>
        s.index !== i ||
        !s.glyphs.length ||
        s.glyphs.some((g) => !g.text || !validRect(g.bounds)),
    )
  )
    return;
  return position;
}
function validRect(r: TypesetRect) {
  return (
    [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.width > 0 &&
    r.height > 0 &&
    r.x + r.width <= 1.001 &&
    r.y + r.height <= 1.001
  );
}
export function positionBounds(
  position: PDFTypesetPositionBlock,
  sentence?: number,
): TypesetRect {
  const rects = position.sentences
    .filter((s) => sentence === undefined || s.index === sentence)
    .flatMap((s) => s.glyphs.map((g) => g.bounds));
  const x = Math.min(...rects.map((r) => r.x)),
    y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}

export function TypesetSentences({
  position,
  bounds,
  width,
  height,
  onCitation,
}: {
  position: PDFTypesetPositionBlock;
  bounds: TypesetRect;
  width: number;
  height: number;
  onCitation: (blockId: string, label: string) => void;
}) {
  const [advances, setAdvances] = useState<number[][]>([]);
  useLayoutEffect(() => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    setAdvances(
      position.sentences.map((sentence) =>
        sentence.glyphs.map((g) => {
          context.font = `${g.bounds.height * height * 0.85}px sans-serif`;
          return context.measureText(g.text).width;
        }),
      ),
    );
  }, [position, height]);
  return (
    <>
      {position.sentences.map((sentence, sentenceIndex) => {
        const value = sentence.glyphs.map((g) => g.text).join("");
        const links = readingGlyphLinks(value);
        let offset = 0;
        return (
          <span
            key={sentence.index}
            className="translation-sentence"
            data-sentence={sentence.index}
          >
            {sentence.glyphs.map((g, i) => {
              const link = links.find(
                (l) => offset >= l.start && offset < l.end,
              );
              offset += g.text.length;
              const style: CSSProperties = {
                left: (g.bounds.x - bounds.x) * width,
                top: (g.bounds.y - bounds.y) * height,
                width: advances[sentenceIndex]?.[i] || g.bounds.width * width,
                height: g.bounds.height * height,
                fontSize: g.bounds.height * height * 0.85,
                lineHeight: `${g.bounds.height * height}px`,
                transform: advances[sentenceIndex]?.[i]
                  ? `scaleX(${(g.bounds.width * width) / advances[sentenceIndex][i]})`
                  : undefined,
                transformOrigin: "left top",
              };
              const text = (
                <span className="pdf-typeset-glyph" style={style}>
                  {g.text}
                </span>
              );
              return link ? (
                <a
                  key={i}
                  href={citationHref(position.blockId, link.label)}
                  onClick={(e) => {
                    e.preventDefault();
                    onCitation(position.blockId, link.label);
                  }}
                >
                  {text}
                </a>
              ) : (
                <span key={i}>{text}</span>
              );
            })}
          </span>
        );
      })}
    </>
  );
}
/** Preserve actual glyphs: do not expand ranges into text absent from the PDF. */
export function readingGlyphLinks(value: string) {
  const links = figureReferences(value).map((f) => ({
    start: f.index,
    end: f.index + f.text.length,
    label: `figure:${f.label}`,
  }));
  for (const match of value.matchAll(/\[(\d+(?:\s*[,，–-]\s*\d+)*)\]/g)) {
    const start = match.index + 1;
    for (const number of match[1].matchAll(/\d+/g))
      links.push({
        start: start + number.index,
        end: start + number.index + number[0].length,
        label: number[0],
      });
  }
  return links;
}
