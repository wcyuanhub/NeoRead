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
import {
  api,
  publicationURL,
  type PDFTypesetStatus,
  type PDFTypesetPositions,
  type PDFTypesetPositionBlock,
} from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@neoread/ui/components/popover";
import type {
  PDFBlock,
  PDFPageViewport,
  ReaderTheme,
  TranslationBlock,
} from "@neoread/core";
import { pageViewport, followPageViewport } from "../readers/pdf-page-viewport";
import { pdfObjectColors } from "../readers/pdf-dark-mode";
import type { PDFLayoutHandle } from "./PDFLayoutPages";
import { reportDiagnostic } from "../diagnostics";
import {
  currentPosition,
  positionBounds,
  TypesetSentences,
  type TypesetBlockRenderer,
} from "./TypesetTextLayer";

const explanations: Record<string, string> = {
  runtime_missing:
    "PDF 排版组件未就绪，当前显示原文。可点击段落旁的「译文」查看已有译文。",
  translation_pending: "正在等待译文，当前显示原文。",
  offline_resource_missing: "排版资源不完整，请重新准备排版组件。",
  no_mapped_translation:
    "暂时无法生成译文页面，当前显示原文。可点击段落旁的「译文」查看已有译文。",
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
type Props = {
  documentId: string;
  revisionKey: string;
  theme: ReaderTheme;
  scale: number;
  host: RefObject<HTMLDivElement | null>;
  blocks: PDFBlock[];
  translations: Map<string, TranslationBlock>;
  renderBlock: TypesetBlockRenderer;
  onRetry: (blockId: string) => void;
  onCitation: (blockId: string, label: string) => void;
  onFollow: () => void;
  onReady: () => void;
  ref: Ref<PDFLayoutHandle>;
};

export function TypesetPDFPages({
  documentId,
  revisionKey,
  theme,
  scale,
  host,
  blocks,
  translations,
  renderBlock,
  onRetry,
  onCitation,
  onFollow,
  onReady,
  ref,
}: Props) {
  const [status, setStatus] = useState<PDFTypesetStatus>();
  const [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{
    pdf: pdfjs.PDFDocumentProxy;
    sizes: { width: number; height: number }[];
    positions: PDFTypesetPositions;
    generated: boolean;
  }>();
  const [expanded, setExpanded] = useState<string>();
  const nodes = useRef(new Map<number, HTMLDivElement>());
  const desired = useRef<PDFPageViewport | undefined>(undefined);
  const anchor = useRef<
    { blockId: string; sentence?: number; center?: boolean } | undefined
  >(undefined);
  const callbacks = useRef({ onFollow, onReady });
  callbacks.current = { onFollow, onReady };
  const follow = (viewport: PDFPageViewport) => {
    desired.current = viewport;
    anchor.current = undefined;
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
  const revealDetail = (node: HTMLElement, blockId: string) => {
    const requested = anchor.current;
    if (requested?.blockId !== blockId || requested.sentence === undefined)
      return;
    const sentence = node.querySelector(
      `[data-sentence="${requested.sentence}"]`,
    );
    if (!sentence) return;
    const range = document.createRange();
    range.selectNodeContents(sentence);
    node.scrollTop = Math.max(
      0,
      node.scrollTop +
        range.getBoundingClientRect().top -
        node.getBoundingClientRect().top -
        12,
    );
  };
  const focusBlock = (blockId: string, sentence?: number, center = true) => {
    anchor.current = { blockId, sentence, center };
    const section = Array.from(
      host.current?.querySelectorAll<HTMLElement>("[data-translation-block]") ??
        [],
    ).find((n) => n.dataset.translationBlock === blockId);
    const container = host.current;
    if (!container) return false;
    const block = blocks.find((b) => b.id === blockId);
    const detail = section?.closest(".pdf-typeset-detail");
    const needsDetail = !section || !!detail;
    if (needsDetail && (!block || !loaded || !translations.has(blockId)))
      return false;
    if (needsDetail) setExpanded(blockId);
    const target =
      sentence === undefined
        ? section
        : section?.querySelector<HTMLElement>(`[data-sentence="${sentence}"]`);
    let rect = section?.getBoundingClientRect();
    if (needsDetail && block) {
      const page = nodes.current.get(block.page)?.getBoundingClientRect();
      if (!page) return false;
      const b = block.bounds;
      rect = new DOMRect(
        page.left + b.x * page.width,
        page.top + b.y * page.height,
        b.width * page.width,
        b.height * page.height,
      );
      if (detail instanceof HTMLElement) revealDetail(detail, blockId);
    } else if (target && target.textContent) {
      const range = document.createRange();
      range.selectNodeContents(target);
      rect = range.getBoundingClientRect();
    } else if (sentence !== undefined) {
      const position = loaded?.positions.blocks.find(
        (p) => p.blockId === blockId,
      );
      if (
        block &&
        currentPosition(position, block, translations.get(blockId)) &&
        position?.sentences[sentence]
      ) {
        const b = positionBounds(position, sentence),
          page = nodes.current.get(position.page)?.getBoundingClientRect();
        if (page)
          rect = new DOMRect(
            page.left + b.x * page.width,
            page.top + b.y * page.height,
            b.width * page.width,
            b.height * page.height,
          );
      }
    }
    if (!rect) return false;
    callbacks.current.onFollow();
    const view = container.getBoundingClientRect();
    container.scrollTop +=
      rect.top -
      view.top -
      (center
        ? Math.max(0, (view.height - rect.height) / 2)
        : view.height * 0.25);
    if (rect.left < view.left || rect.right > view.right)
      container.scrollLeft +=
        rect.left - view.left - Math.max(0, (view.width - rect.width) / 2);
    return true;
  };
  useImperativeHandle(ref, () => ({
    follow,
    getViewport,
    focusBlock,
    goTo: (location) => {
      if (
        location.translation &&
        focusBlock(
          location.translation.blockId,
          location.translation.sentenceIndexes[0],
        )
      )
        return;
      follow({
        page: location.page,
        x: location.x ?? 0,
        y: location.y ?? 0,
        scale,
      });
    },
  }));
  useEffect(() => {
    anchor.current = undefined;
    desired.current = undefined;
    setExpanded(undefined);
  }, [documentId]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setStatus(undefined);
    setFailed(false);
    const poll = async (start: boolean) => {
      try {
        const next = await api.pdfTypeset(documentId, start, controller.signal);
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
      controller.abort();
      clearTimeout(timer);
    };
  }, [documentId, revisionKey, retry]);
  const revision = status?.status === "complete" ? status.revision : undefined;
  const resource = status ? revision || "original" : undefined;
  useEffect(() => {
    setLoaded(undefined);
    if (!resource) return;
    let stopped = false;
    const controller = new AbortController();
    const task = pdfjs.getDocument({
      url: publicationURL(
        documentId,
        revision ? `typeset/${revision}.pdf` : "original.pdf",
      ),
      cMapUrl: "/pdf-assets/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdf-assets/standard_fonts/",
      wasmUrl: "/pdf-assets/wasm/",
    });
    void (async () => {
      const [pdf, positions] = await Promise.all([
        task.promise,
        revision
          ? api.pdfTypesetPositions(documentId, revision, controller.signal)
          : Promise.resolve({
              version: 1,
              revision: "",
              blocks: [],
            } as PDFTypesetPositions),
      ]);
      if (
        positions.version !== 1 ||
        (revision && positions.revision !== revision)
      )
        throw new Error("invalid positions");
      const sizes = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        if (stopped) return;
        const { width, height } = (await pdf.getPage(number)).getViewport({
          scale: 1,
        });
        sizes.push({ width, height });
      }
      if (!stopped) setLoaded({ pdf, sizes, positions, generated: !!revision });
    })().catch(() => {
      if (!stopped) {
        setFailed(true);
        reportDiagnostic({ level: "error", event: "pdf.typeset.load_failed" });
      }
    });
    return () => {
      stopped = true;
      controller.abort();
      void task.destroy();
    };
  }, [documentId, resource]);
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (loaded) {
      callbacks.current.onReady();
      if (saved) focusBlock(saved.blockId, saved.sentence, saved.center);
      else if (desired.current) follow(desired.current);
    }
  }, [loaded, scale]);
  useEffect(() => {
    const node = host.current;
    const remember = () => {
      desired.current = getViewport();
      const view = node?.getBoundingClientRect();
      if (!view) return;
      const sections = Array.from(
        node!.querySelectorAll<HTMLElement>("[data-translation-block]"),
      );
      const section = sections
        .filter((s) => {
          const r = s.getBoundingClientRect();
          return (
            !s.closest(".pdf-typeset-detail") &&
            r.bottom > view.top &&
            r.top < view.bottom
          );
        })
        .sort(
          (a, b) =>
            Math.abs(a.getBoundingClientRect().top - view.top) -
            Math.abs(b.getBoundingClientRect().top - view.top),
        )[0];
      if (section)
        anchor.current = {
          blockId: section.dataset.translationBlock!,
          center: false,
        };
    };
    node?.addEventListener("scroll", remember);
    return () => node?.removeEventListener("scroll", remember);
  }, [loaded, scale]);
  const error =
    failed || status?.status === "failed" || status?.status === "unavailable";
  const message = failed
    ? "译文排版加载失败，请重试。"
    : (explanations[status?.reason ?? ""] ??
      (status?.status === "failed"
        ? "译文排版失败，当前显示原文。可点击段落旁的「译文」查看已有译文。"
        : status?.status === "complete"
          ? "正在加载译文页面…"
          : status?.status === "waiting"
            ? "正在等待译文，当前显示原文。"
            : `${phases[status?.phase ?? ""] ?? "正在生成译文排版…"}当前显示原文。`));
  const statusMessage = (
    <div className="pdf-typeset-status" role={error ? "alert" : "status"}>
      <span>{message}</span>
      {error && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRetry((v) => v + 1)}
        >
          重试排版
        </Button>
      )}
    </div>
  );
  if (!loaded)
    return <div className="pdf-typeset-pending">{statusMessage}</div>;
  const positions = new Map(loaded.positions.blocks.map((p) => [p.blockId, p]));
  return (
    <div className="pdf-layout-pages pdf-typeset-pages">
      {!loaded.generated && statusMessage}
      {loaded.sizes.map((size, index) => {
        const pageBlocks = blocks.filter((b) => b.page === index + 1);
        const mapped = pageBlocks.flatMap((block) => {
          const position = currentPosition(
            positions.get(block.id),
            block,
            translations.get(block.id),
          );
          return position ? [{ block, position }] : [];
        });
        const mappedIds = new Set(mapped.map((m) => m.block.id));
        const fallback = pageBlocks.filter(
          (b) =>
            !mappedIds.has(b.id) &&
            (translations.has(b.id) ||
              ["display_formula", "inline_formula"].includes(b.label)),
        );
        return (
          <div key={index} className="pdf-typeset-page-group">
            <TypesetPage
              pdf={loaded.pdf}
              number={index + 1}
              size={size}
              scale={scale}
              host={host}
              theme={theme}
              mapped={mapped}
              renderBlock={renderBlock}
              onRetry={onRetry}
              onCitation={onCitation}
              fallback={fallback}
              expanded={expanded}
              onExpand={setExpanded}
              onDetailReady={revealDetail}
              pageRef={(node) => {
                if (node) nodes.current.set(index + 1, node);
                else nodes.current.delete(index + 1);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

type Mapped = { block: PDFBlock; position: PDFTypesetPositionBlock };
function TypesetPage({
  pdf,
  number,
  size,
  scale,
  host,
  theme,
  mapped,
  renderBlock,
  onRetry,
  onCitation,
  onExpand,
  fallback,
  expanded,
  onDetailReady,
  pageRef,
}: {
  pdf: pdfjs.PDFDocumentProxy;
  number: number;
  size: { width: number; height: number };
  scale: number;
  host: RefObject<HTMLDivElement | null>;
  theme: ReaderTheme;
  mapped: Mapped[];
  renderBlock: TypesetBlockRenderer;
  onRetry: (blockId: string) => void;
  onCitation: (blockId: string, label: string) => void;
  onExpand: (blockId: string | undefined) => void;
  fallback: PDFBlock[];
  expanded?: string;
  onDetailReady: (node: HTMLElement, blockId: string) => void;
  pageRef: (node: HTMLDivElement | null) => void;
}) {
  const frame = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0);
  const zoom = (scale * 96) / 72;
  const mappingKey = JSON.stringify(mapped.map((m) => m.position));
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
    let render: pdfjs.RenderTask | undefined,
      layer: pdfjs.TextLayer | undefined;
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
      const normal = page.getViewport({ scale: 1 }),
        bounds = mapped.map((m) => positionBounds(m.position));
      // Keep original/reference text selectable without duplicating mapped prose.
      const items = content.items.filter((item) => {
        if (!("str" in item)) return true;
        const [x, y] = normal.convertToViewportPoint(
          item.transform[4] + item.width / 2,
          item.transform[5] + item.height / 2,
        );
        return !bounds.some(
          (b) =>
            x >= b.x * size.width - 2 &&
            x <= (b.x + b.width) * size.width + 2 &&
            y >= b.y * size.height - 2 &&
            y <= (b.y + b.height) * size.height + 2,
        );
      });
      layer = new pdfjs.TextLayer({
        textContentSource: { ...content, items },
        container,
        viewport: page.getViewport({ scale: zoom }),
      });
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
  }, [
    pdf,
    number,
    visible,
    zoom,
    theme.mode,
    theme.pdfDarkContrast,
    retry,
    mappingKey,
  ]);
  const width = size.width * zoom,
    height = size.height * zoom;
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
          width,
          height,
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
          <div ref={text} className="textLayer" data-typeset-original="" />
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
      {mapped.map(({ block, position }) => {
        const b = positionBounds(position);
        return (
          <div
            key={block.id}
            className="pdf-typeset-block"
            style={{
              left: b.x * width,
              top: b.y * height,
              width: b.width * width,
              height: b.height * height,
            }}
          >
            {expanded !== block.id &&
              renderBlock(
                block,
                visible ? (
                  <TypesetSentences
                    position={position}
                    bounds={b}
                    width={width}
                    height={height}
                    onCitation={onCitation}
                  />
                ) : null,
                {
                  className: "pdf-typeset-text",
                  style: { width: "100%", height: "100%" },
                },
              )}
            <div className="pdf-typeset-actions" data-block-action>
              <TypesetDetail
                block={block}
                open={expanded === block.id}
                onOpenChange={onExpand}
                host={host}
                renderBlock={renderBlock}
                onRetry={onRetry}
                onReady={onDetailReady}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onRetry(block.id)}
              >
                重译
              </Button>
            </div>
          </div>
        );
      })}
      {fallback.map((block) => (
        <div
          key={block.id}
          className="pdf-typeset-unmapped"
          data-typeset-block={block.id}
          style={{
            left: Math.min(0.94, block.bounds.x + block.bounds.width) * width,
            top: block.bounds.y * height,
          }}
        >
          <TypesetDetail
            block={block}
            open={expanded === block.id}
            onOpenChange={onExpand}
            host={host}
            renderBlock={renderBlock}
            onRetry={onRetry}
            onReady={onDetailReady}
            unmapped
          />
        </div>
      ))}
    </div>
  );
}

function TypesetDetail({
  block,
  open,
  onOpenChange,
  host,
  renderBlock,
  onRetry,
  onReady,
  unmapped = false,
}: {
  block: PDFBlock;
  open: boolean;
  onOpenChange: (id: string | undefined) => void;
  host: RefObject<HTMLDivElement | null>;
  renderBlock: TypesetBlockRenderer;
  onRetry: (id: string) => void;
  onReady: (node: HTMLElement, blockId: string) => void;
  unmapped?: boolean;
}) {
  return (
    <Popover
      open={open}
      onOpenChange={(value) => onOpenChange(value ? block.id : undefined)}
    >
      <PopoverTrigger
        render={
          <Button
            variant="secondary"
            size="sm"
            data-block-action
            aria-label={`查看第 ${block.page} 页段落完整译文`}
          />
        }
      >
        {unmapped ? "译文" : "完整译文"}
      </PopoverTrigger>
      <PopoverContent
        ref={(node) => {
          if (node) onReady(node, block.id);
        }}
        portalContainer={host}
        collisionBoundary={host.current ?? undefined}
        positionMethod="fixed"
        className="pdf-typeset-detail"
        side="left"
        align="start"
        initialFocus={false}
        finalFocus={false}
        style={{
          width: Math.max(
            160,
            Math.min(520, (host.current?.clientWidth || 552) - 32),
          ),
        }}
      >
        {open && renderBlock(block)}
        <Button
          variant="ghost"
          size="sm"
          data-block-action
          onClick={() => onRetry(block.id)}
        >
          重新翻译此段
        </Button>
      </PopoverContent>
    </Popover>
  );
}
