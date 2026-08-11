import { describe, expect, it } from "vitest";

import {
  shouldHidePanelOnBlur,
  triggerKeepsPanelOpen,
} from "./panelBehavior";

describe("panel shortcut hold behavior", () => {
  it.each(["hotkey", "doubleTap"] as const)(
    "%s 呼出后保持展开，直到显式交互",
    (source) => {
      expect(triggerKeepsPanelOpen({ kind: "toggle", force: true, source })).toBe(true);
    }
  );

  it("托盘打开不进入快捷键保护态", () => {
    expect(
      triggerKeepsPanelOpen({ kind: "toggle", force: false, source: "tray" })
    ).toBe(false);
  });

  it("快捷键保护态优先于失焦自动隐藏，拖动解除后恢复原规则", () => {
    const base = { open: true, pinned: false, hideOnBlur: true };
    expect(shouldHidePanelOnBlur({ ...base, shortcutHoldOpen: true })).toBe(false);
    expect(shouldHidePanelOnBlur({ ...base, shortcutHoldOpen: false })).toBe(true);
    expect(
      shouldHidePanelOnBlur({
        ...base,
        pinned: true,
        shortcutHoldOpen: false,
      })
    ).toBe(false);
  });
});
