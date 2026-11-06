import { textSizeRange } from "./pdf-layout";

export function fitTranslatedElement(
  element: HTMLElement,
  width: number,
  height: number,
  preferredSize: number,
  lineHeight: number,
) {
  const { maximum, minimum } = textSizeRange(preferredSize);
  element.style.width = `${width}px`;
  element.style.lineHeight = String(Math.max(1.1, Math.min(1.6, lineHeight)));
  for (let size = maximum; ; size = Math.max(minimum, size - 0.25)) {
    element.style.fontSize = `${size}px`;
    if (
      element.scrollWidth <= Math.ceil(width) &&
      element.scrollHeight <= Math.floor(height)
    )
      return size;
    if (size === minimum) break;
  }
  return null;
}
