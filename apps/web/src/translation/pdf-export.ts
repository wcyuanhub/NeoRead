import {
  exportFailure,
  PDFExportError,
  type PDFExportFailure,
} from "./pdf-export-error";
import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFPage,
} from "pdf-lib";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
import type {
  DocumentInitParameters,
  PDFDocumentLoadingTask,
  PDFPageProxy,
} from "pdfjs-dist/types/src/display/api";
import { fitText, overlaps, type Rect } from "./pdf-layout";
import {
  blockGeometry,
  isWhitePaper,
  pageBox,
  preferredFontSize,
  textSpans,
} from "./pdf-page-layout";
import { splitLegacyCaptions } from "./pdf-captions";
import { matchesSource, preservedLabels } from "./pdf-content";
import { preparePDFText } from "./pdf-math";
import { embedExportFonts, type FontBytes } from "./pdf-fonts";

import type {
  ExportIssue,
  PDFExportProgress,
  TranslatedPDF,
} from "./pdf-export-model";
export type ExportCanvas = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  dispose(): void;
};
export type ExportOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: PDFExportProgress) => void;
  createCanvas?: (width: number, height: number) => ExportCanvas;
};

function browserCanvas(width: number, height: number): ExportCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建 PDF 导出画布");
  return {
    canvas,
    context,
    dispose: () => {
      canvas.width = canvas.height = 0;
    },
  };
}

/** Original link hotspots no longer identify the same words after reflow. */
function removeCoveredLinks(page: PDFPage, source: PDFPageProxy, mask: Rect) {
  const annotations = page.node.Annots();
  if (!annotations) return;
  const viewport = source.getViewport({ scale: 1 });
  for (let index = annotations.size() - 1; index >= 0; index--) {
    const annotation = page.doc.context.lookup(annotations.get(index));
    if (
      !(annotation instanceof PDFDict) ||
      annotation.get(PDFName.of("Subtype"))?.toString() !== "/Link"
    )
      continue;
    const rect = annotation.lookup(PDFName.of("Rect"));
    if (!(rect instanceof PDFArray) || rect.size() !== 4) continue;
    const values = rect
      .asArray()
      .map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN));
    if (!values.every(Number.isFinite)) continue;
    const a = viewport.convertToViewportPoint(values[0], values[1]);
    const b = viewport.convertToViewportPoint(values[2], values[3]);
    if (
      overlaps(mask, {
        x: Math.min(a[0], b[0]),
        y: Math.min(a[1], b[1]),
        width: Math.abs(a[0] - b[0]),
        height: Math.abs(a[1] - b[1]),
      })
    )
      annotations.remove(index);
  }
}

/**
 * Write an independent copy. Original vectors, page boxes and navigation survive.
 * Covering is visual replacement, not redaction: original text remains in PDF data.
 * A block is committed only after source, geometry, glyph and fit checks all pass.
 */
