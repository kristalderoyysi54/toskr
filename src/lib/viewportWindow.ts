type Listener = (insideRenderWindow: boolean) => void;

interface RootObserver {
  observer: IntersectionObserver;
  subscriptions: Map<Element, Set<Listener>>;
}

const roots = new Map<Element | null, RootObserver>();

function scrollRoot(target: Element): Element | null {
  return typeof target.closest === "function"
    ? target.closest("[data-radix-scroll-area-viewport]")
    : null;
}

function rootObserver(root: Element | null): RootObserver {
  const existing = roots.get(root);
  if (existing) return existing;

  const subscriptions = new Map<Element, Set<Listener>>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const callbacks = subscriptions.get(entry.target);
        if (!callbacks) continue;
        for (const callback of callbacks) callback(entry.isIntersecting);
      }
    },
    { root, rootMargin: "240px 0px" }
  );
  const state = { observer, subscriptions };
  roots.set(root, state);
  return state;
}

/**
 * 长列表按各自 ScrollArea 共用观察器。240px overscan 提前挂约半屏；更大的
 * 缓冲会在快速滚动时成批挂卸重卡片，反而掉帧。离窗后只留等高占位壳。
 */
export function observeRenderWindow(
  target: Element,
  onChange: Listener
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true);
    return () => {};
  }

  const root = scrollRoot(target);
  const state = rootObserver(root);
  const callbacks = state.subscriptions.get(target) ?? new Set();
  callbacks.add(onChange);
  state.subscriptions.set(target, callbacks);
  if (callbacks.size === 1) state.observer.observe(target);

  return () => {
    const current = state.subscriptions.get(target);
    current?.delete(onChange);
    if (current?.size === 0) {
      state.subscriptions.delete(target);
      state.observer.unobserve(target);
    }
    if (state.subscriptions.size === 0) {
      state.observer.disconnect();
      roots.delete(root);
    }
  };
}
