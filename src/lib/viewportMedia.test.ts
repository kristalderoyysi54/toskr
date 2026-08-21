import { afterEach, describe, expect, it, vi } from "vitest";

import { observeNearViewport } from "@/lib/viewportMedia";

type ObserverCallback = ConstructorParameters<typeof IntersectionObserver>[0];

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();
  readonly takeRecords = vi.fn(() => []);
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds = [0];
  readonly callback: ObserverCallback;

  constructor(callback: ObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    FakeIntersectionObserver.instances.push(this);
  }

  emit(target: Element, isIntersecting: boolean) {
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
}

describe("observeNearViewport", () => {
  afterEach(() => {
    FakeIntersectionObserver.instances = [];
    vi.unstubAllGlobals();
  });

  it("屏外不触发，进入预加载区后只触发一次并停止观察", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const target = {} as Element;
    const onNear = vi.fn();

    const stop = observeNearViewport(target, onNear);
    const observer = FakeIntersectionObserver.instances[0]!;

    expect(observer.observe).toHaveBeenCalledWith(target);
    expect(onNear).not.toHaveBeenCalled();

    observer.emit(target, false);
    expect(onNear).not.toHaveBeenCalled();

    observer.emit(target, true);
    observer.emit(target, true);
    expect(onNear).toHaveBeenCalledTimes(1);
    expect(observer.unobserve).toHaveBeenCalledWith(target);

    stop();
  });

  it("共享一个观察器，并在最后一个订阅结束后释放", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const first = {} as Element;
    const second = {} as Element;

    const stopFirst = observeNearViewport(first, vi.fn());
    const stopSecond = observeNearViewport(second, vi.fn());

    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    const observer = FakeIntersectionObserver.instances[0]!;

    stopFirst();
    expect(observer.disconnect).not.toHaveBeenCalled();
    stopSecond();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("以最近的 Radix ScrollArea viewport 为 root，让预加载边距真实生效", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const root = {} as Element;
    const target = {
      closest: vi.fn(() => root),
    } as unknown as Element;

    const stop = observeNearViewport(target, vi.fn());

    expect(FakeIntersectionObserver.instances[0]?.root).toBe(root);
    expect(FakeIntersectionObserver.instances[0]?.rootMargin).toBe("160px 0px");
    stop();
  });

  it("横栏以 StripScroller 为 root，并沿横轴预加载", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const root = {
      hasAttribute: vi.fn((name: string) => name === "data-strip-scroller"),
    } as unknown as Element;
    const target = {
      closest: vi.fn(() => root),
    } as unknown as Element;

    const stop = observeNearViewport(target, vi.fn());

    expect(FakeIntersectionObserver.instances[0]?.root).toBe(root);
    expect(FakeIntersectionObserver.instances[0]?.rootMargin).toBe("0px 160px");
    stop();
  });
});
