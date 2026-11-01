import { useEffect, useState } from "react";

/** 截图十字线、选框与手柄的颜色（本机 localStorage，设置窗与截图遮罩共用）。 */
export const CROSSHAIR_KEY = "toskr.screenshotCrosshair";

// token-exception: 截图遮罩线色，画在任意屏幕内容之上，不随主题变化
export const CROSSHAIR_PRESETS = {
  sky: [125, 211, 252],
  white: [255, 255, 255],
  lime: [179, 217, 52],
  magenta: [236, 72, 153],
} as const satisfies Record<string, readonly [number, number, number]>;

export type CrosshairPreset = keyof typeof CROSSHAIR_PRESETS;

export const CROSSHAIR_ALPHA_MIN = 30;
export const CROSSHAIR_ALPHA_MAX = 100;

export interface CrosshairStyle {
  preset: CrosshairPreset;
  /** 不透明度 % */
  alpha: number;
}

export const DEFAULT_CROSSHAIR: CrosshairStyle = { preset: "sky", alpha: 70 };

export function loadCrosshair(): CrosshairStyle {
  try {
    const v = JSON.parse(localStorage.getItem(CROSSHAIR_KEY) ?? "{}") as { preset?: unknown; alpha?: unknown };
    const preset = typeof v.preset === "string" && v.preset in CROSSHAIR_PRESETS ? (v.preset as CrosshairPreset) : DEFAULT_CROSSHAIR.preset;
    const alpha =
      typeof v.alpha === "number"
        ? Math.min(CROSSHAIR_ALPHA_MAX, Math.max(CROSSHAIR_ALPHA_MIN, v.alpha))
        : DEFAULT_CROSSHAIR.alpha;
    return { preset, alpha };
  } catch {
    return DEFAULT_CROSSHAIR;
  }
}

export function crosshairCss({ preset, alpha }: CrosshairStyle): string {
  const [r, g, b] = CROSSHAIR_PRESETS[preset];
  return `rgba(${r}, ${g}, ${b}, ${alpha / 100})`;
}

/** 读写十字线样式；其他窗口改了会经 storage 事件同步。 */
export function useCrosshair() {
  const [style, setStyle] = useState<CrosshairStyle>(loadCrosshair);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === CROSSHAIR_KEY) setStyle(loadCrosshair());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const update = (next: CrosshairStyle) => {
    localStorage.setItem(CROSSHAIR_KEY, JSON.stringify(next));
    setStyle(next);
  };
  return [style, update] as const;
}
