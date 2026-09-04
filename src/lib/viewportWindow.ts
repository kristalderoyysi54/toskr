type Listener = (insideRenderWindow: boolean) => void;

interface RootObserver {
  observer: IntersectionObserver;
  subscriptions: Map<Element, Set<Listener>>;
  pendingLeaves: Set<Element>;
  dispose: () => void;
}

const roots = new Map<Element | null, Map<string, RootObserver>>();
const DEFAULT_RENDER_MARGIN_PX = 240;

function scrollRoot(target: Element): Element | null {
  return typeof target.closest === "function"
    ? target.closest("[data-radix-scroll-area-viewport]")
    : null;
}

function rootObserver(
  root: Element | null,
  renderMarginPx: number,
  scrollIdleUnmountMs: number
): RootObserver {
  const observers = roots.get(root) ?? new Map<string, RootObserver>();
  const observerKey = `${renderMarginPx}:${scrollIdleUnmountMs}`;
  const existing = observers.get(observerKey);
  if (existing) return existing;

  const subscriptions = new Map<Element, Set<Listener>>();
  const pendingLeaves = new Set<Element>();
  const scrollTarget: EventTarget | null =
    root ?? (typeof window === "undefined" ? null : window);
  const canWatchScroll =
    scrollIdleUnmountMs > 0 &&
    typeof scrollTarget?.addEventListener === "function";
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  const flushLeaves = () => {
    releaseTimer = null;
    for (const target of pendingLeaves) {
      for (const callback of subscriptions.get(target) ?? []) callback(false);
    }
    pendingLeaves.clear();
  };
  const scheduleLeaves = () => {
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(flushLeaves, scrollIdleUnmountMs);
  };
  const handleScroll = () => {
    if (pendingLeaves.size > 0) scheduleLeaves();
  };
  if (canWatchScroll) {
    scrollTarget?.addEventListener("scroll", handleScroll, { passive: true });
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const callbacks = subscriptions.get(entry.target);
        if (!callbacks) continue;
        if (entry.isIntersecting) {
          pendingLeaves.delete(entry.target);
          for (const callback of callbacks) callback(true);
        } else if (scrollIdleUnmountMs > 0) {
          pendingLeaves.add(entry.target);
          scheduleLeaves();
        } else {
          for (const callback of callbacks) callback(false);
        }
      }
    },
    { root, rootMargin: `${renderMarginPx}px 0px` }
  );
  const state = {
    observer,
    subscriptions,
    pendingLeaves,
    dispose: () => {
      if (releaseTimer) clearTimeout(releaseTimer);
      if (canWatchScroll) {
        scrollTarget?.removeEventListener("scroll", handleScroll);
      }
      observer.disconnect();
    },
  };
  observers.set(observerKey, state);
  roots.set(root, observers);
  return state;
}

/**
 * 长列表按 ScrollArea + 预加载距离共用观察器。默认 240px 控制重卡片成本；
 * 快速滚动页面可单独扩大距离，离窗后仍只留等高占位壳。
 */
export function observeRenderWindow(
  target: Element,
  onChange: Listener,
  renderMarginPx = DEFAULT_RENDER_MARGIN_PX,
  scrollIdleUnmountMs = 0
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true);
    return () => {};
  }

  const root = scrollRoot(target);
  const normalizedMarginPx = Math.max(0, Math.round(renderMarginPx));
  const normalizedUnmountMs = Math.max(0, Math.round(scrollIdleUnmountMs));
  const observerKey = `${normalizedMarginPx}:${normalizedUnmountMs}`;
  const state = rootObserver(root, normalizedMarginPx, normalizedUnmountMs);
  const callbacks = state.subscriptions.get(target) ?? new Set();
  callbacks.add(onChange);
  state.subscriptions.set(target, callbacks);
  if (callbacks.size === 1) state.observer.observe(target);

  return () => {
    const current = state.subscriptions.get(target);
    current?.delete(onChange);
    if (current?.size === 0) {
      state.subscriptions.delete(target);
      state.pendingLeaves.delete(target);
      state.observer.unobserve(target);
    }
    if (state.subscriptions.size === 0) {
      state.dispose();
      const observers = roots.get(root);
      observers?.delete(observerKey);
      if (observers?.size === 0) roots.delete(root);
    }
  };
}
