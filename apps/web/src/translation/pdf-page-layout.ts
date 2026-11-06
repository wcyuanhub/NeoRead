import type { PDFBlock } from "@neoread/core";
import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import { pdfFontAscent } from "../../../../packages/neoread-core/src/pdf-text";
import { preservedLabels } from "./pdf-content";
import { overlaps, validRect, type Rect } from "./pdf-layout";

export type PageBlockLayout = {
  /** Scale-1 PDF.js display points, with a top-left origin (not canvas pixels). */
  box: Rect;
  /** Absent unless covering the source text is safe. */
  mask?: Rect;
  fontSize: number;
  /** Unitless baseline distance / font size, not pixels. */
  lineHeight: number;
  fontFamily: "serif" | "sans-serif" | "monospace";
  fontWeight: number;
  textAlign: "left" | "center" | "right";
  reason?: "source" | "bounds" | "overlap" | "background" | "preserved";
};

type TextSpan = {
  box: Rect;
  text: string;
  size: number;
  horizontal: boolean;
  baseline: number;
  fontName: string;
  fontFamily: string;
};

export function pageBox(block: PDFBlock, width: number, height: number): Rect {
  const b = block.bounds;
  return {
    x: b.x * width,
    y: b.y * height,
    width: b.width * width,
    height: b.height * height,
  };
}

export function contains(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/** Only neutral white paper is covered. Keep tinted backgrounds/figures unchanged. */
export function isWhitePaper(
  context: CanvasRenderingContext2D,
  box: Rect,
  scale: number,
  textBoxes?: Rect[],
): boolean {
  const x = Math.max(0, Math.floor(box.x * scale));
  const y = Math.max(0, Math.floor(box.y * scale));
  const width = Math.max(1, Math.ceil((box.x + box.width) * scale) - x);
  const height = Math.max(1, Math.ceil((box.y + box.height) * scale) - y);
  const { data } = context.getImageData(x, y, width, height);
  let white = 0,
    colored = 0;
  for (let i = 0; i < data.length; i += 4) {
    const low = Math.min(data[i], data[i + 1], data[i + 2]);
    const high = Math.max(data[i], data[i + 1], data[i + 2]);
    if (low >= 248) white++;
    else if (textBoxes) {
      const px = (x + ((i / 4) % width) + 0.5) / scale;
      const py = (y + Math.floor(i / 4 / width) + 0.5) / scale;
      if (
        !textBoxes.some(
          (text) =>
            px >= text.x &&
            px <= text.x + text.width &&
            py >= text.y &&
            py <= text.y + text.height,
        )
      )
        return false;
    }
    if (high - low > 16) colored++;
  }
  const pixels = data.length / 4;
  return white / pixels > 0.65 && colored / pixels < 0.005;
}

export async function textSpans(page: PDFPageProxy): Promise<TextSpan[]> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  return content.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const [a, b, c, d, e, f] = item.transform;
    const origin = viewport.convertToViewportPoint(e, f);
    const advance = Math.hypot(a, b);
    if (!advance) return [];
    const end = viewport.convertToViewportPoint(
      e + (item.width * a) / advance,
      f + (item.width * b) / advance,
    );
    const top = viewport.convertToViewportPoint(e + c, f + d);
    const up = [top[0] - origin[0], top[1] - origin[1]];
    const fontSize = Math.hypot(...up);
    const ascent = pdfFontAscent(content.styles[item.fontName]);
    // Four corners prevent vertical margin text from inventing a page-wide box.
    const corners = [origin, end].flatMap((point) =>
      [ascent, ascent - 1].map((factor) => [
        point[0] + up[0] * factor,
        point[1] + up[1] * factor,
      ]),
    );
    const xs = corners.map((p) => p[0]),
      ys = corners.map((p) => p[1]);
    return [
      {
        box: {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        },
        text: item.str,
        size: fontSize,
        horizontal:
          end[0] > origin[0] &&
          Math.abs(end[1] - origin[1]) < 0.01 &&
          up[1] < 0 &&
          Math.abs(up[0]) < 0.01,
        baseline: origin[1],
        fontName: item.fontName,
        fontFamily: content.styles[item.fontName]?.fontFamily ?? "",
      },
    ];
  });
}

type BlockGeometry =
  | { localSpans: TextSpan[]; mask: Rect; reason?: never }
  | {
      localSpans: TextSpan[];
      mask?: never;
      reason: "bounds" | "source" | "overlap";
    };

