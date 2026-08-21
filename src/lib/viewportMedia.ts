import { useEffect, useState, type RefObject } from "react";

const verticalPreloadMargin = "160px 0px";
const horizontalPreloadMargin = "0px 160px";
interface RootObserver {
  observer: IntersectionObserver;
  listeners: Map<Element, Set<() => void>>;
}
const roots = new Map<Element | null, RootObserver>();

function scrollRoot(target: Element): Element | null {
  return typeof target.closest === "function"
    ? target.closest("[data-radix-scroll-area-viewport], [data-strip-scroller]")
    : null;
}

function preloadMargin(root: Element | null): string {
  return root && typeof root.hasAttribute === "function" && root.hasAttribute("data-strip-scroller")
    ? horizontalPreloadMargin
    : verticalPreloadMargin;
}

function rootObserver(root: Element | null): RootObserver {
  const existing = roots.get(root);
  if (existing) return existing;

  const listeners = new Map<Element, Set<() => void>>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callbacks = listeners.get(entry.target);
        if (!callbacks) continue;
        listeners.delete(entry.target);
        observer.unobserve(entry.target);
        for (const callback of callbacks) callback();
      }
      if (listeners.size === 0) {
        observer.disconnect();
        roots.delete(root);
      }
    },
    { root, rootMargin: preloadMargin(root) }
  );
  const state = { observer, listeners };
  roots.set(root, state);
  return state;
}

/**
 * 每个 ScrollArea 共用一个 IntersectionObserver：图片卡进入视口前约 160px
 * 才开始取缩略图。不支持 IntersectionObserver 的旧 WebView 保持立即加载。
 */
export function observeNearViewport(target: Element, onNear: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onNear();
    return () => {};
  }

  let active = true;
  const reveal = () => {
    if (!active) return;
    active = false;
    onNear();
  };
  const root = scrollRoot(target);
  const state = rootObserver(root);
  const callbacks = state.listeners.get(target) ?? new Set<() => void>();
  callbacks.add(reveal);
  state.listeners.set(target, callbacks);
  if (callbacks.size === 1) state.observer.observe(target);

  return () => {
    if (!active) return;
    active = false;
    const current = state.listeners.get(target);
    current?.delete(reveal);
    if (current?.size === 0) {
      state.listeners.delete(target);
      state.observer.unobserve(target);
    }
    if (state.listeners.size === 0) {
      state.observer.disconnect();
      roots.delete(root);
    }
  };
}

/** 已进入近视口后保持 true；滚走不卸图，避免来回滚动反复解码。 */
export function useNearViewport(
  targetRef: RefObject<Element | null>,
  enabled = true
): boolean {
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === "undefined"
  );

  useEffect(() => {
    if (!enabled || near || !targetRef.current) return;
    return observeNearViewport(targetRef.current, () => setNear(true));
  }, [enabled, near, targetRef]);

  return near;
}
