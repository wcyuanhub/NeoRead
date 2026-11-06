// @vitest-environment jsdom
import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pdfjs from "pdfjs-dist";
import {
  defaultTheme,
  type PDFBlock,
  type TranslationBlock,
} from "@neoread/core";
import { publicationURL } from "@neoread/api";
import { PDFLayoutPages, type PDFLayoutHandle } from "./PDFLayoutPages";
import { pageBlockLayouts, type PageBlockLayout } from "./pdf-page-layout";
import { fitTranslatedElement } from "./pdf-dom-fit";
import { matchesSource } from "./pdf-content";
import { TranslationText } from "./TranslationText";
import { reportDiagnostic } from "../diagnostics";
import { pageViewport, followPageViewport } from "../readers/pdf-page-viewport";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "mock-pdf-worker",
}));
vi.mock("@neoread/api", () => ({
  publicationURL: vi.fn((id: string, file: string) => `/mock/${id}/${file}`),
}));
vi.mock("./pdf-page-layout", () => ({ pageBlockLayouts: vi.fn() }));
vi.mock("./pdf-dom-fit", () => ({ fitTranslatedElement: vi.fn() }));
vi.mock("./pdf-content", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pdf-content")>()),
  matchesSource: vi.fn(),
}));
vi.mock("../diagnostics", () => ({ reportDiagnostic: vi.fn() }));
// Parent scroll synchronization is tested in PDFReadingView, not against jsdom geometry.
vi.mock("../readers/pdf-page-viewport", () => ({
  pageViewport: vi.fn(),
  followPageViewport: vi.fn(),
}));
vi.mock("./TranslationText", () => ({
  TranslationText: vi.fn(
    ({
      block,
      translation,
      retry,
      paused,
    }: ComponentProps<typeof TranslationText>) => (
      <div
        data-testid="full-translation"
        data-block-id={block.id}
        data-paused={paused}
      >
        <p>
          {translation?.sentences.map((sentence) => sentence.target).join(" ")}
        </p>
        <button onClick={retry}>重试此段</button>
      </div>
    ),
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function renderTask(promise: Promise<void> = Promise.resolve()) {
  return { promise, cancel: vi.fn() } as unknown as pdfjs.RenderTask;
}

function pdfFixture(sizes = [{ width: 600, height: 800 }]) {
  const pages = sizes.map(({ width, height }) => ({
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale,
    })),
    render: vi.fn(() => renderTask()),
  }));
  const getPage = vi.fn(
    async (number: number) =>
      pages[number - 1] as unknown as pdfjs.PDFPageProxy,
  );
  const pdf = {
    numPages: pages.length,
    getPage,
  } as unknown as pdfjs.PDFDocumentProxy;
  return { pdf, pages, getPage };
}

function loadingTask(promise: Promise<pdfjs.PDFDocumentProxy>) {
  return {
    promise,
    destroy: vi.fn(async () => {}),
  } as unknown as pdfjs.PDFDocumentLoadingTask;
}

const block: PDFBlock = {
  id: "p1-b1",
  page: 1,
  label: "text",
  text: "The original paragraph.",
  bounds: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
};
const translation: TranslationBlock = {
  blockId: block.id,
  sourceHash: "current-source",
  status: "complete",
  sentences: [
    { source: "The original paragraph.", target: "完整译文的第一句。" },
    { source: "Its continuation.", target: "完整译文的最后一句。" },
  ],
};
function layout(overrides: Partial<PageBlockLayout> = {}): PageBlockLayout {
  return {
    box: { x: 60, y: 160, width: 300, height: 80 },
    mask: { x: 59, y: 159, width: 302, height: 82 },
    fontSize: 12,
    lineHeight: 1.3,
    fontFamily: "serif",
    fontWeight: 400,
    textAlign: "left",
    ...overrides,
  };
}

class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = [];
  target?: Element;
  observe = vi.fn((target: Element) => {
    this.target = target;
  });
  disconnect = vi.fn();
  constructor(
    private callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    IntersectionObserverMock.instances.push(this);
  }
  setVisible(isIntersecting: boolean) {
    this.callback(
      [{ target: this.target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

type Props = ComponentProps<typeof PDFLayoutPages>;
let root: Root | undefined;
let host: HTMLDivElement;
let props: Props;
let fixture: ReturnType<typeof pdfFixture>;
let task: pdfjs.PDFDocumentLoadingTask;
let frames: Map<number, FrameRequestCallback>;
let context: CanvasRenderingContext2D;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  IntersectionObserverMock.instances = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  frames = new Map();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("devicePixelRatio", 1);
  fetchMock = vi.fn(() => {
    throw new Error("Unexpected network request");
  });
  vi.stubGlobal("fetch", fetchMock);
  context = {} as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.mocked(publicationURL).mockImplementation(
    (id, file) => `/mock/${id}/${file}`,
  );
  vi.mocked(matchesSource).mockResolvedValue(true);
  vi.mocked(fitTranslatedElement).mockReturnValue(12);
  vi.mocked(pageBlockLayouts).mockImplementation(
    async (_page, blocks) => new Map(blocks.map((item) => [item.id, layout()])),
  );
  // resetAllMocks clears the lightweight renderer's implementation too.
  vi.mocked(TranslationText).mockImplementation(
    ({ block, translation, retry, paused }) => (
      <div
        data-testid="full-translation"
        data-block-id={block.id}
        data-paused={paused}
      >
        <p>
          {translation?.sentences.map((sentence) => sentence.target).join(" ")}
        </p>
        <button onClick={retry}>重试此段</button>
      </div>
    ),
  );
  fixture = pdfFixture();
  task = loadingTask(Promise.resolve(fixture.pdf));
  vi.mocked(pdfjs.getDocument).mockReturnValue(task);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = {
    enabled: true,
    documentId: "doc",
    blocks: [block],
    translations: new Map([[block.id, translation]]),
    theme: defaultTheme,
    scale: 1,
    host: { current: host },
    ref: createRef<PDFLayoutHandle>(),
    onReady: vi.fn(),
    onFollow: vi.fn(),
    onRetry: vi.fn(),
    onCitation: vi.fn(),
    paused: false,
    children: (
      <section
        data-translation-block={block.id}
        data-selection-anchor="retained"
      >
        <p>完整译文的第一句。</p>
        <p>完整译文的最后一句。</p>
      </section>
    ),
  };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
  const networkCalls = fetchMock.mock.calls.length;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(networkCalls).toBe(0);
});

async function render(overrides: Partial<Props> = {}) {
  props = { ...props, ...overrides };
  await act(async () => root!.render(<PDFLayoutPages {...props} />));
}
async function visible(number = 1, value = true) {
  const observer = IntersectionObserverMock.instances.find(
    (item) => item.target?.getAttribute("data-page-number") === String(number),
  );
  expect(observer).toBeDefined();
  await act(async () => observer!.setVisible(value));
}
async function fitFrame() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}
async function click(label: string, scope: ParentNode = document.body) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.textContent === label || item.getAttribute("aria-label") === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function expectUncovered() {
  expect(host.querySelector("canvas")).not.toBeNull();
  expect(host.querySelector(".pdf-layout-mask")).toBeNull();
  expect(host.querySelector("[data-covered]")).toBeNull();
  expect(
    host.querySelector<HTMLElement>(".pdf-layout-body")?.style.visibility,
  ).toBe("hidden");
}
async function openTranslation(reason: string) {
  expect(document.querySelector(".pdf-layout-expanded")).toBeNull();
  await click(`${reason}，查看第 1 页段落译文`);
  const popover = document.querySelector<HTMLElement>(".pdf-layout-expanded");
  expect(popover).not.toBeNull();
  expect(popover!.textContent).toContain(reason);
  return popover!;
}

describe("document loading and lifecycle", () => {
  it("returns the original children unchanged when disabled and never opens the PDF", async () => {
    const onClick = vi.fn();
    await render({
      enabled: false,
      children: (
        <section data-translation-block={block.id}>
          <button onClick={onClick}>原 children</button>
        </section>
      ),
    });
    expect(host.children).toHaveLength(1);
    expect(host.firstElementChild?.tagName).toBe("SECTION");
    await click("原 children");
    expect(onClick).toHaveBeenCalledOnce();
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
    expect(publicationURL).not.toHaveBeenCalled();
    expect(props.onReady).not.toHaveBeenCalled();
    expect(IntersectionObserverMock.instances).toHaveLength(0);
  });

  it("keeps each page's actual dimensions, including empty pages, and rescales without reopening", async () => {
    fixture = pdfFixture([
      { width: 612, height: 792 },
      { width: 900, height: 500 },
    ]);
    vi.mocked(pdfjs.getDocument).mockReturnValue(
      loadingTask(Promise.resolve(fixture.pdf)),
    );
    await render({ scale: 1.5 });
    const pages = [...host.querySelectorAll<HTMLElement>(".pdf-layout-page")];
    expect(pages).toHaveLength(2);
    expect(
      pages.map((page) => [page.dataset.pageNumber, page.dataset.pageWidth]),
    ).toEqual([
      ["1", "612"],
      ["2", "900"],
    ]);
    expect(pages.map((page) => [page.style.width, page.style.height])).toEqual([
      ["1224px", "1584px"],
      ["1800px", "1000px"],
    ]);
    const sheets = [...host.querySelectorAll<HTMLElement>(".pdf-layout-sheet")];
    expect(
      sheets.map((sheet) => [
        sheet.style.width,
        sheet.style.height,
        sheet.style.transform,
      ]),
    ).toEqual([
      ["612px", "792px", "scale(2)"],
      ["900px", "500px", "scale(2)"],
    ]);
    expect(pages[0].querySelector("[data-translation-block]")).not.toBeNull();
    expect(pages[1].querySelector("[data-translation-block]")).toBeNull();
    expect(fixture.getPage.mock.calls).toEqual([[1], [2]]);
    fixture.pages.forEach((page) =>
      expect(page.getViewport).toHaveBeenCalledWith({ scale: 1 }),
    );
    expect(props.onReady).toHaveBeenCalledOnce();
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("mock-pdf-worker");
    expect(pdfjs.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/mock/doc/original.pdf" }),
    );
    await render({ scale: 0.75 });
    expect(pages[1].style.width).toBe("900px");
    expect(pages[1].style.height).toBe("500px");
    expect(sheets[1].style.transform).toBe("scale(1)");
    expect(pdfjs.getDocument).toHaveBeenCalledOnce();
    expect(props.onReady).toHaveBeenCalledOnce();
    expect(host.querySelector("canvas")).toBeNull();
  });

  it.each(["document", "page size"])(
    "reports %s loading failures and retries with a new loading task",
    async (stage) => {
      const pending = deferred<pdfjs.PDFDocumentProxy>();
      task = loadingTask(pending.promise);
      vi.mocked(pdfjs.getDocument).mockReturnValueOnce(task);
      if (stage === "page size")
        fixture.getPage.mockRejectedValueOnce(new Error("bad page"));
      await render();
      expect(host.querySelector('[role="status"]')?.textContent).toContain(
        "正在加载页面",
      );
      await act(async () => {
        if (stage === "document") pending.reject(new Error("bad PDF"));
        else pending.resolve(fixture.pdf);
      });
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        "译文页面加载失败",
      );
      expect(props.onReady).not.toHaveBeenCalled();
      expect(reportDiagnostic).toHaveBeenCalledExactlyOnceWith({
        level: "error",
        event: "pdf.translation_layout.load_failed",
      });
      const retry = deferred<pdfjs.PDFDocumentProxy>();
      vi.mocked(pdfjs.getDocument).mockReturnValueOnce(
        loadingTask(retry.promise),
      );
      await click("重试");
      expect(task.destroy).toHaveBeenCalledOnce();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.querySelector('[role="status"]')).not.toBeNull();
      await act(async () => retry.resolve(fixture.pdf));
      expect(host.querySelector(".pdf-layout-page")).not.toBeNull();
      expect(pdfjs.getDocument).toHaveBeenCalledTimes(2);
      expect(props.onReady).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "destroys the loading task on unmount (already loaded: %s)",
    async (loaded) => {
      const pending = deferred<pdfjs.PDFDocumentProxy>();
      task = loadingTask(
        loaded ? Promise.resolve(fixture.pdf) : pending.promise,
      );
      vi.mocked(pdfjs.getDocument).mockReturnValueOnce(task);
      await render();
      await act(async () => root!.unmount());
      root = undefined;
      expect(task.destroy).toHaveBeenCalledOnce();
      IntersectionObserverMock.instances.forEach((observer) =>
        expect(observer.disconnect).toHaveBeenCalledOnce(),
      );
      const calls = vi.mocked(props.onReady).mock.calls.length;
      await act(async () => pending.resolve(fixture.pdf));
      expect(props.onReady).toHaveBeenCalledTimes(calls);
      expect(reportDiagnostic).not.toHaveBeenCalled();
      expect(host.childElementCount).toBe(0);
    },
  );

  it.each(["resolve", "reject"])(
    "does not commit an old document's late %s after switching documents",
    async (outcome) => {
      const old = deferred<pdfjs.PDFDocumentProxy>();
      task = loadingTask(old.promise);
      vi.mocked(pdfjs.getDocument).mockReturnValueOnce(task);
      await render({ documentId: "old" });
      const latest = pdfFixture([{ width: 420, height: 700 }]);
      vi.mocked(pdfjs.getDocument).mockReturnValueOnce(
        loadingTask(Promise.resolve(latest.pdf)),
      );
      await render({ documentId: "latest" });
      expect(task.destroy).toHaveBeenCalledOnce();
      await act(async () => {
        if (outcome === "resolve") old.resolve(fixture.pdf);
        else old.reject(new Error("stale load"));
      });
      expect(
        host.querySelector<HTMLElement>(".pdf-layout-page")?.dataset.pageWidth,
      ).toBe("420");
      expect(fixture.getPage).not.toHaveBeenCalled();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(props.onReady).toHaveBeenCalledOnce();
      expect(reportDiagnostic).not.toHaveBeenCalled();
    },
  );

  it("ignores a pending page-size result after disabling layout and restores children", async () => {
    const pending = deferred<pdfjs.PDFPageProxy>();
    fixture.getPage.mockReturnValueOnce(pending.promise);
    await render();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await render({ enabled: false });
    expect(task.destroy).toHaveBeenCalledOnce();
    await act(async () =>
      pending.resolve(fixture.pages[0] as unknown as pdfjs.PDFPageProxy),
    );
    expect(host.firstElementChild?.getAttribute("data-selection-anchor")).toBe(
      "retained",
    );
    expect(host.querySelector(".pdf-layout-pages")).toBeNull();
    expect(props.onReady).not.toHaveBeenCalled();
    expect(reportDiagnostic).not.toHaveBeenCalled();
  });
});

describe("page viewport ownership", () => {
  it("keeps pages ordered after independently rerendering their visibility", async () => {
    fixture = pdfFixture([
      { width: 600, height: 800 },
      { width: 600, height: 800 },
    ]);
    vi.mocked(pdfjs.getDocument).mockReturnValueOnce(
      loadingTask(Promise.resolve(fixture.pdf)),
    );
    const ref = createRef<PDFLayoutHandle>();
    await render({ ref });
    await visible(2);
    await visible(1);
    ref.current!.getViewport();
    expect(
      vi
        .mocked(pageViewport)
        .mock.calls.at(-1)![1]
        .map((page) => page.dataset.pageNumber),
    ).toEqual(["1", "2"]);
  });

  it("restores the translated pane's own scroll anchor on zoom without announcing a new load", async () => {
    const ref = createRef<PDFLayoutHandle>();
    await render({ ref });
    ref.current!.follow({ page: 1, x: 0, y: 0.1, scale: 1 });
    const current = { page: 1, x: 0.2, y: 0.6, scale: 1 };
    vi.mocked(pageViewport).mockReturnValue(current);
    host.dispatchEvent(new Event("scroll"));
    await render({ scale: 2 });
    expect(followPageViewport).toHaveBeenLastCalledWith(
      host,
      host.querySelector(".pdf-layout-page"),
      current,
    );
    expect(props.onReady).toHaveBeenCalledOnce();
  });
});

describe("visible page canvas rendering", () => {
  it("keeps white-paper analysis legible at low display zoom", async () => {
    await render({ scale: 0.2 });
    await visible();
    const canvas = host.querySelector("canvas")!;
    expect([canvas.width, canvas.height]).toEqual([900, 1200]);
    expect(pageBlockLayouts).toHaveBeenCalledWith(
      fixture.pages[0],
      [block],
      context,
      1.5,
    );
  });
  it("renders only observed visible pages at the scaled canvas size", async () => {
    vi.stubGlobal("devicePixelRatio", 3);
    fixture = pdfFixture([
      { width: 600, height: 800 },
      { width: 500, height: 300 },
    ]);
    vi.mocked(pdfjs.getDocument).mockReturnValueOnce(
      loadingTask(Promise.resolve(fixture.pdf)),
    );
    await render({ scale: 0.75 });
    expect(IntersectionObserverMock.instances[1].options).toEqual({
      root: host,
      rootMargin: "100% 0px",
    });
    expect(host.querySelector("canvas")).toBeNull();
    await visible(2);
    const canvas = host.querySelector("canvas")!;
    expect(
      canvas.closest<HTMLElement>(".pdf-layout-page")?.dataset.pageNumber,
    ).toBe("2");
    expect([canvas.width, canvas.height]).toEqual([1000, 600]);
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith("2d", {
      willReadFrequently: true,
    });
    expect(fixture.pages[0].render).not.toHaveBeenCalled();
    expect(fixture.pages[1].render).toHaveBeenCalledWith({
      canvas,
      canvasContext: context,
      viewport: { width: 1000, height: 600 },
      background: "#ffffff",
    });
    expect(pageBlockLayouts).toHaveBeenCalledWith(
      fixture.pages[1],
      [],
      context,
      2,
    );
  });

  it.each(["hidden", "unmount"])(
    "cancels rendering and clears canvas pixels when %s, ignoring cancellation errors",
    async (action) => {
      const pending = deferred<void>();
      const rendering = renderTask(pending.promise);
      fixture.pages[0].render.mockReturnValueOnce(rendering);
      await render();
      await visible();
      const canvas = host.querySelector("canvas")!;
      expect(canvas.width).toBeGreaterThan(0);
      if (action === "hidden") await visible(1, false);
      else {
        await act(async () => root!.unmount());
        root = undefined;
      }
      expect(rendering.cancel).toHaveBeenCalledOnce();
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
      await act(async () =>
        pending.reject(new Error("RenderingCancelledException")),
      );
      expect(pageBlockLayouts).not.toHaveBeenCalled();
      expect(reportDiagnostic).not.toHaveBeenCalled();
      expect(host.querySelector("canvas")).toBeNull();
      if (action === "hidden")
        expect(host.querySelector(".pdf-layout-placeholder")).not.toBeNull();
    },
  );

  it("discards old async layouts after a scale change and cancels the previous render", async () => {
    const old = deferred<Map<string, PageBlockLayout>>();
    vi.mocked(pageBlockLayouts)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(
        new Map([[block.id, layout({ mask: undefined })]]),
      );
    await render();
    await visible();
    const rendering = fixture.pages[0].render.mock.results[0].value;
    await render({ scale: 1.5 });
    expect(rendering.cancel).toHaveBeenCalledOnce();
    expect(fixture.pages[0].render).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(new Map([[block.id, layout()]])));
    await fitFrame();
    expectUncovered();
    expect(
      host.querySelector(".pdf-layout-expand")?.getAttribute("aria-label"),
    ).toContain("此区域保留原版");
    expect(fitTranslatedElement).not.toHaveBeenCalled();
    expect(pdfjs.getDocument).toHaveBeenCalledOnce();
  });

  it.each(["render", "layout"])(
    "reports %s errors and retries the page without reopening the PDF",
    async (stage) => {
      const pending = deferred<void>();
      const rendering = renderTask(pending.promise);
      fixture.pages[0].render.mockReturnValueOnce(rendering);
      if (stage === "layout")
        vi.mocked(pageBlockLayouts).mockRejectedValueOnce(
          new Error("bad layout"),
        );
      await render();
      await visible();
      await act(async () => {
        if (stage === "render") pending.reject(new Error("bad render"));
        else pending.resolve();
      });
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        "本页显示失败",
      );
      expectUncovered();
      expect(reportDiagnostic).toHaveBeenCalledExactlyOnceWith({
        level: "error",
        event: "pdf.translation_layout.render_failed",
      });
      await click("重试");
      await fitFrame();
      expect(rendering.cancel).toHaveBeenCalledOnce();
      expect(fixture.pages[0].render).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.querySelector(".pdf-layout-mask")).not.toBeNull();
      expect(pdfjs.getDocument).toHaveBeenCalledOnce();
      expect(task.destroy).not.toHaveBeenCalled();
    },
  );
});

