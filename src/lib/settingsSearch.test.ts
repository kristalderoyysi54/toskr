import { describe, expect, it } from "vitest";

import {
  SETTINGS_SEARCH_ENTRIES,
  SETTINGS_PRIMARY_SECTIONS,
  SETTINGS_SECTION_LABELS,
  normalizeSettingsSearchText,
  searchSettings,
  settingsChildSections,
  settingsPrimarySection,
  settingsSearchNeedsGeneralDetails,
  settingsSectionFromLink,
  type SettingsSectionId,
} from "./settingsSearch";

const enabled = {
  messagesEnabled: true,
  secretEnabled: true,
  subscriptionsEnabled: true,
};

describe("设置搜索", () => {
  it("空白查询不返回结果，中英文与全角字符使用统一匹配", () => {
    expect(searchSettings("  ", enabled)).toEqual([]);
    expect(normalizeSettingsSearchText(" Ｂａｓｅ-URL ")).toBe("baseurl");
    expect(searchSettings("base url", enabled)[0]?.title).toBe("Base URL");
  });

  it("按设置名称、稳定别名和多词查询匹配", () => {
    expect(searchSettings("毛玻璃", enabled).map((item) => item.title)).toEqual([
      "毛玻璃背景",
      "毛玻璃风格",
      "卡片底色不透明度",
    ]);
    expect(searchSettings("双击 shift", enabled)[0]?.title).toBe("触发键（双击）");
    expect(searchSettings("privacy", enabled)[0]?.title).toBe("发送前隐私检查");
    expect(searchSettings("hotkey", enabled)[0]?.title).toBe("快捷键");
    expect(searchSettings("backup", enabled)[0]?.title).toBe("导出完整备份");
    expect(searchSettings("version", enabled)[0]?.title).toBe("关于");
    expect(searchSettings("代码风格", enabled)[0]?.title).toBe("默认密文格式");
    expect(searchSettings("随机语言", enabled)[0]?.title).toBe("默认密文格式");
    expect(searchSettings("中文文本", enabled)[0]?.title).toBe("默认密文格式");
    expect(searchSettings("自动识别", enabled)[0]?.title).toBe("默认密文格式");
    expect(searchSettings("密文外观", enabled)[0]?.title).toBe("默认密文格式");
  });

  it("改名后保留旧分类搜索，并能跨父分类找到子页", () => {
    expect(searchSettings("通用 透明度", enabled).map((item) => item.id)).toContain("card-opacity");
    expect(searchSettings("目标与发送方案 粘贴", enabled).map((item) => item.id)).toContain("enter-policy");
    expect(searchSettings("功能开关", enabled)[0]?.title).toBe("更多功能");
    expect(searchSettings("窗口与外观 间隙", enabled)[0]?.section).toBe("companion");
    expect(searchSettings("帮助与更新 版本", enabled)[0]?.section).toBe("about");
    expect(searchSettings("新手导览", enabled)[0]?.section).toBe("outcome");
  });

  it("所有旧分区深链归入七个一级目的，旧别名仍可打开", () => {
    expect(SETTINGS_PRIMARY_SECTIONS).toHaveLength(7);
    for (const section of Object.keys(SETTINGS_SECTION_LABELS) as SettingsSectionId[]) {
      expect(settingsSectionFromLink(section, enabled)).toBe(section);
      expect(SETTINGS_PRIMARY_SECTIONS).toContain(settingsPrimarySection(section));
    }
    expect(settingsPrimarySection("companion")).toBe("general");
    expect(settingsPrimarySection("ai")).toBe("features");
    expect(settingsPrimarySection("due")).toBe("features");
    expect(settingsPrimarySection("message-watch")).toBe("features");
    expect(settingsPrimarySection("secret")).toBe("features");
    expect(settingsPrimarySection("diagnostics")).toBe("outcome");
    expect(settingsPrimarySection("about")).toBe("outcome");
    expect(settingsSectionFromLink("snippets", enabled)).toBe("target");
    expect(settingsSectionFromLink("prompts", enabled)).toBe("target");
    expect(settingsSectionFromLink("exclude", enabled)).toBe("hotkey");
  });

  it("禁用功能移除内部子导航，深链回到开启入口", () => {
    const disabled = { messagesEnabled: false, secretEnabled: false, subscriptionsEnabled: false };
    expect(settingsChildSections("features", disabled)).toEqual(["features", "ai", "due"]);
    expect(settingsSectionFromLink("message-watch", disabled)).toBe("features");
    expect(settingsSectionFromLink("secret", disabled)).toBe("features");
    expect(settingsChildSections("features", enabled)).toContain("message-watch");
    expect(settingsChildSections("features", enabled)).toContain("secret");
  });

  it("搜索外观细节和菜单自定义时要求打开折叠区，常用项不展开", () => {
    for (const query of ["窗口整体不透明度", "毛玻璃风格", "提示显示时长", "卡片右键菜单", "剪贴卡模板"]) {
      const result = searchSettings(query, enabled)[0];
      expect(result?.section).toBe("general");
      expect(settingsSearchNeedsGeneralDetails(result?.id ?? null)).toBe(true);
    }
    expect(settingsSearchNeedsGeneralDetails("theme")).toBe(false);
    expect(settingsSearchNeedsGeneralDetails("card-density")).toBe(false);
    expect(settingsSearchNeedsGeneralDetails(null)).toBe(false);
  });

  it("关闭的功能域不泄露内部配置，但保留功能开关入口", () => {
    const closed = searchSettings("消息", {
      messagesEnabled: false,
      secretEnabled: false,
      subscriptionsEnabled: false,
    });
    expect(closed.map((item) => item.id)).toContain("feature-message");
    expect(closed.some((item) => item.section === "message-watch")).toBe(false);
    expect(searchSettings("共享密钥", {
      messagesEnabled: false,
      secretEnabled: false,
      subscriptionsEnabled: false,
    })).toEqual([]);
    expect(searchSettings("金额货币", {
      messagesEnabled: false,
      secretEnabled: false,
      subscriptionsEnabled: false,
    })).toEqual([]);
  });

  it("搜索目录 ID 唯一且 gate 只用于内部功能项", () => {
    const ids = SETTINGS_SEARCH_ENTRIES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      SETTINGS_SEARCH_ENTRIES.find((item) => item.id === "feature-secret")?.requires
    ).toBeUndefined();
    expect(
      SETTINGS_SEARCH_ENTRIES.find((item) => item.id === "secret-keys")?.requires
    ).toBe("secretEnabled");
    expect(
      SETTINGS_SEARCH_ENTRIES.find((item) => item.id === "clip-template")?.target
    ).toBe("卡片密度");
    expect(
      SETTINGS_SEARCH_ENTRIES.find((item) => item.id === "double-copy-pin")?.target
    ).toBe("剪贴板历史");
    for (const id of ["watch-auto", "watch-manual", "watch-bridge"]) {
      expect(SETTINGS_SEARCH_ENTRIES.find((item) => item.id === id)?.target).toBe(
        "监听目标"
      );
    }
  });
});
