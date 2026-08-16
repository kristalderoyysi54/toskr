import { describe, expect, it } from "vitest";

import {
  FIT_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  wheelZoomFactor,
  zoomViewAround,
} from "./imageZoom";

describe("zoomViewAround", () => {
  it("锚点下的图像点在缩放前后保持不动", () => {
    const anchor = { x: 120, y: -40 };
    const before = { zoom: 2, x: 30, y: 10 };
    const after = zoomViewAround(before, 4, anchor);

    // 图像点 p 满足 anchor = pan + zoom * p；缩放后同一 p 仍落在 anchor
    const px = (anchor.x - before.x) / before.zoom;
    const py = (anchor.y - before.y) / before.zoom;
    expect(after.zoom).toBe(4);
    expect(after.x + after.zoom * px).toBeCloseTo(anchor.x, 10);
    expect(after.y + after.zoom * py).toBeCloseTo(anchor.y, 10);
  });

  it("倍率夹在上下限，1× 及以下居中且平移清零", () => {
    const capped = zoomViewAround({ zoom: 6, x: 5, y: 5 }, 100, { x: 0, y: 0 });
    expect(capped.zoom).toBe(MAX_ZOOM);

    // 从放大态缩回 1× 以下：允许缩小到适配以下，但强制居中
    const shrunk = zoomViewAround({ zoom: 1.2, x: 80, y: -60 }, 0.5, {
      x: 33,
      y: 44,
    });
    expect(shrunk).toEqual({ zoom: 0.5, x: 0, y: 0 });

    const floored = zoomViewAround({ zoom: 0.5, x: 0, y: 0 }, 0.01, {
      x: 0,
      y: 0,
    });
    expect(floored.zoom).toBe(MIN_ZOOM);

    const backToFit = zoomViewAround({ zoom: 0.5, x: 0, y: 0 }, 1, {
      x: 12,
      y: 34,
    });
    expect(backToFit).toEqual(FIT_VIEW);
  });

  it("滚轮因子平滑可逆：等量正反增量相互抵消", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1, 10);
  });
});
