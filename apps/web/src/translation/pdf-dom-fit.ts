import { textSizeRange } from "./pdf-layout";

/** Reading at fit width punishes tiny body text, unlike a zoomable export. */
const readableFontSize = 9;

export type TextFit =
  { size: number } | { size: null; reason: "overflow" | "unreadable" };

/** Quarter-pixel steps that land exactly on each threshold. */
function nextSize(size: number, minimum: number, floor: number) {
  const limit = size > minimum ? minimum : floor;
  return Math.max(limit, size - 0.25);
}

/**
 * The largest readable size, or why the translation cannot be laid in the box.
 * No clipping or horizontal distortion: a failed fit leaves the content intact.
 */
export function fitTranslatedElement(
  element: HTMLElement,
  width: number,
  height: number,
  preferredSize: number,
  lineHeight: number,
): TextFit {
  const { maximum, minimum: floor } = textSizeRange(preferredSize);
  // Small print keeps its proportional headroom; body text stops at 9 px.
  const minimum =
    maximum >= readableFontSize ? Math.max(readableFontSize, floor) : floor;
  element.style.width = `${width}px`;
  element.style.lineHeight = String(Math.max(1.1, Math.min(1.6, lineHeight)));
  for (let size = maximum; ; size = nextSize(size, minimum, floor)) {
    element.style.fontSize = `${size}px`;
    if (
      element.scrollWidth <= Math.ceil(width) &&
      element.scrollHeight <= Math.floor(height)
    )
      return size >= minimum ? { size } : { size: null, reason: "unreadable" };
    if (size === floor) return { size: null, reason: "overflow" };
  }
}
