import {
  exportOperation,
  exportFailure,
  exportFailureDetail,
  PDFExportError,
} from "./translation/pdf-export-error";
import type { Annotation, Document, Message } from "@neoread/core";
import { api, publicationURL } from "@neoread/api";
import { downloadBlob, fileTitle } from "./download";
import { reportDiagnostic } from "./diagnostics";
import type {
  PDFExportProgress,
  TranslatedPDF,
} from "./translation/pdf-export-model";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type AnnotationOptions = {
  annotations: Annotation[];
  messages: Message[];
  kinds: Annotation["kind"][];
};

export async function exportTranslatedPDF(
  doc: Document,
  signal: AbortSignal,
  onProgress: (progress: PDFExportProgress) => void,
  options?: AnnotationOptions,
): Promise<Omit<TranslatedPDF, "bytes">> {
  const started = performance.now();
  const requestId = crypto.randomUUID();
  let phase = "snapshot";
  const event = (result: string, detail = "") =>
    reportDiagnostic({
      level: result === "failed" ? "error" : "info",
      event: `pdf.translation_export.${result}`,
      requestId,
      durationMs: Math.round(performance.now() - started),
      detail: `phase=${phase}${detail ? ` ${detail}` : ""}`,
    });
  event("start");
  onProgress({ phase: "preparing", done: 0, total: 0 });
  try {
    if (doc.type !== "pdf")
      throw new PDFExportError(
        "unsupported_document",
        new Error("译文 PDF 导出仅适用于 PDF 文档"),
      );
    signal.throwIfAborted();
    phase = "layout";
    event("stage");
    let status = await exportOperation("snapshot", () =>
      api.pdfTypeset(doc.id, true, signal),
    );
    const deadline = performance.now() + 31 * 60_000;
    while (status.status === "running" || status.status === "idle") {
      signal.throwIfAborted();
      if (performance.now() >= deadline)
        throw new PDFExportError("layout", new Error("排版超时，请稍后重试。"));
      await pause(signal);
      status = await exportOperation("snapshot", () =>
        api.pdfTypeset(doc.id, status.status === "idle", signal),
      );
    }
    if (status.status !== "complete") {
      const message =
        status.status === "waiting"
          ? "请等待翻译完成后再导出。"
          : status.status === "unavailable"
            ? "PDF 排版组件未就绪，请先准备组件或安装包含该组件的版本。"
            : "译文排版未完成，请在保留排版视图中重试。";
      throw new PDFExportError("layout", new Error(message));
    }
    phase = "saving";
    onProgress({ phase: "saving", done: 0, total: 0 });
    let blob = await exportOperation("save", async () => {
      const response = await fetch(
        publicationURL(doc.id, `typeset/${status.revision}.pdf`),
        { signal },
      );
      if (!response.ok)
        throw new Error("译文 PDF 读取失败，请重新生成排版后重试。");
      const value = await response.blob();
      if ((await value.slice(0, 5).text()) !== "%PDF-")
        throw new Error("译文 PDF 文件无效，请重试。");
      return value;
    });
    const result: Omit<TranslatedPDF, "bytes"> = {
      pages: status.pages ?? 0,
      translated: status.translated ?? 0,
      preserved: status.preserved ?? 0,
      issues: [],
    };
    if (status.unwrittenSentences !== undefined)
      result.unwrittenSentences = status.unwrittenSentences;
    const marks =
      options?.annotations.filter(
        (a) =>
          a.location.translation &&
          a.kind !== "bookmark" &&
          options.kinds.includes(a.kind),
      ) ?? [];
    if (marks.length) {
      const revision = status.revision!;
      const [positions, blocks, translations] = await exportOperation(
        "snapshot",
        () =>
          Promise.all([
            api.pdfTypesetPositions(doc.id, revision, signal),
            api.blocks(doc.id, signal),
            api.translations(doc.id, signal),
          ]),
      );
      signal.throwIfAborted();
      if (positions.version !== 1 || positions.revision !== revision)
        throw new PDFExportError(
          "snapshot",
          new Error("译文位置已变化，请重新导出。"),
        );
      const { typesetAnnotationRects } =
        await import("./translation/typeset-annotation-rects");
      const { annotatedPDF } = await import("./readers/pdf-export");
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc ||= workerURL;
      const source = {
        data: new Uint8Array(await blob.arrayBuffer()),
        cMapUrl: "/pdf-assets/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdf-assets/standard_fonts/",
        wasmUrl: "/pdf-assets/wasm/",
      };
      const annotated = await exportOperation("save", () =>
        annotatedPDF(pdfjs.getDocument, source, marks, {
          translatedRects: typesetAnnotationRects(
            positions,
            blocks,
            translations,
            marks,
          ),
          answers: Object.fromEntries(
            (options?.messages ?? []).map((m) => [m.id, m.content]),
          ),
        }),
      );
      signal.throwIfAborted();
      blob = new Blob([annotated.bytes as Uint8Array<ArrayBuffer>], {
        type: "application/pdf",
      });
      result.annotationsExported = annotated.exported;
      result.annotationsSkipped = annotated.skipped;
    }
    signal.throwIfAborted();
    phase = "download";
    downloadBlob(blob, `${fileTitle(doc.title)}-译文.pdf`);
    // Browser download initiation is observable; disk completion is not.
    event(
      "download_requested",
      `pages=${result.pages} translated=${result.translated} preserved=${result.preserved}`,
    );
    return result;
  } catch (error) {
    event(
      signal.aborted ? "cancelled" : "failed",
      signal.aborted
        ? "reasonCode=user_cancelled"
        : exportFailureDetail(
            exportFailure(
              error,
              phase === "download"
                ? "download"
                : phase === "layout"
                  ? "layout"
                  : phase === "saving"
                    ? "save"
                    : "unrecognized",
            ),
          ),
    );
    if (signal.aborted) throw new DOMException("已取消导出", "AbortError");
    throw error;
  }
}

/** Abort releases the timer/listener; the shared server cache job can finish. */
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(new DOMException("已取消导出", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 1000);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
