import { afterEach, describe, expect, it, vi } from "vitest";

import { observeRenderWindow } from "@/lib/viewportWindow";

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

describe("observeRenderWindow", () => {
  afterEach(() => {
    FakeIntersectionObserver.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("只在渲染窗口内挂载，并在离开 overscan 后卸载", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const target = {} as Element;
    const states: boolean[] = [];
    const stop = observeRenderWindow(target, (visible) => states.push(visible));
    const observer = FakeIntersectionObserver.instances[0]!;

    observer.emit(target, false);
    observer.emit(target, true);
    observer.emit(target, false);

    expect(states).toEqual([false, true, false]);
    stop();
    expect(observer.unobserve).toHaveBeenCalledWith(target);
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("所有条目共享一个 observer", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const stopFirst = observeRenderWindow({} as Element, vi.fn());
    const stopSecond = observeRenderWindow({} as Element, vi.fn());

    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    stopFirst();
    stopSecond();
  });

  it("不同预加载距离按 root 隔离 observer，避免消息页扩大缓冲拖累其他列表", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const root = {} as Element;
    const target = () =>
      ({ closest: vi.fn(() => root) }) as unknown as Element;

    const stopDefault = observeRenderWindow(target(), vi.fn());
    const stopWideFirst = observeRenderWindow(target(), vi.fn(), 1440);
    const stopWideSecond = observeRenderWindow(target(), vi.fn(), 1440);

    expect(FakeIntersectionObserver.instances).toHaveLength(2);
    expect(FakeIntersectionObserver.instances.map((item) => item.rootMargin)).toEqual([
      "240px 0px",
      "1440px 0px",
    ]);
    stopDefault();
    stopWideFirst();
    stopWideSecond();
  });

  it("快速滚动期间延后离窗通知，停止后再释放远处卡片", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const listeners: { scroll?: EventListener } = {};
    const root = {
      addEventListener: vi.fn((_type: string, listener: EventListener) => {
        listeners.scroll = listener;
      }),
      removeEventListener: vi.fn(),
    } as unknown as Element;
    const target = {
      closest: vi.fn(() => root),
    } as unknown as Element;
    const states: boolean[] = [];
    const stop = observeRenderWindow(
      target,
      (visible) => states.push(visible),
      1440,
      180
    );
    const observer = FakeIntersectionObserver.instances[0]!;

    observer.emit(target, true);
    observer.emit(target, false);
    vi.advanceTimersByTime(100);
    listeners.scroll?.(new Event("scroll"));
    vi.advanceTimersByTime(179);
    expect(states).toEqual([true]);
    vi.advanceTimersByTime(1);

    expect(states).toEqual([true, false]);
    stop();
    expect(root.removeEventListener).toHaveBeenCalled();
  });

  it("以最近的 Radix ScrollArea viewport 为 root，让 overscan 不被祖先裁掉", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const root = {} as Element;
    const target = {
      closest: vi.fn(() => root),
    } as unknown as Element;

    const stop = observeRenderWindow(target, vi.fn());

    expect(FakeIntersectionObserver.instances[0]?.root).toBe(root);
    expect(FakeIntersectionObserver.instances[0]?.rootMargin).toBe("240px 0px");
    stop();
  });
});
