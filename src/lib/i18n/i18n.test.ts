import { afterEach, describe, expect, it } from "vitest";

import { EN_PARTS, type EnValue } from "./en";
import { applyLocale, localeFromLanguageTag, resolveLocale, t, type MessageKey } from "./index";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const forms = (value: EnValue) => (typeof value === "string" ? [value] : [value.one, value.other]);

describe("i18n", () => {
  afterEach(() => applyLocale("zh"));

  it("中文下原样返回 key 并插值", () => {
    expect(t("取消")).toBe("取消");
    expect(t("{n} 条", { n: 2 })).toBe("2 条");
  });

  it("英文下查字典", () => {
    applyLocale("en");
    expect(t("取消")).toBe("Cancel");
  });

  it("单复数按 n 选择并插值", () => {
    applyLocale("en");
    expect(t("{n} 条", { n: 1 })).toBe("1 item");
    expect(t("{n} 条", { n: 3 })).toBe("3 items");
    // 缺英文条目时回落中文原文并照常插值（类型层面已禁止，此处防运行期旁路）
    expect(t("已清空 {n} 条" as MessageKey, { n: 3 })).toBe("已清空 3 条");
  });

  it("系统语言解析：zh* → zh，其余 → en", () => {
    expect(localeFromLanguageTag("zh-Hans-CN")).toBe("zh");
    expect(localeFromLanguageTag("zh-Hant-TW")).toBe("zh");
    expect(localeFromLanguageTag("en-US")).toBe("en");
    expect(localeFromLanguageTag("ja-JP")).toBe("en");
    expect(localeFromLanguageTag(undefined)).toBe("en");
    expect(resolveLocale("zh", "en-US")).toBe("zh");
    expect(resolveLocale("system", "zh-CN")).toBe("zh");
  });

  it("字典：译文非空、占位符与中文 key 一致", () => {
    for (const [part, dict] of Object.entries(EN_PARTS)) {
      for (const [key, value] of Object.entries(dict as Record<string, EnValue>)) {
        for (const form of forms(value)) {
          expect(form.trim(), `${part}: ${key}`).not.toBe("");
          expect(placeholders(form), `${part}: ${key}`).toEqual(placeholders(key));
        }
        if (typeof value !== "string") {
          expect(placeholders(key), `${part}: ${key} 复数形式需要 {n}`).toContain("n");
        }
      }
    }
  });

  it("字典：同一 key 在不同区域译文一致", () => {
    const seen = new Map<string, { part: string; value: string }>();
    for (const [part, dict] of Object.entries(EN_PARTS)) {
      for (const [key, value] of Object.entries(dict as Record<string, EnValue>)) {
        const serialized = JSON.stringify(value);
        const prior = seen.get(key);
        if (prior) expect(serialized, `${key}: ${prior.part} vs ${part}`).toBe(prior.value);
        else seen.set(key, { part, value: serialized });
      }
    }
  });
});
