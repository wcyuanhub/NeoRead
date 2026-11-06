// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { followPageViewport, pageViewport } from "./pdf-page-viewport";

function createHost() {
  const host = document.createElement("div");
  host.getBoundingClientRect = () => new DOMRect(100, 200, 600, 400);
  return host;
}

function createPage(number: number, rect: DOMRect) {
  const page = document.createElement("div");
  page.dataset.pageNumber = String(number);
  page.getBoundingClientRect = () => rect;
  return page;
}

// Explicit content coordinates make scrolling affect geometry without jsdom layout.
function createPane(left: number, top: number, width: number, height: number) {
  const host = createHost();
  const page = createPage(3, new DOMRect());
  page.getBoundingClientRect = () => {
    const view = host.getBoundingClientRect();
    return new DOMRect(
      view.left + left - host.scrollLeft,
      view.top + top - host.scrollTop,
      width,
      height,
    );
  };
  host.append(page);
  return { host, page };
}

describe("pageViewport", () => {
  it.each([
    { left: -100, top: -200, x: 0.5, y: 0.5 },
    { left: 160, top: 260, x: -0.15, y: -0.075 },
  ])("preserves signed page-edge offsets: $x, $y", ({ left, top, x, y }) => {
    const host = createHost();
    const page = createPage(7, new DOMRect(left, top, 400, 800));
    expect(pageViewport(host, [page], 1.75)).toEqual({
      page: 7,
      x,
      y,
      scale: 1.75,
    });
  });

  it("selects the first visible page, not the page with the largest visible area", () => {
    const host = createHost();
    const pages = [
      createPage(2, new DOMRect(100, -700, 400, 800)),
      createPage(5, new DOMRect(100, -598, 400, 800)),
      createPage(9, new DOMRect(100, 220, 400, 800)),
    ];
    expect(pageViewport(host, pages, 2)).toEqual({
      page: 5,
      x: 0,
      y: 798 / 800,
      scale: 2,
    });
  });

  it.each([
    { remaining: 0.999, selected: 2 },
    { remaining: 1, selected: 2 },
    { remaining: 1.001, selected: 1 },
  ])(
    "requires more than one pixel below the host's top ($remaining px)",
    ({ remaining, selected }) => {
      const host = createHost();
      const pages = [
        createPage(1, new DOMRect(100, 200 + remaining - 800, 400, 800)),
        createPage(2, new DOMRect(100, 240, 400, 800)),
      ];
      expect(pageViewport(host, pages, 1)?.page).toBe(selected);
    },
  );

  it("falls back to the last page after all pages and does not clamp offsets to one", () => {
    const host = createHost();
    const pages = [
      createPage(3, new DOMRect(-500, -1500, 400, 800)),
      createPage(8, new DOMRect(-500, -700, 400, 800)),
    ];
    expect(pageViewport(host, pages, 0.75)).toEqual({
      page: 8,
      x: 1.5,
      y: 1.125,
      scale: 0.75,
    });
  });

  it("returns undefined for an empty page list", () => {
    expect(pageViewport(createHost(), [], 1)).toBeUndefined();
  });

  it.each([
    { width: 0, height: 800 },
    { width: 400, height: 0 },
    { width: 0, height: 0 },
  ])("ignores an unmeasurable page ($width × $height)", ({ width, height }) => {
    const page = createPage(1, new DOMRect(100, 240, width, height));
    expect(pageViewport(createHost(), [page], 1)).toBeUndefined();
  });
});

describe("followPageViewport", () => {
  it.each([
    {
      label: "inside-page offsets",
      sourceLeft: 200,
      sourceTop: 420,
      targetLeft: 390,
      targetTop: 1500,
      backLeft: 210,
      backTop: 1320,
      restoredLeft: 110,
      restoredTop: 330,
    },
    {
      label: "negative page-margin offsets",
      sourceLeft: 40,
      sourceTop: 60,
      targetLeft: 70,
      targetTop: 780,
      backLeft: 40,
      backTop: 720,
      restoredLeft: 25,
      restoredTop: 30,
    },
  ])(
    "restores both axes between differently scaled panes: $label",
    (sample) => {
      const source = createPane(80, 120, 400, 600);
      const target = createPane(150, 900, 800, 1200);
      source.host.scrollLeft = sample.sourceLeft;
      source.host.scrollTop = sample.sourceTop;
      target.host.scrollLeft = 40;
      target.host.scrollTop = 100;

      const original = pageViewport(source.host, [source.page], 1)!;
      followPageViewport(target.host, target.page, original);
      expect(target.host.scrollLeft).toBeCloseTo(sample.targetLeft);
      expect(target.host.scrollTop).toBeCloseTo(sample.targetTop);
      const followed = pageViewport(target.host, [target.page], 2)!;
      expect(followed.page).toBe(original.page);
      expect(followed.x).toBeCloseTo(original.x);
      expect(followed.y).toBeCloseTo(original.y);
      expect(followed.scale).toBe(2);

      // Reverse the follower direction after the translated pane is scrolled.
      target.host.scrollLeft = sample.backLeft;
      target.host.scrollTop = sample.backTop;
      const reverse = pageViewport(target.host, [target.page], 2)!;
      followPageViewport(source.host, source.page, reverse);
      expect(source.host.scrollLeft).toBeCloseTo(sample.restoredLeft);
      expect(source.host.scrollTop).toBeCloseTo(sample.restoredTop);
      const restored = pageViewport(source.host, [source.page], 1)!;
      expect(restored.x).toBeCloseTo(reverse.x);
      expect(restored.y).toBeCloseTo(reverse.y);
    },
  );

  it.each([
    { dx: 0, dy: 0, writesX: 0, writesY: 0 },
    { dx: 0.4999, dy: -0.4999, writesX: 0, writesY: 0 },
    { dx: 0.5, dy: -0.5, writesX: 0, writesY: 0 },
    { dx: -0.5, dy: 0.5, writesX: 0, writesY: 0 },
    { dx: 0.5001, dy: -0.5001, writesX: 1, writesY: 1 },
    { dx: -0.5001, dy: 0.5001, writesX: 1, writesY: 1 },
    { dx: 0.5001, dy: 0.5, writesX: 1, writesY: 0 },
    { dx: -0.5, dy: -0.5001, writesX: 0, writesY: 1 },
  ])(
    "writes each axis only for a delta strictly larger than 0.5 px ($dx, $dy)",
    ({ dx, dy, writesX, writesY }) => {
      const { host, page } = createPane(50, 100, 400, 800);
      let left = 50;
      let top = 100;
      const setLeft = vi.fn((value: number) => {
        left = value;
      });
      const setTop = vi.fn((value: number) => {
        top = value;
      });
      Object.defineProperties(host, {
        scrollLeft: { get: () => left, set: setLeft },
        scrollTop: { get: () => top, set: setTop },
      });
      const viewport = { page: 3, x: dx / 400, y: dy / 800, scale: 2 };

      followPageViewport(host, page, viewport);
      expect(setLeft).toHaveBeenCalledTimes(writesX);
      expect(setTop).toHaveBeenCalledTimes(writesY);
      expect(host.scrollLeft).toBeCloseTo(50 + (writesX ? dx : 0));
      expect(host.scrollTop).toBeCloseTo(100 + (writesY ? dy : 0));

      // Replaying the same anchor must not cause scroll-feedback writes.
      followPageViewport(host, page, viewport);
      expect(setLeft).toHaveBeenCalledTimes(writesX);
      expect(setTop).toHaveBeenCalledTimes(writesY);
    },
  );
});
