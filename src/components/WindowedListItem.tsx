import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { observeRenderWindow } from "@/lib/viewportWindow";
import { useUIStore } from "@/store/uiStore";
import { shouldResetPlaceholderHeight } from "@/components/windowedListHeight";

const activityListeners = new Map<string, Set<() => void>>();
let activeItemIds = new Set<string>();
let stopActivityWatch: (() => void) | null = null;

function currentActiveIds(): Set<string> {
  const { focusedId, editingId } = useUIStore.getState();
  return new Set([focusedId, editingId].filter((id): id is string => !!id));
}

function watchItemActivity(itemId: string, notify: () => void): () => void {
  if (!stopActivityWatch) {
    activeItemIds = currentActiveIds();
    stopActivityWatch = useUIStore.subscribe(() => {
      const next = currentActiveIds();
      const changed = new Set([...activeItemIds, ...next]);
      const previous = activeItemIds;
      activeItemIds = next;
      for (const id of changed) {
        if (previous.has(id) === next.has(id)) continue;
        for (const listener of activityListeners.get(id) ?? []) listener();
      }
    });
  }
  const listeners = activityListeners.get(itemId) ?? new Set();
  listeners.add(notify);
  activityListeners.set(itemId, listeners);
  notify();
  return () => {
    const current = activityListeners.get(itemId);
    current?.delete(notify);
    if (current?.size === 0) activityListeners.delete(itemId);
    if (activityListeners.size === 0) {
      stopActivityWatch?.();
      stopActivityWatch = null;
      activeItemIds = new Set();
    }
  };
}

/**
 * DnD 列表的轻量窗口壳：始终保留稳定顺序/滚动高度，近视口才挂重卡片。
 * 聚焦或编辑中的条目强制挂载，保证全局键盘定位能先建 DOM 再 scrollIntoView。
 */
export function WindowedListItem({
  itemId,
  estimatedHeight,
  eager = false,
  renderMarginPx,
  scrollIdleUnmountMs,
  children,
}: {
  itemId: string;
  estimatedHeight: number;
  /** 每段最前面的少量条目首帧直出，避免等待 Observer 的空白闪烁。 */
  eager?: boolean;
  /** 预挂载距离；默认 240px，快速滚动页面可按自身卡片成本扩大。 */
  renderMarginPx?: number;
  /** 滚动停止后再卸载离窗内容；默认立即卸载。 */
  scrollIdleUnmountMs?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [insideRenderWindow, setInsideRenderWindow] = useState(
    () => eager || typeof IntersectionObserver === "undefined"
  );
  const [placeholderHeight, setPlaceholderHeight] = useState(estimatedHeight);
  const previousEstimatedHeightRef = useRef(estimatedHeight);
  const [uiActive, setUiActive] = useState(() => currentActiveIds().has(itemId));
  const mounted = eager || insideRenderWindow || uiActive;

  useEffect(
    () => watchItemActivity(itemId, () => setUiActive(currentActiveIds().has(itemId))),
    [itemId]
  );

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observeRenderWindow(
      element,
      setInsideRenderWindow,
      renderMarginPx,
      scrollIdleUnmountMs
    );
  }, [renderMarginPx, scrollIdleUnmountMs]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!mounted || !element) return;
    const measure = () => {
      const height = element.getBoundingClientRect().height;
      if (height > 0) {
        setPlaceholderHeight((current) =>
          Math.abs(current - height) > 0.5 ? height : current
        );
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [mounted]);

  // 离开渲染窗时保留最后实测高度；若立刻退回估算值，短卡会在真实高度与
  // 估算高度间往返，触发浏览器滚动锚定并造成快速滑动时整列上下抖动。
  // 只有密度等外部形态确实改变 estimatedHeight，且条目已经屏外时才重置。
  useEffect(() => {
    const previousEstimatedHeight = previousEstimatedHeightRef.current;
    previousEstimatedHeightRef.current = estimatedHeight;
    if (
      shouldResetPlaceholderHeight(
        previousEstimatedHeight,
        estimatedHeight,
        mounted
      )
    ) {
      setPlaceholderHeight(estimatedHeight);
    }
  }, [estimatedHeight, mounted]);

  return (
    <div
      ref={ref}
      data-windowed-item={itemId}
      aria-hidden={mounted ? undefined : true}
      style={
        // 挂载的条目按内容自然高度：estimatedHeight 只是屏外占位的估算，
        // 拿它当 minHeight 会把真实高度小于估算值的卡（典型是短消息卡，
        // estimatedHeight=160 但内容仅 ~70px）撑出大片留白。屏外占位仍用
        // （测量后的）placeholderHeight 稳住滚动高度，不影响挂载卡的真实高度。
        mounted
          ? undefined
          : { height: placeholderHeight, minHeight: placeholderHeight }
      }
    >
      {mounted ? children : null}
    </div>
  );
}
