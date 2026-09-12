import { afterEach, describe, expect, it, vi } from "vitest";
import { createLongPress } from "./longPress";

afterEach(() => vi.useRealTimers());

describe("移入笔记长按手势", () => {
  it("短按执行原点击，不打开菜单", () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const press = createLongPress(open);
    press.start(20, 20);
    vi.advanceTimersByTime(449);
    press.release();
    vi.runAllTimers();
    expect(open).not.toHaveBeenCalled();
    expect(press.consumeClick()).toBe(false);
  });

  it("长按只开一次菜单，松手不会追加默认移动", () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const press = createLongPress(open);
    press.start(20, 20);
    vi.advanceTimersByTime(1500);
    press.release();
    expect(open).toHaveBeenCalledTimes(1);
    expect(press.consumeClick()).toBe(true);
    expect(press.consumeClick()).toBe(false);
  });

  it.each(["移出或失焦", "移动超阈值"])("%s 取消，不误触移动，下一次短按正常", (reason) => {
    vi.useFakeTimers();
    const open = vi.fn();
    const press = createLongPress(open);
    press.start(20, 20);
    vi.advanceTimersByTime(200);
    if (reason === "移动超阈值") press.move(30, 20);
    else press.cancel();
    vi.runAllTimers();
    press.release();
    expect(open).not.toHaveBeenCalled();
    expect(press.consumeClick()).toBe(true);
    press.start(20, 20);
    press.release();
    expect(press.consumeClick()).toBe(false);
  });

  it("轻微手抖不取消长按，菜单打开后取消仍阻止尾随点击", () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const press = createLongPress(open);
    press.start(20, 20);
    press.move(22, 22);
    vi.advanceTimersByTime(450);
    press.cancel();
    expect(open).toHaveBeenCalledTimes(1);
    expect(press.consumeClick()).toBe(true);
  });
});
