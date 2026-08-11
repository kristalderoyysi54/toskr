import { describe, expect, it, vi } from "vitest";

import { scrollPageToStart } from "@/lib/pageScroll";

function pageRootWith(
  viewport: { scrollTo: (options: ScrollToOptions) => void } | null
) {
  return {
    querySelector: vi.fn(() => viewport),
  } as unknown as ParentNode;
}

describe("pageScroll", () => {
  it("双击页签时把竖向与横向位置平滑移回列表起点", () => {
    const scrollTo = vi.fn();
    const root = pageRootWith({ scrollTo });

    expect(scrollPageToStart(root, false)).toBe(true);
    expect(root.querySelector).toHaveBeenCalledWith(
      '[data-slot="scroll-area-viewport"], [data-strip-scroller]'
    );
    expect(scrollTo).toHaveBeenCalledWith({
      top: 0,
      left: 0,
      behavior: "smooth",
    });
  });

  it("Reduce Motion 下立即回到起点，缺少列表视口时安全忽略", () => {
    const scrollTo = vi.fn();
    expect(scrollPageToStart(pageRootWith({ scrollTo }), true)).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({
      top: 0,
      left: 0,
      behavior: "auto",
    });
    expect(scrollPageToStart(pageRootWith(null), false)).toBe(false);
    expect(scrollPageToStart(null, false)).toBe(false);
  });
});
