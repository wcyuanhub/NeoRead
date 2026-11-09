import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Annotation, Document } from "@neoread/core";
const mocks = vi.hoisted(() => ({
  typeset: vi.fn(),
  log: vi.fn(),
  download: vi.fn(),
  positions: vi.fn(),
  blocks: vi.fn(),
  translations: vi.fn(),
  rects: vi.fn(),
  annotated: vi.fn(),
}));
vi.mock("@neoread/api", () => ({
  api: {
    pdfTypeset: mocks.typeset,
    pdfTypesetPositions: mocks.positions,
    blocks: mocks.blocks,
    translations: mocks.translations,
  },
  publicationURL: (id: string, path: string) => `/pub/${id}/${path}`,
}));
vi.mock("./translation/typeset-annotation-rects", () => ({
  typesetAnnotationRects: mocks.rects,
}));
vi.mock("./readers/pdf-export", () => ({ annotatedPDF: mocks.annotated }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}));
vi.mock("./diagnostics", () => ({ reportDiagnostic: mocks.log }));
vi.mock("./download", () => ({
  downloadBlob: mocks.download,
  fileTitle: () => "document",
}));
import { exportTranslatedPDF } from "./translated-pdf-export";
const doc = {
  id: "private-document",
  type: "pdf",
  title: "PRIVATE TITLE",
} as Document;
const complete = {
  status: "complete",
  revision: "revision",
  translated: 12,
  preserved: 3,
  pages: 9,
};
const secret =
  "PRIVATE BODY token=secret https://private.example /Users/private/file.pdf";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.typeset.mockResolvedValue(complete);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["%PDF-1.7\n"]),
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("downloads the same generated PDF used by the reader", async () => {
  const controller = new AbortController();
  const result = await exportTranslatedPDF(doc, controller.signal, vi.fn());
  expect(mocks.typeset).toHaveBeenCalledWith(doc.id, true, controller.signal);
  expect(fetch).toHaveBeenCalledWith(
    "/pub/private-document/typeset/revision.pdf",
    { signal: controller.signal },
  );
  expect(result).toEqual({
    translated: 12,
    preserved: 3,
    pages: 9,
    issues: [],
  });
  expect(mocks.download).toHaveBeenCalledWith(
    expect.any(Blob),
    "document-译文.pdf",
  );
  expect(mocks.log).toHaveBeenLastCalledWith(
    expect.objectContaining({
      event: "pdf.translation_export.download_requested",
    }),
  );
});
it("waits for the shared generation job and polls without restarting it", async () => {
  vi.useFakeTimers();
  mocks.typeset
    .mockResolvedValueOnce({ status: "running" })
    .mockResolvedValueOnce(complete);
  const task = exportTranslatedPDF(doc, new AbortController().signal, vi.fn());
  await vi.advanceTimersByTimeAsync(1000);
  await task;
  expect(mocks.typeset.mock.calls.map((c) => c[1])).toEqual([true, false]);
});
it.each(["waiting", "unavailable", "failed"])(
  "does not silently use old overlay output when %s",
  async (status) => {
    mocks.typeset.mockResolvedValue({ status });
    await expect(
      exportTranslatedPDF(doc, new AbortController().signal, vi.fn()),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  },
);
it.each(["snapshot", "save", "download"])(
  "logs controlled %s failure without exception contents",
  async (reason) => {
    const raw = new Error(secret);
    if (reason === "snapshot") mocks.typeset.mockRejectedValue(raw);
    if (reason === "save") vi.mocked(fetch).mockRejectedValue(raw);
    if (reason === "download")
      mocks.download.mockImplementation(() => {
        throw raw;
      });
    await expect(
      exportTranslatedPDF(doc, new AbortController().signal, vi.fn()),
    ).rejects.toThrow(secret);
    const failures = mocks.log.mock.calls.filter(([e]) =>
      e.event.endsWith("failed"),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0][0].detail).toContain(`reasonCode=${reason}`);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toMatch(
      /PRIVATE|secret|private-document|private.example|Users/,
    );
  },
);
it("rejects invalid PDF bytes before downloading", async () => {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["<html>not pdf"]),
  } as Response);
  await expect(
    exportTranslatedPDF(doc, new AbortController().signal, vi.fn()),
  ).rejects.toThrow("文件无效");
  expect(mocks.download).not.toHaveBeenCalled();
});
it("cancels polling without a download or failure diagnostic", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  mocks.typeset.mockResolvedValue({ status: "running" });
  const task = exportTranslatedPDF(doc, controller.signal, vi.fn());
  const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.log).toHaveBeenLastCalledWith(
    expect.objectContaining({
      level: "info",
      event: "pdf.translation_export.cancelled",
    }),
  );
});

it("includes selected translated marks and reports unplaceable marks without using source annotations", async () => {
  const marks = [
    {
      id: "t",
      kind: "note",
      location: { type: "pdf", page: 1, translation: { blockId: "b" } },
    },
    { id: "s", kind: "note", location: { type: "pdf", page: 1, rects: [] } },
    {
      id: "h",
      kind: "highlight",
      location: { type: "pdf", page: 1, translation: { blockId: "b" } },
    },
  ] as Annotation[];
  const placements = new Map();
  mocks.positions.mockResolvedValue({
    version: 1,
    revision: "revision",
    blocks: [],
  });
  mocks.blocks.mockResolvedValue([]);
  mocks.translations.mockResolvedValue([]);
  mocks.rects.mockReturnValue(placements);
  mocks.annotated.mockResolvedValue({
    bytes: new TextEncoder().encode("%PDF-marked"),
    exported: 0,
    skipped: 1,
  });
  const signal = new AbortController().signal;
  const result = await exportTranslatedPDF(doc, signal, vi.fn(), {
    annotations: marks,
    messages: [],
    kinds: ["note"],
  });
  expect(mocks.positions).toHaveBeenCalledWith(doc.id, "revision", signal);
  expect(mocks.annotated).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ data: expect.any(Uint8Array) }),
    [marks[0]],
    { answers: {}, translatedRects: placements },
  );
  expect(result).toMatchObject({
    annotationsExported: 0,
    annotationsSkipped: 1,
  });
  expect(mocks.download).toHaveBeenCalledTimes(1);
});

it("rejects a mismatched positions revision before writing annotations", async () => {
  mocks.positions.mockResolvedValue({
    version: 1,
    revision: "stale",
    blocks: [],
  });
  mocks.blocks.mockResolvedValue([]);
  mocks.translations.mockResolvedValue([]);
  await expect(
    exportTranslatedPDF(doc, new AbortController().signal, vi.fn(), {
      annotations: [
        {
          id: "t",
          kind: "note",
          location: { type: "pdf", page: 1, translation: { blockId: "b" } },
        } as Annotation,
      ],
      messages: [],
      kinds: ["note"],
    }),
  ).rejects.toThrow("位置已变化");
  expect(mocks.annotated).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});