/** Shared with the exporter: keep its geometry and erasure tolerances identical. */
export function blockGeometry(
  boxes: Rect[],
  index: number,
  spans: TextSpan[],
  width: number,
  height: number,
): BlockGeometry {
  const box = boxes[index];
  if (!validRect(box) || !contains({ x: 0, y: 0, width, height }, box))
    return { localSpans: [], reason: "bounds" };
  const localSpans = spans.filter((s) => overlaps(s.box, box));
  // Layout detection and font metrics can disagree slightly. Grow the erasure
  // to measured glyphs, but reject large mismatches and neighboring content.
  if (
    !localSpans.length ||
    localSpans.some(
      (s) => !s.horizontal || !contains(box, s.box, Math.min(4, s.size * 0.35)),
    )
  )
    return { localSpans, reason: "source" };
  const left = Math.max(
    0,
    Math.min(box.x, ...localSpans.map((s) => s.box.x)) - 0.75,
  );
  const top = Math.max(
    0,
    Math.min(box.y, ...localSpans.map((s) => s.box.y)) - 0.75,
  );
  const maskRight = Math.min(
    width,
    Math.max(
      box.x + box.width,
      ...localSpans.map((s) => s.box.x + s.box.width),
    ) + 0.75,
  );
  const bottom = Math.min(
    height,
    Math.max(
      box.y + box.height,
      ...localSpans.map((s) => s.box.y + s.box.height),
    ) + 0.75,
  );
  const mask = {
    x: left,
    y: top,
    width: maskRight - left,
    height: bottom - top,
  };
  if (
    boxes.some((other, j) => j !== index && overlaps(mask, other)) ||
    spans.some((s) => !localSpans.includes(s) && overlaps(mask, s.box))
  )
    return { localSpans, reason: "overlap" };
  return { localSpans, mask };
}

function weightedMedian(values: { value: number; weight: number }[]): number {
  const ordered = [...values].sort((a, b) => a.value - b.value);
  let remaining = ordered.reduce((sum, v) => sum + v.weight, 0) / 2;
  return ordered.find((v) => (remaining -= v.weight) <= 0)!.value;
}

/** Short superscripts must not outweigh the main paragraph text. */
export function preferredFontSize(spans: TextSpan[]): number {
  return weightedMedian(
    spans.map((s) => ({ value: s.size, weight: s.box.width })),
  );
}

type FontMetadata = {
  name?: string;
  bold?: boolean;
  black?: boolean;
  italic?: boolean;
};

function fontMetadata(page: PDFPageProxy, name: string): FontMetadata {
  // commonObjs is populated by rendering. Never wait for an unresolved font,
  // request extra PDF.js work, or trust its untyped runtime object shape.
  try {
    if (!page.commonObjs?.has(name)) return {};
    const font: unknown = page.commonObjs.get(name);
    if (!font || typeof font !== "object") return {};
    return {
      name:
        "name" in font && typeof font.name === "string" ? font.name : undefined,
      bold:
        "bold" in font && typeof font.bold === "boolean"
          ? font.bold
          : undefined,
      black:
        "black" in font && typeof font.black === "boolean"
          ? font.black
          : undefined,
      italic:
        "italic" in font && typeof font.italic === "boolean"
          ? font.italic
          : undefined,
    };
  } catch {
    // A page may have been cleaned up since the rendered canvas was obtained.
    return {};
  }
}

function fontFamily(name: string): PageBlockLayout["fontFamily"] | undefined {
  if (/mono|courier|consolas|menlo|typewriter|cmtt|等距/i.test(name))
    return "monospace";
  if (
    /sans|arial|helvetica|calibri|verdana|gothic|heiti|simhei|yahei|pingfang|dengxian|黑体|黑體|苹方|蘋方|等线/i.test(
      name,
    )
  )
    return "sans-serif";
  if (
    /serif|times|georgia|roman|cambria|palatino|simsun|song|ming|kaiti|kai|cmr|cmmi|cmbx|宋|明朝|楷/i.test(
      name,
    )
  )
    return "serif";
  return undefined;
}

function fontWeight(font: FontMetadata, family: string): number | undefined {
  const name = font.name || family;
  if (font.black === true || /black|heavy/i.test(name)) return 900;
  if (/semibold|demibold/i.test(name)) return 600;
  if (font.bold === true || /bold|cmbx/i.test(name)) return 700;
  if (
    font.bold === false ||
    font.italic === true ||
    /regular|normal|roman|book|medium|italic|oblique/i.test(name)
  )
    return 400;
  return undefined;
}

type TextLine = { left: number; right: number; baseline: number };

function textLines(spans: TextSpan[], size: number): TextLine[] {
  // Group main-size runs by baseline, not PDF.js item order or glyph tops.
  // Ignore small scripts for line metrics so citations do not invent extra lines.
  const main = spans
    .filter((s) => s.size >= size * 0.8 && s.size <= size * 1.25)
    .sort((a, b) => a.baseline - b.baseline || a.box.x - b.box.x);
  const lines: TextLine[] = [];
  for (const span of main) {
    const last = lines.at(-1);
    if (last && Math.abs(last.baseline - span.baseline) <= size * 0.25) {
      last.left = Math.min(last.left, span.box.x);
      last.right = Math.max(last.right, span.box.x + span.box.width);
    } else {
      lines.push({
        left: span.box.x,
        right: span.box.x + span.box.width,
        baseline: span.baseline,
      });
    }
  }
  return lines;
}

