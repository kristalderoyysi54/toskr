import { describe, expect, it } from "vitest";

import {
  clipToScreen,
  hitHandle,
  moveRect,
  placeNear,
  rectFromPoints,
  resizeRect,
  toPixelRect,
  windowAt,
} from "./geometry";

const W = 1440;
const H = 900;

describe("截图选区几何", () => {
  it("反向拖拽得到规范矩形并裁进屏内", () => {
    expect(rectFromPoints(300, 200, 100, 50, W, H)).toEqual({ x: 100, y: 50, w: 200, h: 150 });
    expect(rectFromPoints(1400, 850, 1600, 1000, W, H)).toEqual({ x: 1400, y: 850, w: 40, h: 50 });
  });

  it("窗口命中取最上层，跨屏窗口裁到本屏", () => {
    const ws = [
      { x: 100, y: 100, w: 200, h: 200 },
      { x: -200, y: 0, w: 800, h: 600 },
    ];
    expect(windowAt(ws, 150, 150)).toBe(ws[0]);
    expect(windowAt(ws, 50, 50)).toBe(ws[1]);
    expect(windowAt(ws, 1000, 800)).toBeNull();
    expect(clipToScreen(ws[1], W, H)).toEqual({ x: 0, y: 0, w: 600, h: 600 });
    expect(clipToScreen({ x: -500, y: 0, w: 100, h: 100 }, W, H)).toBeNull();
  });

  it("手柄命中与越过对边翻转", () => {
    const r = { x: 100, y: 100, w: 200, h: 100 };
    expect(hitHandle(r, 302, 199)).toBe("se");
    expect(hitHandle(r, 200, 98)).toBe("n");
    expect(hitHandle(r, 200, 150)).toBeNull();
    expect(resizeRect(r, "e", -250, 0, W, H)).toEqual({ x: 50, y: 100, w: 50, h: 100 });
    expect(resizeRect(r, "nw", -200, -200, W, H)).toEqual({ x: 0, y: 0, w: 300, h: 200 });
  });

  it("平移贴边停住、尺寸不变", () => {
    const r = { x: 100, y: 100, w: 200, h: 100 };
    expect(moveRect(r, 5000, -5000, W, H)).toEqual({ x: 1240, y: 0, w: 200, h: 100 });
  });

  it("Retina 像素换算四边取整", () => {
    expect(toPixelRect({ x: 10.3, y: 20, w: 100, h: 50.4 }, 2, 2, 2880, 1800)).toEqual({ x: 21, y: 40, w: 200, h: 101 });
    expect(toPixelRect({ x: 1400, y: 0, w: 100, h: 10 }, 2, 2, 2880, 1800)).toEqual({ x: 2800, y: 0, w: 80, h: 20 });
  });

  it("浮层靠近屏幕右下时翻到另一侧", () => {
    expect(placeNear(100, 100, 120, 150, W, H)).toEqual({ x: 120, y: 120 });
    expect(placeNear(1400, 850, 120, 150, W, H)).toEqual({ x: 1260, y: 680 });
  });
});
