import { emit, listen } from "@tauri-apps/api/event";
import { createElement, Fragment, useSyncExternalStore, type ReactNode } from "react";

import { en, type EnValue } from "./en";

/**
 * 界面语言。中文原文即 key：`t("暂停 15 分钟")`；英文字典是唯一翻译表，
 * key 类型取自英文字典，缺英文条目在 typecheck 阶段就失败。
 * 插值用 `{name}`；英文值可给 `{ one, other }`，按 vars.n 是否为 1 选择。
 *
 * 跨窗口同步与 colorScheme 同构：主面板解析出最终语言后写 localStorage
 * （各窗口首帧同步读取）并广播事件（已打开窗口实时切换）。
 */
export type Locale = "zh" | "en";
export type LanguagePref = "system" | Locale;
export type MessageKey = keyof typeof en;
export type MessageVars = Record<string, string | number>;

export const LOCALE_EVENT = "toskr://locale";
export const LOCALE_STORAGE_KEY = "toskr.locale";

const table: Record<string, EnValue> = en;
let current: Locale = "zh";
const subscribers = new Set<() => void>();

export function normalizeLocale(value: unknown): Locale | null {
  return value === "zh" || value === "en" ? value : null;
}

/** 系统语言标签 → 界面语言：中文（含繁体）用中文，其余一律英文。 */
export function localeFromLanguageTag(tag: string | null | undefined): Locale {
  return tag?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function resolveLocale(pref: LanguagePref, systemTag: string | null | undefined): Locale {
  return pref === "system" ? localeFromLanguageTag(systemTag) : pref;
}

function interpolate(template: string, vars: MessageVars): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  );
}

function template(key: MessageKey, vars?: MessageVars): string {
  if (current === "zh") return key;
  const entry = table[key];
  if (entry === undefined) return key;
  if (typeof entry === "string") return entry;
  return Number(vars?.n) === 1 ? entry.one : entry.other;
}

/** 取当前语言文案。非组件代码（tip、store）直接调用；组件内用 useT 以便切换时重渲染。 */
export function t(key: MessageKey, vars?: MessageVars): string {
  const text = template(key, vars);
  return vars ? interpolate(text, vars) : text;
}

/** 插值内容是 React 节点（如 <kbd>）时使用。 */
export function tNode(key: MessageKey, vars: Record<string, ReactNode>): ReactNode {
  const parts = template(key, vars as MessageVars).split(/(\{\w+\})/);
  return parts.map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    const node = name !== undefined && name in vars ? vars[name] : part;
    return createElement(Fragment, { key: index }, node);
  });
}

/** Intl / toLocaleString 用的语言标签。 */
export function intlLocale(): string {
  return current === "zh" ? "zh-CN" : "en-US";
}

export function getLocale(): Locale {
  return current;
}

export function subscribeLocale(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

export function applyLocale(next: Locale) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  }
  if (next === current) return;
  current = next;
  subscribers.forEach((notify) => notify());
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => "zh");
}

/** 每种语言一个独立引用：放进 useMemo / useEffect 依赖时，切换语言即失效重算。 */
const boundT: Record<Locale, typeof t> = {
  zh: (key, vars) => t(key, vars),
  en: (key, vars) => t(key, vars),
};

/** 组件取 t：订阅语言变化，切换后本组件重渲染。每个渲染文案的组件都要自己调用。 */
export function useT(): typeof t {
  return boundT[useLocale()];
}

export function readCachedLocale(): Locale | null {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 每个窗口入口调用一次：读缓存首帧生效 + 监听主面板广播。 */
export function installLocale() {
  applyLocale(readCachedLocale() ?? "zh");
  window.addEventListener("storage", (event) => {
    if (event.key === LOCALE_STORAGE_KEY) {
      const next = normalizeLocale(event.newValue);
      if (next) applyLocale(next);
    }
  });
  try {
    void listen<Locale>(LOCALE_EVENT, (event) => {
      const next = normalizeLocale(event.payload);
      if (next) applyLocale(next);
    }).catch(() => {});
  } catch {
    /* 浏览器诊断环境没有事件通道 */
  }
}

/** 主面板调用：本窗立即生效 + 缓存 + 广播。 */
export function publishLocale(next: Locale) {
  applyLocale(next);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    /* 存储不可用时仍靠事件同步已打开窗口 */
  }
  try {
    void emit(LOCALE_EVENT, next).catch(() => {});
  } catch {
    /* 同上 */
  }
}
