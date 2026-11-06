import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import * as pdfjs from "pdfjs-dist";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
  PDFBlock,
  PDFLocation,
  PDFPageViewport,
  ReaderTheme,
  TranslationBlock,
} from "@neoread/core";
import { publicationURL } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@neoread/ui/components/popover";
import { pageBlockLayouts, type PageBlockLayout } from "./pdf-page-layout";
import { fitTranslatedElement } from "./pdf-dom-fit";
import { matchesSource, preservedLabels } from "./pdf-content";
import { pdfObjectColors } from "../readers/pdf-dark-mode";
import { pageViewport, followPageViewport } from "../readers/pdf-page-viewport";
import { reportDiagnostic } from "../diagnostics";
import { TranslationText } from "./TranslationText";
import { translationFont } from "../appearance";
import "./pdf-layout-reading.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerURL;

type PageSize = { width: number; height: number };
export type PDFLayoutHandle = {
  follow: (viewport: PDFPageViewport) => void;
  goTo: (location: PDFLocation) => void;
  getViewport: () => PDFPageViewport | undefined;
};
type RenderBlock = (block: PDFBlock, content?: ReactNode) => ReactNode;
type TranslationActions = {
  onRetry: (blockId: string) => void;
  onCitation: (blockId: string, label: string) => void;
  paused: boolean;
};

export function PDFLayoutPages({
  documentId,
  blocks,
  translations,
  theme,
  scale,
  host,
  children,
  enabled,
  onFollow,
  onReady,
  ref,
  onRetry,
  onCitation,
  paused,
}: TranslationActions & {
  enabled: boolean;
  children: ReactNode;
  documentId: string;
  blocks: PDFBlock[];
  translations: Map<string, TranslationBlock>;
  theme: ReaderTheme;
  scale: number;
  host: RefObject<HTMLDivElement | null>;
  onFollow: () => void;
  onReady: () => void;
  ref: Ref<PDFLayoutHandle>;
}) {
  const sections = new Map(
    Children.toArray(children).flatMap((child) =>
      isValidElement<{ "data-translation-block": string; children: ReactNode }>(
        child,
      )
        ? [[child.props["data-translation-block"], child] as const]
        : [],
    ),
  );
  const renderBlock: RenderBlock = (block, content) => {
    const section = sections.get(block.id);
    return (
      section &&
      (content === undefined
        ? section
        : cloneElement(section, { children: content }))
    );
  };
  const [document, setDocument] = useState<{
    pdf: pdfjs.PDFDocumentProxy;
    sizes: PageSize[];
  }>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
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
      ? pageViewport(
          host.current,
          [...nodes.current.values()].sort(
            (a, b) =>
              Number(a.dataset.pageNumber) - Number(b.dataset.pageNumber),
          ),
          scale,
        )
      : undefined;
  useImperativeHandle(ref, () => ({
    follow,
    goTo: (location) =>
      follow({
        page: location.page,
        x: location.x ?? 0,
        y: location.y ?? 0,
        scale,
      }),
    getViewport,
  }));
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    setError(false);
    setDocument(undefined);
    const task = pdfjs.getDocument({
      url: publicationURL(documentId, "original.pdf"),
      cMapUrl: "/pdf-assets/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdf-assets/standard_fonts/",
      wasmUrl: "/pdf-assets/wasm/",
    });
    void (async () => {
      const pdf = await task.promise;
      const sizes: PageSize[] = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        if (stopped) return;
        const page = await pdf.getPage(number);
        const { width, height } = page.getViewport({ scale: 1 });
        sizes.push({ width, height });
      }
      if (!stopped) setDocument({ pdf, sizes });
    })().catch(() => {
      if (stopped) return;
      setError(true);
      reportDiagnostic({
        level: "error",
        event: "pdf.translation_layout.load_failed",
      });
    });
    return () => {
      stopped = true;
      void task.destroy();
    };
  }, [documentId, retry, enabled]);
  useLayoutEffect(() => {
    if (!enabled) return;
    if (desired.current) follow(desired.current);
    const node = host.current;
    const remember = () => {
      desired.current = getViewport();
    };
    node?.addEventListener("scroll", remember);
    return () => node?.removeEventListener("scroll", remember);
  }, [document, scale, enabled]);
  useLayoutEffect(() => {
    if (enabled && document) callbacks.current.onReady();
  }, [document, enabled]);
  if (!enabled) return children;
  if (error)
    return (
      <div className="pdf-layout-message" role="alert">
        译文页面加载失败{" "}
        <Button variant="outline" onClick={() => setRetry((v) => v + 1)}>
          重试
        </Button>
      </div>
    );
  if (!document)
    return (
      <p className="pdf-layout-message" role="status">
        正在加载页面…
      </p>
    );
  return (
    <div className="pdf-layout-pages">
      {document.sizes.map((size, index) => (
        <LayoutPage
          key={index + 1}
          pdf={document.pdf}
          number={index + 1}
          size={size}
          scale={scale}
          host={host}
          theme={theme}
          blocks={blocks.filter((block) => block.page === index + 1)}
          translations={translations}
          documentId={documentId}
          renderBlock={renderBlock}
          onRetry={onRetry}
          onCitation={onCitation}
          paused={paused}
          pageRef={(node) => {
            if (node) nodes.current.set(index + 1, node);
            else nodes.current.delete(index + 1);
          }}
        />
      ))}
    </div>
  );
}

