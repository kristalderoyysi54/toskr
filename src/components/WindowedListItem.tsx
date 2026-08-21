import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { observeRenderWindow } from "@/lib/viewportWindow";
import { useUIStore } from "@/store/uiStore";

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
  children,
}: {
  itemId: string;
  estimatedHeight: number;
  /** 每段最前面的少量条目首帧直出，避免等待 Observer 的空白闪烁。 */
  eager?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [insideRenderWindow, setInsideRenderWindow] = useState(
    () => eager || typeof IntersectionObserver === "undefined"
  );
  const [placeholderHeight, setPlaceholderHeight] = useState(estimatedHeight);
  const [uiActive, setUiActive] = useState(() => currentActiveIds().has(itemId));
  const mounted = eager || insideRenderWindow || uiActive;

  useEffect(
    () => watchItemActivity(itemId, () => setUiActive(currentActiveIds().has(itemId))),
    [itemId]
  );

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observeRenderWindow(element, setInsideRenderWindow);
  }, []);

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

  // 密度切换或详情收起后，屏外占位立即回到该形态的标准高度，避免滚动范围漂移。
  useEffect(() => {
    if (!mounted) setPlaceholderHeight(estimatedHeight);
  }, [estimatedHeight, mounted]);

  return (
    <div
      ref={ref}
      data-windowed-item={itemId}
      aria-hidden={mounted ? undefined : true}
      style={
        mounted
          ? { minHeight: estimatedHeight }
          : { height: placeholderHeight, minHeight: placeholderHeight }
      }
    >
      {mounted ? children : null}
    </div>
  );
}
