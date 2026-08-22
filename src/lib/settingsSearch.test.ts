import { describe, expect, it } from "vitest";

import {
  SETTINGS_SEARCH_ENTRIES,
  normalizeSettingsSearchText,
  searchSettings,
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
    expect(searchSettings("hotkey", enabled)[0]?.title).toBe("捕获与快捷键");
    expect(searchSettings("backup", enabled)[0]?.title).toBe("导出完整备份");
    expect(searchSettings("version", enabled)[0]?.title).toBe("关于");
    expect(searchSettings("代码风格", enabled)[0]?.title).toBe("默认密文格式");
    expect(searchSettings("随机语言", enabled)[0]?.title).toBe("默认密文格式");
    expect(searchSettings("中文文本", enabled)[0]?.title).toBe("默认密文格式");
    expect(searchSettings("自动识别", enabled)[0]?.title).toBe("默认密文格式");
    expect(searchSettings("密文外观", enabled)[0]?.title).toBe("默认密文格式");
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
