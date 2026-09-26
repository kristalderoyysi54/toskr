import { emit, listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

import type {
  ColorScheme,
  PlatinumHighlight,
  PlatinumScrollbar,
  Settings,
  ThemePref,
} from "@/store/notesStore";

/**
 * 外观（配色方案 + Platinum 高亮色 / 滚动条）跨窗口同步。主面板是设置的唯一
 * 持有方；HUD、详情、预览等窗口没有设置 store，所以由主面板写 localStorage
 * （同源 WebView 共享，供各窗口首帧同步读取、免闪旧主题）并广播事件（供已
 * 打开的窗口实时切换）。
 */
export const COLOR_SCHEME_EVENT = "toskr://color-scheme";
export const COLOR_SCHEME_STORAGE_KEY = "toskr.colorScheme";

export interface Appearance {
  scheme: ColorScheme;
  highlight: PlatinumHighlight;
  scrollbar: PlatinumScrollbar;
}

export const DEFAULT_APPEARANCE: Appearance = {
  scheme: "default",
  highlight: "lavender",
  scrollbar: "classic",
};

const SCHEMES: readonly ColorScheme[] = ["default", "platinum"];
const HIGHLIGHTS: readonly PlatinumHighlight[] = ["lavender", "blue", "teal", "graphite"];
const SCROLLBARS: readonly PlatinumScrollbar[] = ["classic", "thin"];

const pick = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function normalizeColorScheme(value: unknown): ColorScheme {
  return pick(SCHEMES, value, "default");
}

/** 兼容旧缓存：早期只存方案字符串，新格式为 JSON 对象。 */
export function normalizeAppearance(value: unknown): Appearance {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_APPEARANCE, scheme: normalizeColorScheme(raw) };
    }
  }
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_APPEARANCE, scheme: normalizeColorScheme(raw) };
  }
  const record = raw as Record<string, unknown>;
  return {
    scheme: normalizeColorScheme(record.scheme),
    highlight: pick(HIGHLIGHTS, record.highlight, DEFAULT_APPEARANCE.highlight),
    scrollbar: pick(SCROLLBARS, record.scrollbar, DEFAULT_APPEARANCE.scrollbar),
  };
}

export function appearanceFromSettings(
  settings: Pick<Settings, "colorScheme" | "platinumHighlight" | "platinumScrollbar">
): Appearance {
  return normalizeAppearance({
    scheme: settings.colorScheme,
    highlight: settings.platinumHighlight,
    scrollbar: settings.platinumScrollbar,
  });
}

/** Platinum 只有浅色外观：原生窗口主题强制浅色，否则系统控件与 WebView 配色会分裂。 */
export function nativeWindowTheme(settings: Pick<Settings, "theme" | "colorScheme">): ThemePref {
  return settings.colorScheme === "platinum" ? "light" : settings.theme;
}

/** Platinum 整窗不透明：毛玻璃被完全遮住，停用可免掉 14pt 圆角的模糊底板。 */
export function nativeVibrancy(settings: Pick<Settings, "vibrancy" | "colorScheme">): boolean {
  return settings.vibrancy && settings.colorScheme !== "platinum";
}

let current: Appearance = DEFAULT_APPEARANCE;
let media: MediaQueryList | null = null;
const subscribers = new Set<() => void>();

function render() {
  const root = document.documentElement;
  const platinum = current.scheme === "platinum";
  if (platinum) {
    root.dataset.theme = current.scheme;
    root.dataset.ptHighlight = current.highlight;
    root.dataset.ptScrollbar = current.scrollbar;
  } else {
    delete root.dataset.theme;
    delete root.dataset.ptHighlight;
    delete root.dataset.ptScrollbar;
  }
  root.classList.toggle("dark", !platinum && Boolean(media?.matches));
}

export function applyAppearance(next: Appearance) {
  const changed = next.scheme !== current.scheme;
  current = next;
  render();
  if (changed) subscribers.forEach((notify) => notify());
}

export function applyColorScheme(scheme: ColorScheme) {
  applyAppearance({ ...current, scheme });
}

export function getColorScheme(): ColorScheme {
  return current.scheme;
}

export function subscribeColorScheme(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

/** 组件按配色方案切换结构（Platinum 布局）；默认方案下必须渲染与原先完全一致的 DOM。 */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribeColorScheme, getColorScheme, () => "default");
}

export function readCachedAppearance(): Appearance {
  try {
    return normalizeAppearance(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function readCachedColorScheme(): ColorScheme {
  return readCachedAppearance().scheme;
}

/** 每个窗口入口调用一次：接管 .dark、data-theme 与 Platinum 细项根属性。 */
export function installColorScheme() {
  media = window.matchMedia("(prefers-color-scheme: dark)");
  applyAppearance(readCachedAppearance());
  // set_theme 后 WebView 的 prefers-color-scheme 也会变，同一监听覆盖手动深浅色
  media.addEventListener("change", render);
  window.addEventListener("storage", (event) => {
    if (event.key === COLOR_SCHEME_STORAGE_KEY) {
      applyAppearance(normalizeAppearance(event.newValue));
    }
  });
  try {
    void listen<Appearance>(COLOR_SCHEME_EVENT, (event) =>
      applyAppearance(normalizeAppearance(event.payload))
    ).catch(() => {});
  } catch {
    /* 浏览器诊断环境没有事件通道 */
  }
}

/** 主面板调用：本窗立即生效 + 缓存 + 广播。 */
export function publishAppearance(appearance: Appearance) {
  applyAppearance(appearance);
  try {
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    /* 存储不可用时仍靠事件同步已打开窗口 */
  }
  try {
    void emit(COLOR_SCHEME_EVENT, appearance).catch(() => {});
  } catch {
    /* 同上 */
  }
}
