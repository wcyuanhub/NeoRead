import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import * as pdfjs from "pdfjs-dist";
import { api, publicationURL, type PDFTypesetStatus } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import type { PDFBlock, PDFPageViewport, ReaderTheme } from "@neoread/core";
import { pageViewport, followPageViewport } from "../readers/pdf-page-viewport";
import { pdfObjectColors } from "../readers/pdf-dark-mode";
import type { PDFLayoutHandle } from "./PDFLayoutPages";
import { reportDiagnostic } from "../diagnostics";

const explanations: Record<string, string> = {
  runtime_missing: "当前版本未包含 PDF 排版组件，请安装包含该组件的版本。",
  translation_pending: "已完成的译文将在这里自动排版。",
  offline_resource_missing: "排版资源不完整，请重新安装排版组件。",
  no_mapped_translation:
    "暂时无法将已保存译文对应到原文段落，可切换到连续文本阅读。",
  snapshot_changed: "译文已更新，请重新生成排版。",
  cancelled: "排版已中断，可以重试。",
};
const phases: Record<string, string> = {
  parsing: "正在读取 PDF…",
  layout: "正在识别页面布局…",
  paragraphs: "正在识别段落…",
  formulas: "正在保留公式和文字样式…",
  mapping: "正在对应已有译文…",
  typesetting: "正在排版译文…",
  saving: "正在保存译文 PDF…",
};

export function TypesetPDFPages({
  documentId,
  revisionKey,
  theme,
  scale,
  host,
  blocks,
  onFollow,
  onReady,
  ref,
}: {
  documentId: string;
  revisionKey: string;
  theme: ReaderTheme;
  scale: number;
  host: RefObject<HTMLDivElement | null>;
  blocks: PDFBlock[];
  onFollow: () => void;
  onReady: () => void;
  ref: Ref<PDFLayoutHandle>;
}) {
  const [status, setStatus] = useState<PDFTypesetStatus>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{
    pdf: pdfjs.PDFDocumentProxy;
    sizes: { width: number; height: number }[];
  }>();
  const nodes = useRef(new Map<number, HTMLDivElement>());
  const desired = useRef<PDFPageViewport | undefined>(undefined);
  const callbacks = useRef({ onFollow, onReady });
  callbacks.current = { onFollow, onReady };
  const follow = (viewport: PDFPageViewport) => {
    desired.current = viewport;
    const page = nodes.current.get(viewport.page);
    if (page && host.current) {
      callbacks.current.onFollow();
      followPageViewport(host.current, page, viewport);
    }
  };
  const getViewport = () =>
    host.current
      ? pageViewport(host.current, [...nodes.current.values()], scale)
      : undefined;
  useImperativeHandle(ref, () => ({
    follow,
    getViewport,
    goTo: (location) =>
      follow({
        page: location.page,
        x: location.x ?? 0,
        y: location.y ?? 0,
        scale,
      }),
  }));
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setStatus(undefined);
    setFailed(false);
    const poll = async (start: boolean) => {
      try {
        const next = await api.pdfTypeset(documentId, start);
        if (stopped) return;
        setStatus(next);
        if (next.status === "running" || next.status === "waiting")
          timer = setTimeout(() => void poll(false), 1500);
        else if (next.status === "idle") void poll(true);
      } catch {
        if (!stopped) setFailed(true);
      }
    };
    void poll(true);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [documentId, revisionKey, retry]);
  const revision = status?.status === "complete" ? status.revision : undefined;
  useEffect(() => {
    setLoaded(undefined);
    if (!revision) return;
    let stopped = false;
    const task = pdfjs.getDocument({
      url: publicationURL(documentId, `typeset/${revision}.pdf`),
      cMapUrl: "/pdf-assets/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdf-assets/standard_fonts/",
      wasmUrl: "/pdf-assets/wasm/",
    });
    void (async () => {
      const pdf = await task.promise;
      const sizes = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        if (stopped) return;
        const { width, height } = (await pdf.getPage(number)).getViewport({
          scale: 1,
        });
        sizes.push({ width, height });
      }
      if (!stopped) setLoaded({ pdf, sizes });
    })().catch(() => {
      if (!stopped) {
        setFailed(true);
        reportDiagnostic({ level: "error", event: "pdf.typeset.load_failed" });
      }
    });
    return () => {
      stopped = true;
      void task.destroy();
    };
  }, [documentId, revision]);
  useLayoutEffect(() => {
    if (desired.current) follow(desired.current);
    if (loaded) callbacks.current.onReady();
  }, [loaded, scale]);
  useEffect(() => {
    const node = host.current;
    const remember = () => {
      desired.current = getViewport();
    };
    node?.addEventListener("scroll", remember);
    return () => node?.removeEventListener("scroll", remember);
  }, [loaded, scale]);
  if (failed || status?.status === "failed" || status?.status === "unavailable")
    return (
      <div className="pdf-layout-message" role="alert">
        <p>
          {failed
            ? "译文排版加载失败。"
            : (explanations[status?.reason ?? ""] ??
              "译文排版未完成，可以重试或切换到连续文本阅读。")}
        </p>
        <Button variant="outline" onClick={() => setRetry((v) => v + 1)}>
          重试
        </Button>
      </div>
    );
  if (!loaded)
    return (
      <p className="pdf-layout-message" role="status">
        {status?.status === "waiting"
          ? explanations.translation_pending
          : status?.status === "complete"
            ? "正在加载译文页面…"
            : (phases[status?.phase ?? ""] ?? "正在生成译文排版…")}
      </p>
    );
  return (
    <div className="pdf-layout-pages pdf-typeset-pages">
      <p className="pdf-typeset-summary">
        文字可选取复制；逐句定位和批注请切换到连续文本。
      </p>
      {!!status?.preserved && (
        <p className="pdf-typeset-summary" role="status">
          部分公式、图表或未匹配段落保留原文，完整译文可在连续文本中阅读。
        </p>
      )}
      {loaded.sizes.map((size, index) => (
        <TypesetPage
          key={index}
          pdf={loaded.pdf}
          number={index + 1}
          size={size}
          scale={scale}
          host={host}
          theme={theme}
          blocks={blocks.filter((block) => block.page === index + 1)}
          pageRef={(node) => {
            if (node) nodes.current.set(index + 1, node);
            else nodes.current.delete(index + 1);
          }}
        />
      ))}
    </div>
  );
}

