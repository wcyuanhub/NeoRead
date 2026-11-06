import { describe, expect, it, vi } from "vitest";
import type { PDFBlock } from "@neoread/core";
import type {
  PDFPageProxy,
  TextContent,
  TextItem,
  TextStyle,
} from "pdfjs-dist/types/src/display/api";
import { overlaps, type Rect } from "./pdf-layout";
import { preservedLabels } from "./pdf-content";
import { pageBlockLayouts } from "./pdf-page-layout";

const width = 400;
const height = 500;
const bodyBox = { x: 30, y: 40, width: 150, height: 26 };

function block(id = "body", box = bodyBox, label = "text"): PDFBlock {
  return {
    id,
    page: 1,
    label,
    text: "Original source text.",
    bounds: {
      x: box.x / width,
      y: box.y / height,
      width: box.width / width,
      height: box.height / height,
    },
  };
}

function text(
  x: number,
  baseline: number,
  extent: number,
  size = 10,
  fontName = "regular",
  str = "Original source text.",
): TextItem {
  return {
    str,
    dir: "ltr",
    width: extent,
    height: size,
    transform: [size, 0, 0, size, x, height - baseline],
    fontName,
    hasEOL: false,
  };
}

function pageFixture(
  items: TextContent["items"] = [text(30, 50, 150), text(30, 64, 120)],
  fonts: Record<string, unknown> = {
    regular: { name: "ABCDEF+TimesNewRomanPSMT", bold: false },
  },
  styles: Record<string, TextStyle> = {},
  convert = (x: number, y: number) => [x, height - y],
) {
  const content: TextContent = {
    items,
    lang: null,
    styles: {
      regular: {
        ascent: 0.8,
        descent: -0.2,
        vertical: false,
        fontFamily: "serif",
      },
      ...styles,
    },
  };
  const mock = {
    pageNumber: 1,
    getViewport: vi.fn(() => ({
      width,
      height,
      convertToViewportPoint: convert,
    })),
    getTextContent: vi.fn(async () => content),
    commonObjs: {
      has: vi.fn((name: string) => Object.hasOwn(fonts, name)),
      get: vi.fn((name: string): unknown => fonts[name]),
    },
    render: vi.fn(),
    cleanup: vi.fn(),
  };
  return { page: mock as unknown as PDFPageProxy, mock, content };
}

function canvas(
  pixel: (x: number, y: number) => number[] = () => [255, 255, 255, 255],
) {
  const getImageData = vi.fn((x: number, y: number, w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++)
      for (let col = 0; col < w; col++)
        data.set(pixel(x + col, y + row), (row * w + col) * 4);
    return { data };
  });
  const context = { getImageData } as unknown as CanvasRenderingContext2D;
  return { context, getImageData };
}

async function layout(
  fixture = pageFixture(),
  blocks = [block()],
  surface = canvas(),
  scale = 1,
) {
  return pageBlockLayouts(fixture.page, blocks, surface.context, scale);
}

