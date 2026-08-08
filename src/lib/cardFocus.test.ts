import { describe, expect, it } from "vitest";

import { shouldScrollFocusedCard } from "./cardFocus";

describe("shouldScrollFocusedCard", () => {
  it("不滚动已迁入隐藏页面的焦点卡", () => {
    expect(shouldScrollFocusedCard(true, true)).toBe(false);
  });

  it("仅滚动当前可见页面里的焦点卡", () => {
    expect(shouldScrollFocusedCard(true, false)).toBe(true);
    expect(shouldScrollFocusedCard(false, false)).toBe(false);
  });
});