function TypesetPage({
  pdf,
  number,
  size,
  scale,
  host,
  theme,
  blocks,
  pageRef,
}: {
  pdf: pdfjs.PDFDocumentProxy;
  number: number;
  size: { width: number; height: number };
  scale: number;
  host: RefObject<HTMLDivElement | null>;
  theme: ReaderTheme;
  blocks: PDFBlock[];
  pageRef: (node: HTMLDivElement | null) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const zoom = (scale * 96) / 72;
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: host.current, rootMargin: "100% 0px" },
    );
    observer.observe(frame.current!);
    return () => observer.disconnect();
  }, [host]);
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    let render: pdfjs.RenderTask | undefined;
    let layer: pdfjs.TextLayer | undefined;
    const target = canvas.current!,
      container = text.current!;
    setError(false);
    void (async () => {
      const page = await pdf.getPage(number);
      if (stopped) return;
      const resolution = Math.min(
        zoom * (window.devicePixelRatio || 1),
        Math.sqrt(8_000_000 / (size.width * size.height)),
      );
      const viewport = page.getViewport({ scale: resolution });
      target.width = Math.ceil(viewport.width);
      target.height = Math.ceil(viewport.height);
      const colors = pdfObjectColors(theme);
      render = page.render({
        canvas: target,
        viewport,
        ...(colors
          ? { pageColors: colors, background: colors.background }
          : {}),
      });
      await render.promise;
      if (stopped) return;
      container.replaceChildren();
      const content = await page.getTextContent();
      if (stopped) return;
      layer = new pdfjs.TextLayer({
        textContentSource: content,
        container,
        viewport: page.getViewport({ scale: zoom }),
      });
      if (stopped) return;
      await layer.render();
    })().catch(() => {
      if (!stopped) {
        setError(true);
        reportDiagnostic({
          level: "error",
          event: "pdf.typeset.render_failed",
        });
      }
    });
    return () => {
      stopped = true;
      render?.cancel();
      layer?.cancel();
      target.width = target.height = 0;
      container.replaceChildren();
    };
  }, [pdf, number, visible, zoom, theme.mode, theme.pdfDarkContrast, retry]);
  return (
    <div
      ref={(node) => {
        frame.current = node;
        pageRef(node);
      }}
      className="pdf-layout-page pdf-typeset-page"
      data-page-number={number}
      data-page-width={size.width}
      aria-label={`译文第 ${number} 页`}
      style={
        {
          width: size.width * zoom,
          height: size.height * zoom,
          "--scale-factor": zoom,
          "--total-scale-factor": zoom,
        } as React.CSSProperties
      }
    >
      {visible && (
        <>
          <canvas
            ref={canvas}
            className="pdf-layout-canvas"
            aria-hidden="true"
          />
          <div ref={text} className="textLayer" />
          {error && (
            <div className="pdf-layout-message" role="alert">
              页面显示失败{" "}
              <Button variant="outline" onClick={() => setRetry((v) => v + 1)}>
                重试
              </Button>
            </div>
          )}
        </>
      )}
      {blocks.map((block) => (
        <span
          key={block.id}
          data-translation-block={block.id}
          className="pdf-typeset-anchor"
          style={{
            left: block.bounds.x * size.width * zoom,
            top: block.bounds.y * size.height * zoom,
          }}
        />
      ))}
    </div>
  );
}
