// @vitest-environment jsdom
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import * as pdfjs from "pdfjs-dist";
import {
  defaultTheme,
  type PDFBlock,
  type TranslationBlock,
} from "@neoread/core";
import { TypesetPDFPages } from "./TypesetPDFPages";
import type { PDFLayoutHandle } from "./PDFLayoutPages";

vi.mock("@neoread/api", () => ({
  api: { pdfTypeset: vi.fn(), pdfTypesetPositions: vi.fn() },
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
  translations: new Map<string, TranslationBlock>(),
  renderBlock: (
    block: PDFBlock,
    content?: ReactNode,
    extra?: { className: string; style: React.CSSProperties },
  ) => (
    <section data-translation-block={block.id} {...extra}>
      {content ?? <span data-sentence="0">完整译文。</span>}
    </section>
  ),
  onRetry: vi.fn(),
  onCitation: vi.fn(),
  onFollow: vi.fn(),
  onReady: vi.fn(),
  ref: handle,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api.pdfTypesetPositions).mockImplementation(
    async (_doc, revision) => ({ version: 1, revision, blocks: [] }),
  );
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
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
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
  expect(api.pdfTypeset).toHaveBeenNthCalledWith(
    2,
    "doc",
    false,
    expect.any(AbortSignal),
  );
  expect(api.pdfTypeset).toHaveBeenNthCalledWith(
    3,
    "doc",
    true,
    expect.any(AbortSignal),
  );
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

const sourceBlock: PDFBlock = {
  id: "p1-b1",
  page: 1,
  label: "text",
  text: "Source.",
  bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
};
const saved: TranslationBlock = {
  blockId: sourceBlock.id,
  sourceHash: "hash",
  status: "complete",
  sentences: [{ source: "Source.", target: "译文。" }],
};
const position = {
  blockId: sourceBlock.id,
  page: 1,
  sourceHash: "hash",
  targets: ["译文。"],
  status: "mapped" as const,
  sentences: [
    {
      index: 0,
      glyphs: [..."译文。"].map((text, i) => ({
        text,
        bounds: { x: 0.1 + i * 0.02, y: 0.2, width: 0.02, height: 0.02 },
      })),
    },
  ],
};

it("keeps full saved text and retry actions available during generation and failure", async () => {
  vi.mocked(api.pdfTypeset).mockResolvedValue({
    status: "unavailable",
    revision: "a",
    reason: "runtime_missing",
  });
  const p = {
    ...props(),
    blocks: [sourceBlock],
    translations: new Map([[saved.blockId, saved]]),
  };
  await act(async () => root.render(<TypesetPDFPages {...p} />));
  expect(container.querySelector('[data-sentence="0"]')?.textContent).toBe(
    "完整译文。",
  );
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent === "重新翻译此段")!
      .click(),
  );
  expect(p.onRetry).toHaveBeenCalledWith(sourceBlock.id);
});
it("rejects stale target positions and uses the full interactive translation in the same view", async () => {
  vi.mocked(api.pdfTypeset).mockResolvedValue({
    status: "complete",
    revision: "a",
  });
  vi.mocked(api.pdfTypesetPositions).mockResolvedValue({
    version: 1,
    revision: "a",
    blocks: [position],
  });
  await act(async () =>
    root.render(
      <TypesetPDFPages
        {...props()}
        blocks={[sourceBlock]}
        translations={
          new Map([
            [
              saved.blockId,
              {
                ...saved,
                sentences: [{ source: "Source.", target: "更新。" }],
              },
            ],
          ])
        }
      />,
    ),
  );
  expect(container.querySelector(".pdf-typeset-block")).toBeNull();
  expect(
    container.querySelector(
      '[aria-label="第 1 页补充译文"] [data-translation-block]',
    ),
  ).not.toBeNull();
});
it("uses verified relocated bounds, keeps actions, and can reveal formatted content without duplicate block identities", async () => {
  vi.mocked(api.pdfTypeset).mockResolvedValue({
    status: "complete",
    revision: "a",
  });
  vi.mocked(api.pdfTypesetPositions).mockResolvedValue({
    version: 1,
    revision: "a",
    blocks: [position],
  });
  const p = {
    ...props(),
    blocks: [sourceBlock],
    translations: new Map([[saved.blockId, saved]]),
  };
  await act(async () => root.render(<TypesetPDFPages {...p} />));
  const mapped = container.querySelector<HTMLElement>(".pdf-typeset-block")!;
  expect(Number.parseFloat(mapped.style.left)).toBeCloseTo(80);
  expect(
    container.querySelectorAll(`[data-translation-block="${sourceBlock.id}"]`),
  ).toHaveLength(1);
  await act(async () =>
    Array.from(mapped.querySelectorAll("button"))
      .find((b) => b.textContent === "重译")!
      .click(),
  );
  expect(p.onRetry).toHaveBeenCalledWith(sourceBlock.id);
  await act(async () =>
    Array.from(mapped.querySelectorAll("button"))
      .find((b) => b.textContent === "完整译文")!
      .click(),
  );
  expect(
    container.querySelectorAll(`[data-translation-block="${sourceBlock.id}"]`),
  ).toHaveLength(1);
  expect(
    container.querySelector(".pdf-typeset-fallback [data-sentence]")
      ?.textContent,
  ).toBe("完整译文。");
});
it("does not activate positions returned for a different generated PDF", async () => {
  vi.mocked(api.pdfTypeset).mockResolvedValue({
    status: "complete",
    revision: "a",
  });
  vi.mocked(api.pdfTypesetPositions).mockResolvedValue({
    version: 1,
    revision: "old",
    blocks: [position],
  });
  await act(async () => root.render(<TypesetPDFPages {...props()} />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "加载失败",
  );
  expect(container.querySelector(".pdf-typeset-block")).toBeNull();
});
