import { useCallback, useEffect, useRef } from "react";

/** 卡片在吸顶栏下沿起渐隐的距离（px） */
const FADE = 10;

function viewportOf(el: HTMLElement) {
  return el.closest<HTMLElement>("[data-slot=scroll-area-viewport]");
}

/**
 * 分组吸顶标题：栏本身保持透明（与毛玻璃底一致），内容区滚到栏下沿即渐隐，
 * 不与标题叠印。header 需带 `sticky top-0`，header 与 body 同属一个分组容器。
 * body 建议带 `-mx-1 -mb-1 px-1 pb-1`：遮罩只作用于盒内，外扩后焦点环/投影不被切。
 */
export function useStickyHeader(collapsed: boolean) {
  const header = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLElement | null>(null);
  const headerRef = useCallback((el: HTMLElement | null) => {
    header.current = el;
  }, []);
  const bodyRef = useCallback((el: HTMLElement | null) => {
    body.current = el;
  }, []);

  useEffect(() => {
    const h = header.current;
    const b = body.current;
    const viewport = h && viewportOf(h);
    if (!h || !b || !viewport) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const start = h.getBoundingClientRect().bottom - b.getBoundingClientRect().top;
      const mask =
        start + FADE > 0
          ? `linear-gradient(to bottom, transparent ${start}px, #000 ${start + FADE}px)`
          : "";
      b.style.maskImage = mask;
      b.style.webkitMaskImage = mask;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener("scroll", schedule, { passive: true });
    // 卡片窗口化挂载/展开会改变布局，也要重算遮罩位置
    const ro = new ResizeObserver(schedule);
    ro.observe(b);
    return () => {
      viewport.removeEventListener("scroll", schedule);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [collapsed]);

  /** 已吸顶（分组开头已滚出视口顶部）时滚回分组开头并返回 true；未吸顶返回 false */
  const scrollToStartIfStuck = useCallback(() => {
    const group = header.current?.parentElement;
    const viewport = group && viewportOf(group);
    if (!group || !viewport) return false;
    const offset = group.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    if (offset >= -1) return false;
    viewport.scrollBy({ top: offset, behavior: "smooth" });
    return true;
  }, []);

  return { headerRef, bodyRef, scrollToStartIfStuck };
}
