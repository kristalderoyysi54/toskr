import { afterEach, describe, expect, it } from "vitest";

import { INBOX_ID, TASK_INBOX_ID } from "@/store/notesStore";
import { SAFETY_PROFILE_ID, TERMINAL_PROFILE_ID, GENERAL_PROMPT_GROUP_ID } from "@/lib/targetProfiles";
import { isNewNotePlaceholder, profileName, promptGroupName, sectionName } from "./builtinNames";
import { applyLocale } from "./index";

describe("内置名显示翻译", () => {
  afterEach(() => applyLocale("zh"));

  it("中文下原样显示", () => {
    expect(sectionName({ id: INBOX_ID, name: "收件箱" })).toBe("收件箱");
    expect(profileName({ id: SAFETY_PROFILE_ID, name: "稳妥发送" })).toBe("稳妥发送");
  });

  it("英文下只翻译仍是出厂名的内置对象", () => {
    applyLocale("en");
    expect(sectionName({ id: INBOX_ID, name: "收件箱" })).toBe("Inbox");
    expect(sectionName({ id: TASK_INBOX_ID, name: "收集箱" })).toBe("Inbox");
    expect(sectionName({ id: INBOX_ID, name: "我的收件" })).toBe("我的收件");
    // 用户自建分组恰好叫「收件箱」不翻译
    expect(sectionName({ id: "s1", name: "收件箱" })).toBe("收件箱");
    expect(sectionName({ id: "s2", name: "未命名分组" })).toBe("Untitled Group");
    expect(profileName({ id: SAFETY_PROFILE_ID, name: "稳妥发送" })).toBe("Safe Send");
    expect(profileName({ id: TERMINAL_PROFILE_ID, name: "终端（安全）" })).toBe("Terminal (Safe)");
    expect(promptGroupName({ id: GENERAL_PROMPT_GROUP_ID, name: "通用" })).toBe("General");
  });

  it("新笔记占位中英文都识别", () => {
    applyLocale("en");
    expect(isNewNotePlaceholder(" 新笔记 ")).toBe(true);
    expect(isNewNotePlaceholder("New note")).toBe(true);
    expect(isNewNotePlaceholder("New note!")).toBe(false);
  });
});