function LayoutPage({
  pdf,
  number,
  size,
  scale,
  host,
  theme,
  blocks,
  translations,
  documentId,
  renderBlock,
  pageRef,
  onRetry,
  onCitation,
  paused,
}: TranslationActions & {
  pdf: pdfjs.PDFDocumentProxy;
  number: number;
  size: PageSize;
  scale: number;
  host: RefObject<HTMLDivElement | null>;
  theme: ReaderTheme;
  blocks: PDFBlock[];
  translations: Map<string, TranslationBlock>;
  documentId: string;
  renderBlock: RenderBlock;
  pageRef: (node: HTMLDivElement | null) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const zoom = scale * (96 / 72);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: host.current, rootMargin: "100% 0px" },
    );
    observer.observe(frame.current!);
    return () => observer.disconnect();
  }, [host]);
  return (
    <div
      ref={(node) => {
        frame.current = node;
        pageRef(node);
      }}
      className="pdf-layout-page"
      data-page-number={number}
      data-page-width={size.width}
      aria-label={`译文第 ${number} 页`}
      style={{ width: size.width * zoom, height: size.height * zoom }}
    >
      <div
        className="pdf-layout-sheet"
        style={{
          width: size.width,
          height: size.height,
          transform: `scale(${zoom})`,
        }}
      >
        {visible ? (
          <PageSurface
            pdf={pdf}
            number={number}
            size={size}
            zoom={zoom}
            theme={theme}
            blocks={blocks}
            translations={translations}
            documentId={documentId}
            renderBlock={renderBlock}
            onRetry={onRetry}
            onCitation={onCitation}
            paused={paused}
          />
        ) : (
          blocks.map((block) => (
            <div
              key={block.id}
              className="pdf-layout-placeholder"
              data-translation-block={block.id}
              style={{
                left: block.bounds.x * size.width,
                top: block.bounds.y * size.height,
                width: block.bounds.width * size.width,
                height: block.bounds.height * size.height,
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PageSurface({
  pdf,
  number,
  size,
  zoom,
  theme,
  blocks,
  translations,
  documentId,
  renderBlock,
  onRetry,
  onCitation,
  paused,
}: TranslationActions & {
  pdf: pdfjs.PDFDocumentProxy;
  number: number;
  size: PageSize;
  zoom: number;
  theme: ReaderTheme;
  blocks: PDFBlock[];
  translations: Map<string, TranslationBlock>;
  documentId: string;
  renderBlock: RenderBlock;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [layouts, setLayouts] = useState<Map<string, PageBlockLayout>>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const blockKey = JSON.stringify(blocks);
  useEffect(() => {
    let stopped = false;
    let rendering: pdfjs.RenderTask | undefined;
    const target = canvas.current!;
    setLayouts(undefined);
    setError(false);
    const renderScale = Math.min(
      // Low-resolution antialiasing must not turn white paper into a gray field.
      Math.max(1.5, zoom * Math.min(window.devicePixelRatio || 1, 2)),
      Math.sqrt(4_000_000 / (size.width * size.height)),
      4096 / Math.max(size.width, size.height),
    );
    void (async () => {
      const page = await pdf.getPage(number);
      if (stopped) return;
      target.width = Math.ceil(size.width * renderScale);
      target.height = Math.ceil(size.height * renderScale);
      const context = target.getContext("2d", { willReadFrequently: true })!;
      rendering = page.render({
        canvas: target,
        canvasContext: context,
        viewport: page.getViewport({ scale: renderScale }),
        background: "#ffffff",
      });
      await rendering.promise;
      if (stopped) return;
      const next = await pageBlockLayouts(page, blocks, context, renderScale);
      if (stopped) return;
      const colors = pdfObjectColors(theme);
      if (colors) {
        rendering = page.render({
          canvas: target,
          canvasContext: context,
          viewport: page.getViewport({ scale: renderScale }),
          background: colors.background,
          pageColors: colors,
        });
        await rendering.promise;
      }
      if (!stopped) setLayouts(next);
    })().catch(() => {
      if (stopped) return;
      setError(true);
      reportDiagnostic({
        level: "error",
        event: "pdf.translation_layout.render_failed",
      });
    });
    return () => {
      stopped = true;
      rendering?.cancel();
      target.width = target.height = 0;
    };
  }, [
    pdf,
    number,
    size.width,
    size.height,
    zoom,
    theme.mode,
    theme.pdfDarkContrast,
    blockKey,
    retry,
  ]);
  return (
    <>
      <canvas ref={canvas} className="pdf-layout-canvas" aria-hidden="true" />
      {error && (
        <div className="pdf-layout-message" role="alert">
          本页显示失败{" "}
          <Button variant="outline" onClick={() => setRetry((v) => v + 1)}>
            重试
          </Button>
        </div>
      )}
      {blocks.map((block) => (
        <LayoutBlock
          key={block.id}
          block={block}
          layout={layouts?.get(block.id)}
          size={size}
          translation={translations.get(block.id)}
          documentId={documentId}
          renderBlock={renderBlock}
          onRetry={onRetry}
          onCitation={onCitation}
          paused={paused}
        />
      ))}
    </>
  );
}

function LayoutBlock({
  block,
  layout,
  size,
  translation,
  documentId,
  renderBlock,
  onRetry,
  onCitation,
  paused,
}: TranslationActions & {
  block: PDFBlock;
  layout?: PageBlockLayout;
  size: PageSize;
  translation?: TranslationBlock;
  documentId: string;
  renderBlock: RenderBlock;
}) {
  const body = useRef<HTMLDivElement>(null);
  const preserved =
    !!block.image ||
    preservedLabels.has(block.label) ||
    block.label === "algorithm";
  const caption =
    preserved &&
    !!block.caption?.trim() &&
    !["display_formula", "inline_formula"].includes(block.label);
  const sourceText = caption ? block.caption! : block.text;
  const [verified, setVerified] = useState<{ text: string; hash: string }>();
  const matches =
    verified?.text === sourceText && verified?.hash === translation?.sourceHash;
  const [fits, setFits] = useState<boolean>();
  const complete =
    translation?.status === "complete" && !!translation.sentences.length;
  useEffect(() => {
    let stopped = false;
    setVerified(undefined);
    if (complete)
      void matchesSource({ ...block, text: sourceText }, translation!)
        .then((value) => {
          if (!stopped && value)
            setVerified({ text: sourceText, hash: translation!.sourceHash });
        })
        .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [sourceText, translation?.sourceHash, complete]);
  useLayoutEffect(() => {
    const node = body.current;
    setFits(undefined);
    if (!node || !layout?.mask || !matches || !complete) return;
    let frame = 0;
    let stopped = false;
    const fit = () => {
      if (stopped) return;
      setFits(
        fitTranslatedElement(
          node,
          layout.box.width,
          layout.box.height,
          layout.fontSize,
          layout.lineHeight,
        ) !== null,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    const mutations = new MutationObserver(schedule);
    mutations.observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(node);
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    schedule();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [layout, matches, complete, translation]);
  const box = layout?.box ?? {
    x: block.bounds.x * size.width,
    y: block.bounds.y * size.height,
    width: block.bounds.width * size.width,
    height: block.bounds.height * size.height,
  };
  const covered = !preserved && !!layout?.mask && matches && fits === true;
  const reason = !complete
    ? "尚未完成翻译"
    : !matches
      ? "译文与原文不匹配"
      : preserved || !layout?.mask
        ? "此区域保留原版"
        : "译文超出原区域";
  return (
    <>
      {covered && (
        <div
          className="pdf-layout-mask"
          style={{
            left: layout!.mask!.x,
            top: layout!.mask!.y,
            width: layout!.mask!.width,
            height: layout!.mask!.height,
          }}
        />
      )}
      <div
        className="pdf-layout-block"
        data-covered={covered || undefined}
        data-layout-reason={layout?.reason}
        style={{
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
        }}
      >
        {preserved ? (
          renderBlock(block, null)
        ) : (
          <div
            ref={body}
            className="pdf-layout-body"
            style={{
              visibility: covered ? "visible" : "hidden",
              fontFamily:
                layout?.fontFamily === "monospace"
                  ? 'ui-monospace, "Songti SC", monospace'
                  : layout?.fontFamily === "sans-serif"
                    ? 'system-ui, "PingFang SC", sans-serif'
                    : translationFont("serif"),
              fontWeight: layout?.fontWeight ?? 400,
              textAlign: layout?.textAlign ?? "left",
            }}
          >
            {renderBlock(block)}
          </div>
        )}
        {!covered && layout && (!preserved || caption) && (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="pdf-layout-expand"
                  aria-label={`${reason}，查看第 ${block.page} 页段落译文`}
                />
              }
            >
              {caption ? "查看图注译文" : "查看译文"}
            </PopoverTrigger>
            <PopoverContent
              className="translation-popover pdf-layout-expanded"
              side="right"
            >
              <p className="text-muted-foreground text-xs">{reason}</p>
              {matches || !complete ? (
                <TranslationText
                  block={
                    caption
                      ? {
                          ...block,
                          label: "text",
                          image: undefined,
                          text: sourceText,
                        }
                      : block
                  }
                  translation={translation}
                  documentId={documentId}
                  retry={() => onRetry(block.id)}
                  onCitation={onCitation}
                  paused={paused}
                />
              ) : (
                <>
                  <p>原文内容已变化，请重新翻译此段。</p>
                  <Button variant="outline" onClick={() => onRetry(block.id)}>
                    重新翻译
                  </Button>
                </>
              )}
            </PopoverContent>
          </Popover>
        )}
      </div>
    </>
  );
}
