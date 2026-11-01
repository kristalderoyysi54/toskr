import { beforeEach, describe, expect, it, vi } from "vitest";
import { CROSSHAIR_KEY, crosshairCss, DEFAULT_CROSSHAIR, loadCrosshair } from "./crosshair";

describe("截图十字线颜色", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
  });

  it("无记录时为浅天蓝 70%", () => {
    expect(loadCrosshair()).toEqual(DEFAULT_CROSSHAIR);
    expect(crosshairCss(loadCrosshair())).toBe("rgba(125, 211, 252, 0.7)");
  });

  it("非法预设回落默认，不透明度夹在范围内", () => {
    localStorage.setItem(CROSSHAIR_KEY, JSON.stringify({ preset: "nope", alpha: 5 }));
    expect(loadCrosshair()).toEqual({ preset: "sky", alpha: 30 });
    localStorage.setItem(CROSSHAIR_KEY, JSON.stringify({ preset: "magenta", alpha: 100 }));
    expect(crosshairCss(loadCrosshair())).toBe("rgba(236, 72, 153, 1)");
  });
});
