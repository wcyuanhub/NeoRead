// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import * as pdfjs from "pdfjs-dist";
import { defaultTheme } from "@neoread/core";
import { TypesetPDFPages } from "./TypesetPDFPages";
import type { PDFLayoutHandle } from "./PDFLayoutPages";

vi.mock("@neoread/api", () => ({
  api: { pdfTypeset: vi.fn() },
  publicationURL: (id: string, file: string) => `/pub/cap/${id}/${file}`,
}));
vi.mock("pdfjs-dist", () => ({ getDocument: vi.fn() }));
vi.mock("../diagnostics", () => ({ reportDiagnostic: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let destroy: ReturnType<typeof vi.fn>;
let disconnect: ReturnType<typeof vi.fn>;
const handle = createRef<PDFLayoutHandle>();
const props = () => ({
  documentId: "doc",
  revisionKey: "first",
  theme: defaultTheme,
  scale: 1,
  host: { current: container },
  blocks: [],
  onFollow: vi.fn(),
  onReady: vi.fn(),
  ref: handle,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect = disconnect;
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  destroy = vi.fn(async () => {});
  vi.mocked(pdfjs.getDocument).mockReturnValue({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: () => ({ width: 600, height: 800 }),
      }),
    }),
    destroy,
  } as unknown as pdfjs.PDFDocumentLoadingTask);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("loads the completed generated PDF, never the original plus overlays", async () => {
  vi.mocked(api.pdfTypeset).mockResolvedValue({
    status: "complete",
    revision: "abc",
  });
  await act(async () => root.render(<TypesetPDFPages {...props()} />));
  expect(pdfjs.getDocument).toHaveBeenCalledWith(
    expect.objectContaining({ url: "/pub/cap/doc/typeset/abc.pdf" }),
  );
  expect(container.querySelector(".pdf-typeset-page")).not.toBeNull();
  expect(container.querySelector(".pdf-layout-expand")).toBeNull();
});

it("polls a running job and starts after translation becomes ready", async () => {
  vi.mocked(api.pdfTypeset)
    .mockResolvedValueOnce({ status: "waiting", revision: "old" })
    .mockResolvedValueOnce({ status: "idle", revision: "new" })
    .mockResolvedValue({ status: "running", revision: "new" });
  await act(async () => root.render(<TypesetPDFPages {...props()} />));
  expect(container.textContent).toContain("已完成的译文");
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(api.pdfTypeset).toHaveBeenNthCalledWith(2, "doc", false);
  expect(api.pdfTypeset).toHaveBeenNthCalledWith(3, "doc", true);
  expect(container.textContent).toContain("正在生成译文排版");
});

it("shows unavailable resources without silently showing English pages", async () => {
  vi.mocked(api.pdfTypeset).mockResolvedValue({
    status: "unavailable",
    revision: "a",
    reason: "runtime_missing",
  });
  await act(async () => root.render(<TypesetPDFPages {...props()} />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "排版组件",
  );
  expect(pdfjs.getDocument).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.pdfTypeset).toHaveBeenCalledTimes(1);
});

it("discards a late result from a previous translation snapshot", async () => {
  let resolve!: (value: { status: "complete"; revision: string }) => void;
  vi.mocked(api.pdfTypeset)
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    )
    .mockResolvedValue({ status: "waiting", revision: "b" });
  await act(async () => root.render(<TypesetPDFPages {...props()} />));
  await act(async () =>
    root.render(<TypesetPDFPages {...props()} revisionKey="second" />),
  );
  await act(async () => resolve({ status: "complete", revision: "stale" }));
  expect(pdfjs.getDocument).not.toHaveBeenCalled();
});

it("releases the PDF and observers when a generated document changes", async () => {
  vi.mocked(api.pdfTypeset).mockResolvedValue({
    status: "complete",
    revision: "first",
  });
  await act(async () => root.render(<TypesetPDFPages {...props()} />));
  vi.mocked(api.pdfTypeset).mockResolvedValue({
    status: "waiting",
    revision: "second",
  });
  await act(async () =>
    root.render(<TypesetPDFPages {...props()} revisionKey="second" />),
  );
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalled();
});
