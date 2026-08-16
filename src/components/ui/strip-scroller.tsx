import { useEffect, useRef } from "react";

/** 横栏滚动容器：细滚动条 + 纵向滚轮转横向滑动（Paste 手感）。 */
export function StripScroller({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div
      ref={ref}
      data-strip-scroller
      className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden"
    >
      {children}
    </div>
  );
}
