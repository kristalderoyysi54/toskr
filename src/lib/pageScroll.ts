const PAGE_SCROLL_TARGET_SELECTOR =
  '[data-slot="scroll-area-viewport"], [data-strip-scroller]';

/**
 * 把常驻滑层内的真实列表视口移回起点。竖面板回顶部，横栏回最左；
 * Root 自身不滚动，不能把 scrollTo 误发给 PageSlide 或 window。
 */
export function scrollPageToStart(
  pageRoot: ParentNode | null,
  reduceMotion: boolean
): boolean {
  const viewport = pageRoot?.querySelector<HTMLElement>(
    PAGE_SCROLL_TARGET_SELECTOR
  );
  if (!viewport) return false;
  viewport.scrollTo({
    top: 0,
    left: 0,
    behavior: reduceMotion ? "auto" : "smooth",
  });
  return true;
}