describe("safe page masks", () => {
  it("uses display points, actual glyph metrics and a unitless line height", async () => {
    const fixture = pageFixture();
    const surface = canvas((x, y) =>
      (y === 90 || y === 120) && x >= 60 && x < 150
        ? [0, 0, 0, 255]
        : [255, 255, 255, 255],
    );
    const original = structuredClone(fixture.content);
    const blocks = [block()];
    const originalBlocks = structuredClone(blocks);
    const result = await layout(fixture, blocks, surface, 2);
    expect(result.get("body")).toEqual({
      box: bodyBox,
      mask: { x: 29.25, y: 39.25, width: 151.5, height: 27.5 },
      fontSize: 10,
      lineHeight: 1.4,
      fontFamily: "serif",
      fontWeight: 400,
      textAlign: "left",
    });
    expect(surface.getImageData).toHaveBeenCalledWith(58, 78, 304, 56);
    expect(await layout(fixture, blocks, canvas(), 1)).toEqual(result);
    expect(fixture.content).toEqual(original);
    expect(blocks).toEqual(originalBlocks);
    expect(fixture.mock.render).not.toHaveBeenCalled();
    expect(fixture.mock.cleanup).not.toHaveBeenCalled();
    expect(fixture.mock.getViewport).toHaveBeenCalledWith({ scale: 1 });
  });

  it("keeps unsegmented monochrome artwork outside measured text unchanged", async () => {
    const fixture = pageFixture([text(30, 50, 100)]);
    const surface = canvas((x, y) =>
      x >= 145 && x <= 155 && y >= 43 && y <= 52
        ? [0, 0, 0, 255]
        : [255, 255, 255, 255],
    );
    const result = await layout(fixture, [block()], surface);
    expect(result.get("body")?.mask).toBeUndefined();
    expect(result.get("body")?.reason).toBe("background");
  });

  it("keeps columns separate even when PDF.js emits interleaved runs", async () => {
    const left = block("left");
    const right = block("right", { x: 220, y: 40, width: 150, height: 45 });
    const fixture = pageFixture(
      [
        text(220, 53, 150, 14, "sans"),
        text(30, 50, 150),
        text(220, 74, 110, 14, "sans"),
        text(30, 64, 120),
      ],
      { sans: { name: "Helvetica", bold: false } },
    );
    const result = await layout(fixture, [left, right]);
    expect(result.get("left")).toMatchObject({
      fontSize: 10,
      lineHeight: 1.4,
      fontFamily: "serif",
    });
    expect(result.get("right")).toMatchObject({
      fontSize: 14,
      lineHeight: 1.5,
      fontFamily: "sans-serif",
    });
    const a = result.get("left")!.mask!;
    const b = result.get("right")!.mask!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(overlaps(a, b)).toBe(false);
  });

  it("expands a tight detector box to the glyphs with only a small fringe", async () => {
    const result = await layout(pageFixture([text(29, 50, 152)]), [
      block("tight", { x: 30, y: 42, width: 150, height: 8 }),
    ]);
    expect(result.get("tight")!.mask).toEqual({
      x: 28.25,
      y: 41.25,
      width: 153.5,
      height: 11.5,
    });
  });

  it("clips the fringe to the displayed page", async () => {
    const result = await layout(pageFixture([text(0, 8, 40)]), [
      block("edge", { x: 0, y: 0, width: 40, height: 10 }),
    ]);
    expect(result.get("edge")!.mask).toEqual({
      x: 0,
      y: 0,
      width: 40.75,
      height: 10.75,
    });
  });

  it.each(["neighbor block", "unassigned glyph"])(
    "rejects a fringe touching %s",
    async (neighbor) => {
      const fixture = pageFixture([text(30, 50, 150)]);
      const blocks = [block("body", { x: 30, y: 40, width: 150, height: 10 })];
      if (neighbor === "neighbor block")
        blocks.push(
          block("neighbor", { x: 30, y: 52, width: 150, height: 10 }, "table"),
        );
      else fixture.content.items.push(text(80, 55, 20, 4));
      const surface = canvas();
      const result = (await layout(fixture, blocks, surface)).get("body")!;
      expect(result.reason).toBe("overlap");
      expect(result.mask).toBeUndefined();
      expect(surface.getImageData).not.toHaveBeenCalled();
    },
  );

  it("rejects glyph extents that differ substantially from the detector box", async () => {
    const result = await layout(pageFixture([text(25, 50, 155)]));
    expect(result.get("body")).toMatchObject({ reason: "source" });
    expect(result.get("body")!.mask).toBeUndefined();
  });

  it.each<Rect>([
    { x: -1, y: 40, width: 150, height: 26 },
    { x: 300, y: 40, width: 150, height: 26 },
    { x: 30, y: 40, width: 0, height: 26 },
    { x: NaN, y: 40, width: 150, height: 26 },
  ])("rejects out-of-bounds/invalid rectangles: %j", async (box) => {
    const result = (await layout(pageFixture(), [block("bad", box)])).get(
      "bad",
    )!;
    expect(result.reason).toBe("bounds");
    expect(result.mask).toBeUndefined();
  });

  it("rejects rotated text without letting margin text overlap safe body text", async () => {
    const vertical = text(0, 0, 180);
    vertical.transform = [0, 10, -10, 0, 12, 100];
    const fixture = pageFixture([
      vertical,
      text(30, 50, 150),
      text(30, 64, 120),
    ]);
    const result = await layout(fixture, [
      block(),
      block("margin", { x: 4, y: 220, width: 10, height: 180 }),
    ]);
    expect(result.get("body")!.mask).toBeDefined();
    expect(result.get("margin")!.reason).toBe("source");
    expect(result.get("margin")!.mask).toBeUndefined();
  });

  it("handles rotated/cropped user coordinates when displayed text is horizontal", async () => {
    const item = text(0, 0, 150);
    item.transform = [0, 10, -10, 0, 60, 50];
    // Display x = user y - crop y; display y = user x - crop x.
    const fixture = pageFixture([item], {}, {}, (x, y) => [y - 20, x - 10]);
    const result = (await layout(fixture)).get("body")!;
    expect(result.box).toEqual(bodyBox);
    expect(result.mask).toBeDefined();
    expect(result.fontSize).toBe(10);
  });

  it.each([
    [200, 220, 255, 255],
    [240, 240, 240, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 0],
  ])("rejects colored/non-white/empty backgrounds: %j", async (...color) => {
    const result = (
      await layout(
        pageFixture(),
        [block()],
        canvas(() => color),
      )
    ).get("body")!;
    expect(result.reason).toBe("background");
    expect(result.mask).toBeUndefined();
  });

  it.each([...preservedLabels, "with-image"])(
    "preserves %s even with extracted text",
    async (label) => {
      const b = block("protected", bodyBox, label);
      if (label === "with-image") b.image = "image.png";
      const surface = canvas();
      const result = (await layout(pageFixture(), [b], surface)).get(
        "protected",
      )!;
      expect(result.reason).toBe("preserved");
      expect(result.mask).toBeUndefined();
      expect(surface.getImageData).not.toHaveBeenCalled();
    },
  );

  it("does not mask scanned or empty text pages, including whitespace/marked content", async () => {
    const fixture = pageFixture([
      { type: "beginMarkedContent", id: "marked" },
      text(30, 50, 150, 10, "regular", "   "),
    ]);
    const surface = canvas();
    const result = (await layout(fixture, [block()], surface)).get("body")!;
    expect(result.reason).toBe("source");
    expect(result.mask).toBeUndefined();
    expect(surface.getImageData).not.toHaveBeenCalled();
    expect((await layout(pageFixture([]))).get("body")!.reason).toBe("source");
    expect(
      (await layout(pageFixture(), [{ ...block(), text: "" }])).get("body")!
        .mask,
    ).toBeUndefined();
    expect((await layout(pageFixture(), [])).size).toBe(0);
  });

  it.each([0, -1, Infinity, NaN])(
    "refuses an invalid render scale %s",
    async (scale) => {
      const surface = canvas();
      expect(
        (await layout(pageFixture(), [block()], surface, scale)).get("body")!
          .reason,
      ).toBe("background");
      expect(surface.getImageData).not.toHaveBeenCalled();
    },
  );

  it("fails closed on unreadable pixels but lets extraction errors reach the caller", async () => {
    const surface = canvas();
    surface.getImageData.mockImplementation(() => {
      throw new Error("unreadable");
    });
    expect(
      (await layout(pageFixture(), [block()], surface)).get("body")!.reason,
    ).toBe("background");
    const fixture = pageFixture();
    fixture.mock.getTextContent.mockRejectedValue(
      new Error("extraction failed"),
    );
    await expect(layout(fixture)).rejects.toThrow("extraction failed");
  });
});

