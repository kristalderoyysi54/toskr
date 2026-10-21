import { describe, expect, it } from "vitest";

import {
  advanceNoteImageEditSequence,
  failedRegionNumbers,
  mosaicBlock,
  moveBox,
  redactedRegionPixels,
  resizeBox,
  validRedactionStyle,
  containedImageRect,
  imagePointFromClient,
  pixelBoxFromDrag,
  pixelBoxStyle,
  transformedImageRect,
} from "./imageEditor";

describe("图片编辑跨窗序号", () => {
  it("同卡拒绝重复与迟到事件，不让其他卡的序号互相阻断", () => {
    const sequences = new Map<string, number>();
    expect(advanceNoteImageEditSequence(sequences, "note-a", 7, 2)).toBe(true);
    expect(advanceNoteImageEditSequence(sequences, "note-a", 7, 1)).toBe(false);
    expect(advanceNoteImageEditSequence(sequences, "note-a", 7, 2)).toBe(false);
    expect(advanceNoteImageEditSequence(sequences, "note-b", 7, 1)).toBe(true);
    expect(advanceNoteImageEditSequence(sequences, "note-a", 8, 1)).toBe(true);
  });
});

describe("图片打码坐标", () => {
  it("横图 object-contain 留白后仍映射到原图像素", () => {
    const imageRect = containedImageRect(400, 400, 800, 400)!;
    expect(imageRect).toEqual({ left: 0, top: 100, width: 400, height: 200 });
    const start = imagePointFromClient(
      { x: 100, y: 150 },
      { left: 20, top: 30 },
      imageRect,
      800,
      400
    );
    const end = imagePointFromClient(
      { x: 220, y: 230 },
      { left: 20, top: 30 },
      imageRect,
      800,
      400
    );
    expect(pixelBoxFromDrag(start, end, 800, 400)).toEqual({
      x: 160,
      y: 40,
      width: 240,
      height: 160,
    });
  });

  it("拖出图片边界时钳制，反向拖动也生成正尺寸区域", () => {
    expect(pixelBoxFromDrag(
      { x: 120, y: 70 },
      { x: -10, y: 200 },
      100,
      80
    )).toEqual({ x: 0, y: 70, width: 100, height: 10 });
    expect(pixelBoxFromDrag({ x: 2, y: 2 }, { x: 2, y: 2 }, 100, 80))
      .toBeNull();
  });

  it("像素框回投展示位置与 object-contain 几何同源", () => {
    expect(pixelBoxStyle(
      { x: 200, y: 100, width: 400, height: 200 },
      { left: 0, top: 100, width: 400, height: 200 },
      800,
      400
    )).toEqual({ left: 100, top: 150, width: 200, height: 100 });
  });

  it("放大和平移后用变换后的真实图片框继续映射像素", () => {
    const display = transformedImageRect(
      { left: 0, top: 100, width: 400, height: 200 },
      { zoom: 2, x: 30, y: -10 }
    );
    expect(display).toEqual({ left: -170, top: -10, width: 800, height: 400 });
    expect(imagePointFromClient(
      { x: 250, y: 190 },
      { left: 20, top: 30 },
      display,
      800,
      400
    )).toEqual({ x: 400, y: 170 });
  });
});

describe("打码样式与框编辑", () => {
  const px = (width: number, height: number, at: (x: number, y: number) => [number, number, number]) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
    return { data, width, height };
  };
  const pixel = (out: Uint8ClampedArray, w: number, x: number, y: number) =>
    Array.from(out.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

  it("样式校验：缺省、三种已知样式合法；模糊与坏颜色拒绝", () => {
    expect(validRedactionStyle(undefined)).toBe(true);
    expect(validRedactionStyle({ kind: "mosaic" })).toBe(true);
    expect(validRedactionStyle({ kind: "pick" })).toBe(true);
    expect(validRedactionStyle({ kind: "solid", color: [255, 255, 255] })).toBe(true);
    expect(validRedactionStyle({ kind: "blur" })).toBe(false);
    expect(validRedactionStyle({ kind: "solid", color: [256, 0, 0] })).toBe(false);
    expect(validRedactionStyle({ kind: "solid", color: [1, 2] })).toBe(false);
  });

  it("马赛克块：下限 12，随短边 1/3 增大（与 Rust 同）", () => {
    expect(mosaicBlock({ x: 0, y: 0, width: 300, height: 22 })).toBe(12);
    expect(mosaicBlock({ x: 0, y: 0, width: 300, height: 60 })).toBe(20);
  });

  it("马赛克像素与 Rust 用例一致：单色块保持原色，跨界块取平均", () => {
    const src = px(30, 12, (x) => (x < 18 ? [0, 0, 0] : [255, 255, 255]));
    const box = { x: 0, y: 0, width: 24, height: 12 };
    const out = redactedRegionPixels(src, box, { kind: "mosaic" });
    expect(pixel(out, 24, 5, 5)).toEqual([0, 0, 0, 255]);
    expect(pixel(out, 24, 13, 3)).toEqual([127, 127, 127, 255]);
    expect(pixel(out, 24, 23, 11)).toEqual([127, 127, 127, 255]);
  });

  it("取色：外圈平均；框占满整图时取框内平均（与 Rust 同）", () => {
    const src = px(10, 10, (x, y) => (x >= 3 && x < 7 && y >= 3 && y < 7 ? [0, 0, 0] : [200, 100, 50]));
    const ring = redactedRegionPixels(src, { x: 3, y: 3, width: 4, height: 4 }, { kind: "pick" });
    expect(pixel(ring, 4, 1, 1)).toEqual([200, 100, 50, 255]);
    const full = redactedRegionPixels(src, { x: 0, y: 0, width: 10, height: 10 }, { kind: "pick" });
    expect(pixel(full, 10, 0, 0)).toEqual([168, 84, 42, 255]);
  });

  it("移动夹在图内；拖角缩放固定对角、可翻转", () => {
    const box = { x: 10, y: 10, width: 20, height: 10 };
    expect(moveBox(box, -50, 500, 100, 50)).toEqual({ x: 0, y: 40, width: 20, height: 10 });
    expect(resizeBox(box, "se", { x: 50, y: 40 }, 100, 50)).toEqual({ x: 10, y: 10, width: 40, height: 30 });
    expect(resizeBox(box, "nw", { x: 40, y: 30 }, 100, 50)).toEqual({ x: 30, y: 20, width: 10, height: 10 });
  });

  it("从复检错误里解析未通过的框序号", () => {
    expect(failedRegionNumbers("遮挡校验未通过：第 2、5 处遮挡区域内仍能识别出文字，请扩大后重试")).toEqual([2, 5]);
    expect(failedRegionNumbers("原图不存在或不可读取")).toEqual([]);
  });
});
