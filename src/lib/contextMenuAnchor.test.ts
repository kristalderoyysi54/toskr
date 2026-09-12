import { describe, expect, it } from "vitest";

import { clampedContextMenuX } from "./contextMenuAnchor";

describe("右键菜单锚点横向夹紧", () => {
  it("两侧任一侧放得下时不动锚点", () => {
    expect(clampedContextMenuX(30, 380)).toBe(30);
    expect(clampedContextMenuX(146, 380)).toBe(146);
    expect(clampedContextMenuX(234, 380)).toBe(234);
    expect(clampedContextMenuX(360, 380)).toBe(360);
  });

  it("面板中段两侧都不够时挪到余量更大的一侧刚好放下", () => {
    // 右侧余量更大 → 挪到右侧刚好放下的 x（菜单 224 + 间距 2 + 边距 8）
    expect(clampedContextMenuX(170, 380)).toBe(380 - 234);
    // 左侧余量更大 → 挪到左侧刚好放下
    expect(clampedContextMenuX(200, 380)).toBe(234);
    expect(clampedContextMenuX(230, 380)).toBe(234);
  });

  it("视口极窄时不越界", () => {
    expect(clampedContextMenuX(100, 200)).toBe(0);
    expect(clampedContextMenuX(150, 200)).toBe(200);
  });
});