describe("local text styles", () => {
  it("uses a width-weighted size median, not a vote by span count", async () => {
    const scripts = Array.from({ length: 12 }, (_, i) =>
      text(140 + i * 3, 44, 2, 6, "script"),
    );
    const result = (
      await layout(
        pageFixture([text(30, 50, 108), ...scripts, text(30, 64, 145)]),
      )
    ).get("body")!;
    expect(result.mask).toBeDefined();
    expect(result.fontSize).toBe(10);
    expect(result.lineHeight).toBe(1.4);
    expect(result.fontWeight).toBe(400);
  });

  it.each(["doc_title", "author", "text"])(
    "centers %s from individual line extents",
    async (label) => {
      const result = (
        await layout(
          pageFixture([text(100, 60, 200, 20), text(140, 88, 120, 20)]),
          [block("centered", { x: 100, y: 44, width: 200, height: 48 }, label)],
        )
      ).get("centered")!;
      expect(result.mask).toBeDefined();
      expect(result.textAlign).toBe("center");
      expect(result.fontSize).toBe(20);
      expect(result.lineHeight).toBe(1.4);
    },
  );

  it.each(["doc_title", "author"])(
    "centers a tight single-line %s only with line evidence",
    async (label) => {
      const centered = block(
        "centered",
        { x: 100, y: 44, width: 200, height: 20 },
        label,
      );
      expect(
        (await layout(pageFixture([text(100, 60, 200, 20)]), [centered])).get(
          "centered",
        )!.textAlign,
      ).toBe("center");
      expect(
        (await layout(pageFixture([text(100, 60, 120, 20)]), [centered])).get(
          "centered",
        )!.textAlign,
      ).toBe("left");
    },
  );

  it("does not center a title just because its detector block is at page center", async () => {
    const result = (
      await layout(
        pageFixture([text(100, 60, 200, 20), text(100, 88, 120, 20)]),
        [
          block(
            "left-title",
            { x: 100, y: 44, width: 200, height: 48 },
            "doc_title",
          ),
        ],
      )
    ).get("left-title")!;
    expect(result.textAlign).toBe("left");
  });

  it("merges split font runs on each baseline before inferring alignment", async () => {
    const result = (
      await layout(
        pageFixture(
          [
            text(200, 60, 100, 20, "bold"),
            text(140, 88, 120, 20),
            text(100, 60, 100, 20),
          ],
          { bold: { name: "Helvetica-Bold", bold: true } },
        ),
        [
          block(
            "title",
            { x: 100, y: 44, width: 200, height: 48 },
            "doc_title",
          ),
        ],
      )
    ).get("title")!;
    expect(result.textAlign).toBe("center");
    expect(result.lineHeight).toBe(1.4);
  });

  it("infers right alignment from line ends rather than page position", async () => {
    const result = (
      await layout(pageFixture([text(30, 50, 150), text(80, 64, 100)]))
    ).get("body")!;
    expect(result.textAlign).toBe("right");
  });

  it("does not make an entire abstract bold when only its label is bold", async () => {
    const fixture = pageFixture(
      [
        text(30, 50, 35, 10, "bold", "Abstract:"),
        text(65, 50, 115),
        text(30, 64, 130),
      ],
      {
        bold: { name: "TimesNewRomanPS-BoldMT", bold: true },
        regular: { name: "TimesNewRomanPSMT", bold: false },
      },
    );
    const result = (
      await layout(fixture, [block("abstract", bodyBox, "abstract")])
    ).get("abstract")!;
    expect(result.fontWeight).toBe(400);
    expect(result.fontFamily).toBe("serif");
    expect(result.lineHeight).toBe(1.4);
    expect(fixture.mock.commonObjs.get).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ name: "ABCDEF+Helvetica-Bold", bold: true }, "sans-serif", 700],
    [{ name: "SourceHanSansSC-Heavy", black: true }, "sans-serif", 900],
    [{ name: "NotoSerifSC-SemiBold" }, "serif", 600],
    [
      { name: "CourierNewPS-ItalicMT", italic: true, bold: false },
      "monospace",
      400,
    ],
    [{ name: "SimSun", bold: false }, "serif", 400],
    [{ name: "宋体", bold: false }, "serif", 400],
    [{ name: "PingFangSC-Regular" }, "sans-serif", 400],
    [{ name: "黑体", bold: false }, "sans-serif", 400],
  ] as const)(
    "maps rendered font metadata %j to CJK-compatible generic styles",
    async (metadata, family, weight) => {
      const result = (
        await layout(pageFixture(undefined, { regular: metadata }))
      ).get("body")!;
      expect(result.fontFamily).toBe(family);
      expect(result.fontWeight).toBe(weight);
    },
  );

  it("uses TextContent family metadata if rendered font details are absent", async () => {
    const result = (
      await layout(
        pageFixture(
          undefined,
          {},
          {
            regular: {
              fontFamily: "monospace",
              ascent: 0,
              descent: 0,
              vertical: false,
            },
          },
        ),
      )
    ).get("body")!;
    expect(result.fontFamily).toBe("monospace");
    expect(result.fontWeight).toBe(400);
    expect(result.mask).toBeDefined();
  });

  it.each(["text", "abstract", "author", "doc_title", "paragraph_title"])(
    "limits unknown-font weight inference for %s",
    async (label) => {
      const fixture = pageFixture(undefined, {
        regular: { name: 123, bold: "true", black: 1, italic: "yes" },
      });
      const result = (
        await layout(fixture, [block("unknown", bodyBox, label)])
      ).get("unknown")!;
      expect(result.fontWeight).toBe(
        ["doc_title", "paragraph_title"].includes(label) ? 600 : 400,
      );
    },
  );

  it("respects a known regular title font instead of forcing bold", async () => {
    const result = (
      await layout(pageFixture(), [block("title", bodyBox, "doc_title")])
    ).get("title")!;
    expect(result.fontWeight).toBe(400);
  });

  it("does not request unresolved fonts and tolerates cleaned-up font objects", async () => {
    const fixture = pageFixture(undefined, {});
    await layout(fixture);
    expect(fixture.mock.commonObjs.get).not.toHaveBeenCalled();
    fixture.mock.commonObjs.has.mockReturnValue(true);
    fixture.mock.commonObjs.get.mockImplementation(() => {
      throw new Error("cleaned up");
    });
    const result = (await layout(fixture)).get("body")!;
    expect(result.fontWeight).toBe(400);
    expect(result.mask).toBeDefined();
  });
});
