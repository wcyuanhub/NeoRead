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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
  expect(container.textContent).toContain("当前显示原文");
  expect(pdfjs.getDocument).toHaveBeenCalledWith(
    expect.objectContaining({ url: "/pub/cap/doc/original.pdf" }),
  );
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

it("keeps original page geometry with an explicit status when the typesetter is unavailable", async () => {
  vi.mocked(api.pdfTypeset).mockResolvedValue({
    status: "unavailable",
    revision: "a",
    reason: "runtime_missing",
  });
  await act(async () => root.render(<TypesetPDFPages {...props()} />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "排版组件",
  );
  expect(pdfjs.getDocument).toHaveBeenCalledWith(
    expect.objectContaining({ url: "/pub/cap/doc/original.pdf" }),
  );
  expect(container.textContent).toContain("当前显示原文");
  expect(container.querySelector(".pdf-typeset-page")).not.toBeNull();
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
  expect(pdfjs.getDocument).not.toHaveBeenCalledWith(
    expect.objectContaining({ url: expect.stringContaining("typeset/stale") }),
  );
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

it("keeps saved text and retry actions in a contained popover during generation and failure", async () => {
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
  expect(container.querySelector('[data-sentence="0"]')).toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".pdf-typeset-unmapped button")!
      .click(),
  );
  expect(container.querySelector('[data-sentence="0"]')?.textContent).toBe(
    "完整译文。",
  );
  expect(
    container.querySelector(".pdf-layout-pages .pdf-typeset-detail"),
  ).toBeNull();
  expect(container.querySelector(".pdf-typeset-detail")).not.toBeNull();
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
  expect(container.querySelector(".pdf-typeset-fallback")).toBeNull();
  expect(container.querySelector("[data-translation-block]")).toBeNull();
  await act(async () => handle.current!.focusBlock!(sourceBlock.id, 0));
  expect(
    container.querySelector(".pdf-typeset-detail [data-translation-block]"),
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
    container.querySelector(".pdf-typeset-detail [data-sentence]")?.textContent,
  ).toBe("完整译文。");
  expect(p.onReady).toHaveBeenCalledTimes(1);
  await act(async () =>
    Array.from(mapped.querySelectorAll("button"))
      .find((b) => b.textContent === "完整译文")!
      .click(),
  );
  expect(
    container.querySelectorAll(`[data-translation-block="${sourceBlock.id}"]`),
  ).toHaveLength(1);
  expect(
    container.querySelector(".pdf-typeset-block [data-translation-block]"),
  ).not.toBeNull();
  expect(p.onReady).toHaveBeenCalledTimes(1);
});

it("never inserts untranslated interaction details between fixed PDF pages or changes scrolling when details open", async () => {
  vi.mocked(api.pdfTypeset).mockResolvedValue({
    status: "complete",
    revision: "a",
  });
  vi.mocked(pdfjs.getDocument).mockReturnValue({
    promise: Promise.resolve({
      numPages: 3,
      getPage: async () => ({
        getViewport: () => ({ width: 600, height: 800 }),
      }),
    }),
    destroy,
  } as unknown as pdfjs.PDFDocumentLoadingTask);
  const blocks = [1, 2, 3].map((page) => ({
    ...sourceBlock,
    id: `p${page}-b1`,
    page,
  }));
  const p = {
    ...props(),
    blocks,
    translations: new Map(
      blocks.map((b) => [b.id, { ...saved, blockId: b.id }]),
    ),
    renderBlock: vi.fn((b: PDFBlock) => (
      <section data-translation-block={b.id}>
        <span data-sentence="0">{"很长的译文。".repeat(1000)}</span>
      </section>
    )),
  };
  await act(async () => root.render(<TypesetPDFPages {...p} />));
  const pages = container.querySelector(".pdf-layout-pages")!;
  Object.defineProperty(container, "clientWidth", {
    value: 320,
    configurable: true,
  });
  expect(p.renderBlock).not.toHaveBeenCalled();
  expect(pages.children).toHaveLength(3);
  const sizes = Array.from(
    container.querySelectorAll<HTMLElement>(".pdf-typeset-page"),
  ).map((p) => [p.style.width, p.style.height]);
  expect(sizes).toHaveLength(3);
  for (const [width, height] of sizes) {
    expect(Number.parseFloat(width)).toBeCloseTo(800);
    expect(Number.parseFloat(height)).toBeCloseTo((800 * 96) / 72);
  }
  container.scrollTop = 1000;
  await act(async () =>
    container
      .querySelectorAll<HTMLButtonElement>(".pdf-typeset-unmapped button")[1]
      .click(),
  );
  expect(container.scrollTop).toBe(1000);
  expect(p.onReady).toHaveBeenCalledTimes(1);
  expect(
    container.querySelector<HTMLElement>(".pdf-typeset-detail")!.style.width,
  ).toBe("288px");
  expect(pages.children).toHaveLength(3);
  expect(pages.querySelector("[data-translation-block]")).toBeNull();
  expect(
    container
      .querySelector(".pdf-typeset-detail [data-translation-block]")
      ?.getAttribute("data-translation-block"),
  ).toBe("p2-b1");
});

it("replaces original pages with the generated PDF when ready without using original coordinates as verified text", async () => {
  vi.mocked(api.pdfTypeset)
    .mockResolvedValueOnce({ status: "running", revision: "a" })
    .mockResolvedValue({ status: "complete", revision: "a" });
  const p = {
    ...props(),
    blocks: [sourceBlock],
    translations: new Map([[saved.blockId, saved]]),
  };
  await act(async () => root.render(<TypesetPDFPages {...p} />));
  expect(container.textContent).toContain("当前显示原文");
  expect(container.querySelector(".pdf-typeset-block")).toBeNull();
  expect(api.pdfTypesetPositions).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(pdfjs.getDocument).toHaveBeenLastCalledWith(
    expect.objectContaining({ url: "/pub/cap/doc/typeset/a.pdf" }),
  );
  expect(api.pdfTypesetPositions).toHaveBeenCalledWith(
    "doc",
    "a",
    expect.any(AbortSignal),
  );
  expect(container.textContent).not.toContain("当前显示原文");
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
