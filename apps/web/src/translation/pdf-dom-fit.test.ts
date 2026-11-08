// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fitTranslatedElement } from "./pdf-dom-fit";

type Measure = (
  size: number,
  lineHeight: number,
) => {
  width: number;
  height: number;
};

function createMeasuredElement(measure: Measure) {
  const element = document.createElement("div");
  const sizes: number[] = [];
  const dimensions = () =>
    measure(
      Number.parseFloat(element.style.fontSize),
      Number(element.style.lineHeight),
    );
  // jsdom has no layout engine: model integer scroll metrics from current styles.
  Object.defineProperties(element, {
    scrollWidth: {
      get: () => {
        sizes.push(Number.parseFloat(element.style.fontSize));
        return dimensions().width;
      },
    },
    scrollHeight: { get: () => dimensions().height },
  });
  return { element, sizes };
}

describe("fitTranslatedElement", () => {
  it.each([
    { preferred: 0, expected: 6 },
    { preferred: 5.5, expected: 6 },
    { preferred: 6, expected: 6 },
    { preferred: 12, expected: 12 },
    { preferred: 32, expected: 32 },
    { preferred: 80, expected: 32 },
  ])(
    "starts at the bounded preferred size ($preferred → $expected)",
    ({ preferred, expected }) => {
      const { element, sizes } = createMeasuredElement((size, lineHeight) => ({
        width: Math.ceil(size * 2),
        height: Math.ceil(size * lineHeight),
      }));
      expect(fitTranslatedElement(element, 100, 100, preferred, 1.25)).toEqual({
        size: expected,
      });
      expect(sizes).toEqual([expected]);
      expect(element.style.fontSize).toBe(`${expected}px`);
      expect(element.style.width).toBe("100px");
    },
  );

  it.each([
    { constraint: "width", width: 190, height: 100, expected: 19 },
    { constraint: "height", width: 300, height: 48, expected: 19 },
    { constraint: "both axes", width: 190, height: 45, expected: 18 },
  ])(
    "shrinks by quarter pixels until $constraint fits",
    ({ width, height, expected }) => {
      const { element, sizes } = createMeasuredElement((size, lineHeight) => ({
        width: Math.ceil(size * 10),
        height: Math.ceil(size * lineHeight * 2),
      }));
      expect(fitTranslatedElement(element, width, height, 20, 1.25)).toEqual({
        size: expected,
      });
      expect(sizes).toEqual(
        Array.from(
          { length: (20 - expected) / 0.25 + 1 },
          (_, index) => 20 - index * 0.25,
        ),
      );
      expect(element.style.fontSize).toBe(`${expected}px`);
      expect(element.scrollWidth).toBeLessThanOrEqual(width);
      expect(element.scrollHeight).toBeLessThanOrEqual(height);
    },
  );

  it.each([
    { preferred: 8, minimum: 6 },
    { preferred: 10, minimum: 9 },
    { preferred: 12, minimum: 9 },
    { preferred: 20, minimum: 13 },
  ])(
    "accepts an exact fit at the readable minimum ($preferred → $minimum px)",
    ({ preferred, minimum }) => {
      const { element, sizes } = createMeasuredElement((size) => ({
        width: Math.ceil(size * 100),
        height: Math.ceil(size * 2),
      }));
      expect(
        fitTranslatedElement(element, minimum * 100, 100, preferred, 1.25),
      ).toEqual({ size: minimum });
      expect(sizes.at(-1)).toBe(minimum);
      expect(sizes.every((size) => size >= minimum)).toBe(true);
    },
  );

  it.each([
    { preferred: 10, minimum: 9 },
    { preferred: 12, minimum: 9 },
    { preferred: 13, minimum: 9 },
  ])(
    "reports unreadable instead of publishing below the minimum ($preferred px)",
    ({ preferred, minimum }) => {
      const { element, sizes } = createMeasuredElement((size) => ({
        width: Math.ceil(size * 100),
        height: Math.ceil(size * 2),
      }));
      expect(
        fitTranslatedElement(element, minimum * 100 - 1, 100, preferred, 1.25),
      ).toEqual({ size: null, reason: "unreadable" });
      expect(sizes.length).toBeGreaterThan(1);
      expect(sizes.at(-1)).toBeLessThan(minimum);
    },
  );

  it("probes to the absolute floor before reporting a fit as unreadable", () => {
    // A 12 px preference has a 65% floor of 7.8 px, not 8 px.
    const { element, sizes } = createMeasuredElement((size) => ({
      width: Math.ceil(size * 100),
      height: Math.ceil(size * 2),
    }));
    expect(fitTranslatedElement(element, 780, 100, 12, 1.25)).toEqual({
      size: null,
      reason: "unreadable",
    });
    expect(sizes.at(-1)).toBeCloseTo(7.8);
    expect(element.style.fontSize).toBe("7.8px");
  });

  it.each([
    { axis: "width", width: 59, height: 100 },
    { axis: "height", width: 100, height: 59 },
    { axis: "both axes", width: 59, height: 59 },
  ])(
    "reports $axis overflow once even the absolute floor fails",
    ({ width, height }) => {
      const { element, sizes } = createMeasuredElement((size) => ({
        width: Math.ceil(size * 10),
        height: Math.ceil(size * 10),
      }));
      expect(fitTranslatedElement(element, width, height, 8, 1.25)).toEqual({
        size: null,
        reason: "overflow",
      });
      expect(sizes.at(-1)).toBe(6);
      expect(element.style.fontSize).toBe("6px");
    },
  );

  it.each([
    { width: 101, height: 50, expected: 6 },
    { width: 102, height: 50, expected: null },
    { width: 101, height: 51, expected: null },
  ])(
    "uses ceil-width and floor-height for fractional boxes ($width × $height)",
    ({ width, height, expected }) => {
      const { element } = createMeasuredElement((size) => ({
        width: Math.ceil((size / 6) * width),
        height: Math.ceil((size / 6) * height),
      }));
      expect(fitTranslatedElement(element, 100.2, 50.9, 6, 1.25)).toEqual(
        expected === null
          ? { size: null, reason: "overflow" }
          : { size: expected },
      );
      expect(element.style.width).toBe("100.2px");
    },
  );

  it.each([
    { requested: -2, expected: 1.1 },
    { requested: 1.0999, expected: 1.1 },
    { requested: 1.1, expected: 1.1 },
    { requested: 1.35, expected: 1.35 },
    { requested: 1.6, expected: 1.6 },
    { requested: 1.6001, expected: 1.6 },
    { requested: 10, expected: 1.6 },
  ])(
    "clamps line height to [1.1, 1.6] before measuring ($requested → $expected)",
    ({ requested, expected }) => {
      const measuredLineHeights: number[] = [];
      const { element } = createMeasuredElement((size, lineHeight) => {
        measuredLineHeights.push(lineHeight);
        return {
          width: Math.ceil(size * 2),
          height: Math.ceil(size * lineHeight),
        };
      });
      expect(fitTranslatedElement(element, 100, 100, 12, requested)).toEqual({
        size: 12,
      });
      expect(element.style.lineHeight).toBe(String(expected));
      expect(measuredLineHeights.length).toBeGreaterThan(0);
      expect(measuredLineHeights.every((value) => value === expected)).toBe(
        true,
      );
    },
  );

  it.each([
    { lineHeight: 0, expected: { size: 20 } },
    { lineHeight: 1.25, expected: { size: 19 } },
    { lineHeight: 4, expected: { size: 15 } },
  ])(
    "accounts for the clamped line height when fitting ($lineHeight)",
    ({ lineHeight, expected }) => {
      const { element } = createMeasuredElement((size, ratio) => ({
        width: Math.ceil(size * 2),
        height: Math.ceil(size * ratio),
      }));
      expect(fitTranslatedElement(element, 100, 24, 20, lineHeight)).toEqual(
        expected,
      );
      expect(element.scrollHeight).toBeLessThanOrEqual(24);
    },
  );

  it.each([
    { box: 80, expected: { size: 8 } },
    { box: 59, expected: { size: null, reason: "overflow" } },
  ])(
    "preserves the complete DOM without clipping on success or overflow ($expected)",
    ({ box, expected }) => {
      const { element } = createMeasuredElement((size) => ({
        width: Math.ceil(size * 10),
        height: Math.ceil(size * 10),
      }));
      element.innerHTML =
        "<p>完整译文 <strong>English</strong></p><p>最后一句不能丢失。</p>";
      element.style.overflow = "visible";
      const originalHTML = element.innerHTML;
      const originalChildren = [...element.childNodes];

      expect(fitTranslatedElement(element, box, box, 8, 1.25)).toEqual(
        expected,
      );
      expect(element.innerHTML).toBe(originalHTML);
      expect(element.childNodes.length).toBe(originalChildren.length);
      originalChildren.forEach((child, index) => {
        expect(element.childNodes[index]).toBe(child);
      });
      expect(element.style.overflow).toBe("visible");
      for (const property of [
        "overflow-x",
        "overflow-y",
        "height",
        "max-height",
        "clip",
        "clip-path",
        "text-overflow",
        "line-clamp",
        "-webkit-line-clamp",
        "transform",
      ]) {
        expect(element.style.getPropertyValue(property), property).toBe("");
      }
    },
  );
});
