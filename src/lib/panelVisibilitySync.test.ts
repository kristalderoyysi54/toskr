import { describe, expect, it, vi } from "vitest";
import { syncPanelVisibility } from "./panelVisibilitySync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  let shown!: () => void;
  let changed!: () => void;
  const registration = deferred<() => void>();
  const visibility = deferred<boolean>();
  const showContent = vi.fn();
  const stop = vi.fn();
  const unsubscribe = vi.fn();
  const isVisible = vi.fn(() => visibility.promise);
  const cleanup = syncPanelVisibility({
    listenShown: (callback) => { shown = callback; return registration.promise; },
    isVisible, showContent,
    subscribeOpenChanges: (callback) => { changed = callback; return unsubscribe; },
  });
  return { shown: () => shown(), changed: () => changed(), registration, visibility, showContent, stop, unsubscribe, isVisible, cleanup };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("原生面板显示同步", () => {
  it("先完成监听，再补读已错过通知的首启显示", async () => {
    const s = setup();
    expect(s.isVisible).not.toHaveBeenCalled();
    s.registration.resolve(s.stop); await flush();
    s.visibility.resolve(true); await flush();
    expect(s.showContent).toHaveBeenCalledOnce();
  });
  it("常规后台启动继续隐藏", async () => {
    const s = setup();
    s.registration.resolve(s.stop); await flush();
    s.visibility.resolve(false); await flush();
    expect(s.showContent).not.toHaveBeenCalled();
  });
  it("重复原生显示始终表达打开而非切换", () => {
    const s = setup(); s.shown(); s.shown();
    expect(s.showContent).toHaveBeenCalledTimes(2);
  });
  it("过期可见态不能覆盖用户关闭", async () => {
    const s = setup();
    s.registration.resolve(s.stop); await flush();
    s.changed(); s.visibility.resolve(true); await flush();
    expect(s.showContent).not.toHaveBeenCalled();
  });
  it("收到显示后关闭，注册结束也不能重新补读打开", async () => {
    const s = setup(); s.shown(); s.changed();
    s.registration.resolve(s.stop); await flush();
    expect(s.isVisible).not.toHaveBeenCalled();
    expect(s.showContent).toHaveBeenCalledOnce();
  });
  it("卸载时清理晚到的监听且不打开内容", async () => {
    const s = setup(); s.cleanup(); s.registration.resolve(s.stop); await flush(); s.shown();
    expect(s.stop).toHaveBeenCalledOnce();
    expect(s.unsubscribe).toHaveBeenCalledOnce();
    expect(s.showContent).not.toHaveBeenCalled();
  });
});
