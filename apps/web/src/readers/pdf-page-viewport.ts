import type { PDFPageViewport } from "@neoread/core";

export function pageViewport(
  host: HTMLElement,
  pages: HTMLElement[],
  scale: number,
): PDFPageViewport | undefined {
  const view = host.getBoundingClientRect();
  const page =
    pages.find((node) => node.getBoundingClientRect().bottom > view.top + 1) ??
    pages.at(-1);
  if (!page) return;
  const rect = page.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  return {
    page: Number(page.dataset.pageNumber),
    x: (view.left - rect.left) / rect.width,
    y: (view.top - rect.top) / rect.height,
    scale,
  };
}

export function followPageViewport(
  host: HTMLElement,
  page: HTMLElement,
  viewport: PDFPageViewport,
) {
  const view = host.getBoundingClientRect();
  const rect = page.getBoundingClientRect();
  const top = host.scrollTop + rect.top - view.top + viewport.y * rect.height;
  const left =
    host.scrollLeft + rect.left - view.left + viewport.x * rect.width;
  if (Math.abs(host.scrollTop - top) > 0.5) host.scrollTop = top;
  if (Math.abs(host.scrollLeft - left) > 0.5) host.scrollLeft = left;
}