export async function translatedPDF(
  getDocument: (parameters: DocumentInitParameters) => PDFDocumentLoadingTask,
  source: DocumentInitParameters,
  blocks: PDFBlock[],
  translations: TranslationBlock[],
  fontBytes: FontBytes,
  { signal, onProgress, createCanvas = browserCanvas }: ExportOptions = {},
): Promise<TranslatedPDF> {
  signal?.throwIfAborted();
  onProgress?.({ phase: "preparing", done: 0, total: 0 });
  let task: PDFDocumentLoadingTask;
  try {
    task = getDocument(source);
  } catch (error) {
    throw exportFailure(error, "pdf_decode");
  }
  let failureReason: PDFExportFailure = "pdf_decode";
  let failed = false;
  // Destroy also interrupts network loading and a pending PDF.js render.
  const abort = () => {
    void task.destroy().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const input = await task.promise;
    signal?.throwIfAborted();
    const output = await PDFDocument.load(await input.getData());
    failureReason = "font_embed";
    const fonts = await embedExportFonts(output, fontBytes);
    failureReason = "layout";
    const byId = new Map(translations.map((t) => [t.blockId, t]));
    const byPage = new Map<number, PDFBlock[]>();
    const issues: ExportIssue[] = [];
    for (const block of blocks) {
      if (
        !Number.isInteger(block.page) ||
        block.page < 1 ||
        block.page > input.numPages
      ) {
        issues.push({ page: block.page, blockId: block.id, reason: "bounds" });
        continue;
      }
      const pageBlocks = byPage.get(block.page) ?? [];
      pageBlocks.push(block);
      byPage.set(block.page, pageBlocks);
    }
    let translated = 0;
    for (let number = 1; number <= input.numPages; number++) {
      signal?.throwIfAborted();
      onProgress?.({ phase: "pages", done: number - 1, total: input.numPages });
      let pageBlocks = byPage.get(number) ?? [];
      if (!pageBlocks.length) {
        issues.push({ page: number, reason: "unparsed" });
        continue;
      }
      const page = await input.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const { width, height } = viewport;
      if (
        ![width, height].every(
          (n) => Number.isFinite(n) && n > 0 && n <= 20_000,
        )
      )
        throw new PDFExportError(
          "page_dimensions",
          new Error("PDF 页面尺寸超出导出范围"),
        );
      const spans = await textSpans(page);
      const recovered = splitLegacyCaptions(pageBlocks, spans, width, height);
      pageBlocks = recovered.blocks;
      issues.push(
        ...recovered.unresolved.map((blockId) => ({
          page: number,
          blockId,
          reason: "source" as const,
        })),
      );
      const boxes = pageBlocks.map((b) => pageBox(b, width, height));
      const pdfPage = output.getPage(number - 1);
      let surface: ExportCanvas | undefined;
      const scale = Math.min(1.5, Math.sqrt(4_000_000 / (width * height)));
      try {
        for (let index = 0; index < pageBlocks.length; index++) {
          signal?.throwIfAborted();
          const block = pageBlocks[index];
          if (
            block.image ||
            preservedLabels.has(block.label) ||
            !block.text.trim()
          )
            continue;
          const issue = (reason: ExportIssue["reason"]) =>
            issues.push({ page: number, blockId: block.id, reason });
          const translation = byId.get(block.id);
          if (
            !translation ||
            translation.status !== "complete" ||
            !translation.sentences.length
          ) {
            issue("untranslated");
            continue;
          }
          if (!(await matchesSource(block, translation))) {
            issue("stale");
            continue;
          }
          const content = preparePDFText(
            translation.sentences.map((s) => s.target.trim()).join(" "),
            fonts,
          );
          if (!content) {
            issue("structure");
            continue;
          }
          const box = boxes[index];
          const geometry = blockGeometry(boxes, index, spans, width, height);
          if (!geometry.mask) {
            issue(geometry.reason);
            continue;
          }
          const { mask, localSpans } = geometry;
          if (!content.supported) {
            issue("font");
            continue;
          }
          const preferredSize = preferredFontSize(localSpans);
          const layout = fitText(
            content.text,
            box,
            preferredSize,
            content.measure,
            content.ascent + content.descent,
          );
          if (!layout) {
            issue("overflow");
            continue;
          }
          if (!surface) {
            surface = createCanvas(
              Math.ceil(width * scale),
              Math.ceil(height * scale),
            );
            await page.render({
              canvas: surface.canvas,
              canvasContext: surface.context,
              viewport: page.getViewport({ scale }),
              background: "#ffffff",
            }).promise;
          }
          if (!isWhitePaper(surface.context, mask, scale)) {
            issue("background");
            continue;
          }
          signal?.throwIfAborted();
          // Transform displayed bottom-left coordinates back to PDF user space.
          // This handles /Rotate, crop-box offsets and /UserUnit without special cases.
          const origin = viewport.convertToPdfPoint(0, height);
          const right = viewport.convertToPdfPoint(1, height);
          const up = viewport.convertToPdfPoint(0, height - 1);
          pdfPage.pushOperators(
            pushGraphicsState(),
            concatTransformationMatrix(
              right[0] - origin[0],
              right[1] - origin[1],
              up[0] - origin[0],
              up[1] - origin[1],
              origin[0],
              origin[1],
            ),
          );
          pdfPage.drawRectangle({
            x: mask.x,
            y: height - mask.y - mask.height,
            width: mask.width,
            height: mask.height,
            color: rgb(1, 1, 1),
          });
          layout.lines.forEach((line, lineIndex) => {
            const centered =
              (block.label === "doc_title" ||
                block.label === "paragraph_title") &&
              Math.abs(box.x + box.width / 2 - width / 2) < width * 0.05;
            const x =
              box.x +
              (centered
                ? (box.width - content.measure(line, layout.size)) / 2
                : 0);
            content.draw(
              pdfPage,
              line,
              x,
              height -
                box.y -
                layout.size * content.ascent -
                lineIndex * layout.lineHeight,
              layout.size,
            );
          });
          pdfPage.pushOperators(popGraphicsState());
          removeCoveredLinks(pdfPage, page, mask);
          translated++;
        }
      } finally {
        surface?.dispose();
        page.cleanup();
      }
      // Allow cancellation and progress to paint between pages.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    signal?.throwIfAborted();
    if (!translated)
      throw new PDFExportError(
        "no_translated_blocks",
        new Error(
          "当前没有能安全排入原版面的译文，请完成翻译后重试，或导出 Markdown。",
        ),
      );
    onProgress?.({
      phase: "saving",
      done: input.numPages,
      total: input.numPages,
    });
    failureReason = "save";
    output.setProducer("NeoRead");
    const bytes = await output.save({ objectsPerTick: 30 });
    signal?.throwIfAborted();
    return { bytes, translated, pages: input.numPages, issues };
  } catch (error) {
    failed = true;
    throw exportFailure(error, failureReason);
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      await task.destroy();
    } catch (error) {
      // A cleanup failure must not hide the original operation's failure.
      if (!failed && !signal?.aborted) throw exportFailure(error, "cleanup");
    }
  }
}
