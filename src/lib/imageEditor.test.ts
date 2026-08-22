import { describe, expect, it } from "vitest";

import {
  advanceNoteImageEditSequence,
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