function lineHeight(lines: TextLine[], size: number): number {
  const distances = lines
    .slice(1)
    .map((line, i) => line.baseline - lines[i].baseline);
  const regular = distances.filter((d) => d >= size * 0.9 && d <= size * 2.5);
  return regular.length
    ? Math.max(
        1,
        weightedMedian(regular.map((value) => ({ value, weight: 1 }))) / size,
      )
    : 1.25;
}

function textAlign(
  lines: TextLine[],
  box: Rect,
  size: number,
  label: string,
  pageWidth: number,
): PageBlockLayout["textAlign"] {
  if (!lines.length) return "left";
  const tolerance = Math.max(1, size * 0.2);
  const center = box.x + box.width / 2;
  const centered = lines.every(
    (line) => Math.abs((line.left + line.right) / 2 - center) <= tolerance,
  );
  const inset = lines.some(
    (line) =>
      line.left - box.x > tolerance &&
      box.x + box.width - line.right > tolerance,
  );
  // A tight single-line heading/author is ambiguous. Only use its role as a
  // tie-breaker at the page center, and still require actual line-center evidence.
  const centeredRole =
    ["doc_title", "paragraph_title", "author", "authors"].includes(label) &&
    Math.abs(center - pageWidth / 2) <= tolerance;
  if (centered && (inset || centeredRole)) return "center";
  if (
    lines.every(
      (line) => Math.abs(line.right - box.x - box.width) <= tolerance,
    ) &&
    lines.some((line) => line.left - box.x > tolerance * 2)
  )
    return "right";
  return "left";
}

/**
 * Inspect an already rendered, original-color PDF.js page without changing it.
 * No translation fitting is done here: the caller must expand overflow in full.
 * Rejection reasons are stable classifications for the caller's fallback/diagnostics.
 */
export async function pageBlockLayouts(
  page: PDFPageProxy,
  blocks: PDFBlock[],
  context: CanvasRenderingContext2D,
  renderScale: number,
): Promise<Map<string, PageBlockLayout>> {
  const { width, height } = page.getViewport({ scale: 1 });
  const spans = await textSpans(page);
  const boxes = blocks.map((block) => pageBox(block, width, height));
  const fonts = new Map<string, FontMetadata>();
  const result = new Map<string, PageBlockLayout>();
  for (const [index, block] of blocks.entries()) {
    const box = boxes[index];
    const layout: PageBlockLayout = {
      box,
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: "serif",
      fontWeight: 400,
      textAlign: "left",
    };
    result.set(block.id, layout);
    if (block.image || preservedLabels.has(block.label)) {
      layout.reason = "preserved";
      continue;
    }
    if (!block.text.trim()) {
      layout.reason = "source";
      continue;
    }
    const geometry = blockGeometry(boxes, index, spans, width, height);
    if (!geometry.mask) {
      layout.reason = geometry.reason;
      continue;
    }
    const local = geometry.localSpans;
    layout.fontSize = preferredFontSize(local);
    const families = new Map<PageBlockLayout["fontFamily"], number>();
    let boldWidth = 0;
    const weights: { value: number; weight: number }[] = [];
    const heading =
      block.label === "doc_title" || block.label === "paragraph_title";
    for (const span of local) {
      let metadata = fonts.get(span.fontName);
      if (!metadata) {
        metadata = fontMetadata(page, span.fontName);
        fonts.set(span.fontName, metadata);
      }
      const family =
        fontFamily(metadata.name ?? "") ??
        fontFamily(span.fontFamily) ??
        "serif";
      families.set(family, (families.get(family) ?? 0) + span.box.width);
      const weight =
        fontWeight(metadata, span.fontFamily) ?? (heading ? 600 : 400);
      weights.push({ value: weight, weight: span.box.width });
      if (weight >= 600) boldWidth += span.box.width;
    }
    layout.fontFamily = [...families].sort((a, b) => b[1] - a[1])[0][0];
    // Do not promote a whole abstract because its introductory label is bold.
    const totalWidth = local.reduce((sum, span) => sum + span.box.width, 0);
    layout.fontWeight =
      boldWidth / totalWidth >= 0.65 ? weightedMedian(weights) : 400;
    const lines = textLines(local, layout.fontSize);
    layout.lineHeight = lineHeight(lines, layout.fontSize);
    layout.textAlign = textAlign(
      lines,
      box,
      layout.fontSize,
      block.label,
      width,
    );
    let white = false;
    if (Number.isFinite(renderScale) && renderScale > 0) {
      try {
        // Ink outside measured text may be an unsegmented monochrome figure.
        white = isWhitePaper(
          context,
          geometry.mask,
          renderScale,
          local.map(({ box }) => ({
            x: box.x - 1,
            y: box.y - 1,
            width: box.width + 2,
            height: box.height + 2,
          })),
        );
      } catch {
        // Unreadable canvas pixels cannot establish a safe background.
      }
    }
    if (white) layout.mask = geometry.mask;
    else layout.reason = "background";
  }
  return result;
}