describe("safe translation coverage and full-text fallback", () => {
  it("masks only after completion, source verification and a successful fit, retaining section metadata", async () => {
    const matching = deferred<boolean>();
    vi.mocked(matchesSource).mockReturnValueOnce(matching.promise);
    await render();
    await visible();
    await fitFrame();
    expectUncovered();
    expect(fitTranslatedElement).not.toHaveBeenCalled();
    await act(async () => matching.resolve(true));
    expectUncovered();
    await fitFrame();
    expect(matchesSource).toHaveBeenCalledWith(block, translation);
    const body = host.querySelector<HTMLElement>(".pdf-layout-body")!;
    expect(fitTranslatedElement).toHaveBeenCalledWith(body, 300, 80, 12, 1.3);
    expect(body.style.visibility).toBe("visible");
    expect(
      body.querySelector("section")?.getAttribute("data-selection-anchor"),
    ).toBe("retained");
    expect(body.textContent).toContain("完整译文的最后一句。");
    const mask = host.querySelector<HTMLElement>(".pdf-layout-mask")!;
    expect([
      mask.style.left,
      mask.style.top,
      mask.style.width,
      mask.style.height,
    ]).toEqual(["59px", "159px", "302px", "82px"]);
    expect(
      host.querySelector(".pdf-layout-block")?.getAttribute("data-covered"),
    ).toBe("true");
    expect(host.querySelector(".pdf-layout-expand")).toBeNull();
  });

  it.each(["overflow", "unsafe region"])(
    "preserves the original for %s and opens the complete translation with retry",
    async (reason) => {
      if (reason === "overflow")
        vi.mocked(fitTranslatedElement).mockReturnValue(null);
      else
        vi.mocked(pageBlockLayouts).mockResolvedValue(
          new Map([[block.id, layout({ mask: undefined })]]),
        );
      await render({ paused: true });
      await visible();
      await fitFrame();
      expectUncovered();
      const popover = await openTranslation(
        reason === "overflow" ? "译文超出原区域" : "此区域保留原版",
      );
      expect(popover.textContent).toContain("完整译文的第一句。");
      expect(popover.textContent).toContain("完整译文的最后一句。");
      expect(
        popover
          .querySelector("[data-testid=full-translation]")
          ?.getAttribute("data-paused"),
      ).toBe("true");
      expect(vi.mocked(TranslationText).mock.calls.at(-1)?.[0]).toMatchObject({
        block,
        translation,
        documentId: "doc",
        onCitation: props.onCitation,
        paused: true,
      });
      await click("重试此段", popover);
      expect(props.onRetry).toHaveBeenCalledExactlyOnceWith(block.id);
      expectUncovered();
    },
  );

  it.each(["mismatch", "verification error"])(
    "does not cover stale text on %s and offers retranslating instead",
    async (reason) => {
      if (reason === "mismatch")
        vi.mocked(matchesSource).mockResolvedValue(false);
      else
        vi.mocked(matchesSource).mockRejectedValue(
          new Error("hash unavailable"),
        );
      await render();
      await visible();
      await fitFrame();
      expectUncovered();
      expect(fitTranslatedElement).not.toHaveBeenCalled();
      const popover = await openTranslation("译文与原文不匹配");
      expect(popover.textContent).toContain("原文内容已变化，请重新翻译此段。");
      expect(
        popover.querySelector("[data-testid=full-translation]"),
      ).toBeNull();
      await click("重新翻译", popover);
      expect(props.onRetry).toHaveBeenCalledExactlyOnceWith(block.id);
    },
  );

  it.each([
    "idle",
    "pending",
    "running",
    "failed",
    "empty",
    "missing",
  ] as const)(
    "never masks an incomplete translation (%s) and connects its retry action",
    async (status) => {
      const value: TranslationBlock | undefined =
        status === "missing"
          ? undefined
          : {
              ...translation,
              status: status === "empty" ? "complete" : status,
              sentences: status === "empty" ? [] : translation.sentences,
            };
      await render({
        translations: value ? new Map([[block.id, value]]) : new Map(),
      });
      await visible();
      await fitFrame();
      expectUncovered();
      expect(matchesSource).not.toHaveBeenCalled();
      expect(fitTranslatedElement).not.toHaveBeenCalled();
      const popover = await openTranslation("尚未完成翻译");
      expect(
        popover.querySelector("[data-testid=full-translation]"),
      ).not.toBeNull();
      await click("重试此段", popover);
      expect(props.onRetry).toHaveBeenCalledExactlyOnceWith(block.id);
    },
  );

  it("removes an existing mask when a retry changes complete to pending", async () => {
    await render();
    await visible();
    await fitFrame();
    expect(host.querySelector(".pdf-layout-mask")).not.toBeNull();
    await render({
      translations: new Map([
        [block.id, { ...translation, status: "pending" }],
      ]),
    });
    expectUncovered();
    await fitFrame();
    expectUncovered();
    await openTranslation("尚未完成翻译");
  });

  it.each(["source text", "source hash"])(
    "rejects a late matching result after the %s changes",
    async (change) => {
      const old = deferred<boolean>();
      vi.mocked(matchesSource)
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(false);
      await render();
      await visible();
      await render(
        change === "source text"
          ? { blocks: [{ ...block, text: "Reparsed original." }] }
          : {
              translations: new Map([
                [block.id, { ...translation, sourceHash: "new-source" }],
              ]),
            },
      );
      await act(async () => old.resolve(true));
      await fitFrame();
      expectUncovered();
      expect(matchesSource).toHaveBeenCalledTimes(2);
      expect(fitTranslatedElement).not.toHaveBeenCalled();
      await openTranslation("译文与原文不匹配");
    },
  );

  it("keeps a merged figure intact and makes its translated caption available", async () => {
    const figure = {
      ...block,
      image: "figure.png",
      caption: "Figure caption.",
    };
    await render({ blocks: [figure] });
    await visible();
    await fitFrame();
    expect(matchesSource).toHaveBeenCalledWith(
      { ...figure, text: figure.caption },
      translation,
    );
    expect(host.querySelector("canvas")).not.toBeNull();
    expect(host.querySelector(".pdf-layout-mask")).toBeNull();
    expect(host.querySelector("[data-covered]")).toBeNull();
    expect(host.querySelector(".pdf-layout-body")).toBeNull();
    expect(host.querySelector(".pdf-layout-expand")?.textContent).toBe(
      "查看图注译文",
    );
    const popup = await openTranslation("此区域保留原版");
    expect(popup.textContent).toContain("完整译文的最后一句。");
    expect(TranslationText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        block: expect.objectContaining({
          text: figure.caption,
          image: undefined,
          label: "text",
        }),
      }),
      undefined,
    );
    await render({ blocks: [{ ...figure, caption: "Changed caption." }] });
    await fitFrame();
    expect(matchesSource).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Changed caption." }),
      translation,
    );
  });

  it.each([
    { label: "text", image: "embedded.png" },
    { label: "image" },
    { label: "display_formula" },
    { label: "inline_formula" },
    { label: "algorithm" },
  ])(
    "keeps preserved $label content in the original canvas without a mask or duplicate body",
    async (preserved) => {
      // Even a permissive mocked layout must not make preserved content cover the PDF.
      await render({ blocks: [{ ...block, ...preserved }] });
      await visible();
      await fitFrame();
      expect(host.querySelector("canvas")).not.toBeNull();
      expect(host.querySelector(".pdf-layout-mask")).toBeNull();
      expect(host.querySelector("[data-covered]")).toBeNull();
      expect(host.querySelector(".pdf-layout-body")).toBeNull();
      expect(host.querySelector(".pdf-layout-expand")).toBeNull();
      expect(fitTranslatedElement).not.toHaveBeenCalled();
      const section = host.querySelector<HTMLElement>(
        "[data-translation-block]",
      )!;
      expect(section.dataset.selectionAnchor).toBe("retained");
      expect(section.childElementCount).toBe(0);
      expect(section.textContent).toBe("");
    },
  );
});
