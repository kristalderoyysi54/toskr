import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TargetSection } from "./SettingsView";
import { defaultSettings } from "@/store/notesStore";
import { searchSettings, targetSettingsPageForSearch } from "@/lib/settingsSearch";

const gates = { messagesEnabled: true, secretEnabled: true, subscriptionsEnabled: true };
const render = (searchTarget: string | null = null) => renderToStaticMarkup(
  <TargetSection settings={defaultSettings()} patch={vi.fn()} targetProfileRequest={null}
    searchTarget={searchTarget} searchSequence={1} />
);

const visible = (html: string, page: string) => {
  const tag = html.match(new RegExp(`<div id="[^"]*-${page}"[^>]*>`))?.[0];
  expect(tag).toBeDefined();
  return !tag!.includes("hidden=");
};

describe("粘贴与隐私按使用目的分区", () => {
  it("默认展示粘贴规则，隐私与模板子页保持挂载但隐藏", () => {
    const html = render();
    expect(html).toContain('aria-label="粘贴与隐私选项"');
    expect(visible(html, "paste")).toBe(true);
    expect(visible(html, "privacy")).toBe(false);
    expect(visible(html, "templates")).toBe(false);
    expect(html).toContain('aria-label="发送前隐私检查"');
    expect(html).not.toContain('aria-label="手机号提示"');
  });

  it.each(["提示词组", "提示词模板", "导出模板", "试用预览"])("旧模板深链及新模板入口 %s 直接定位模板页", (target) => {
    expect(targetSettingsPageForSearch(target)).toBe("templates");
    const html = render(target);
    expect(visible(html, "templates")).toBe(true);
    expect(visible(html, "paste")).toBe(false);
  });

  it.each(["隐私与化名", "可逆化名", "发送前隐私检查（仅本机文本检查）", "发送前隐私检查", "启用隐私检查", "提示级类别", "检测类别"])("搜索 %s 直接定位隐私页", (target) => {
    expect(targetSettingsPageForSearch(target)).toBe("privacy");
    expect(visible(render(target), "privacy")).toBe(true);
  });

  it("化名卡常驻隐私页；检测类别只在搜索命中时展开", () => {
    expect(render("可逆化名")).toContain('aria-label="启用可逆化名"');
    expect(render("启用隐私检查")).toContain('aria-label="启用可逆化名"');
    expect(render("启用隐私检查")).not.toContain('aria-label="手机号提示"');
    expect(render("检测类别")).toContain('aria-label="手机号提示"');
    expect(render("检测类别")).toContain("高风险内容始终检测，不能关闭");
  });

  it("隐私页用状态摘要代替说明段落，并提供去往粘贴规则的入口", () => {
    const html = render("启用隐私检查");
    expect(html).toContain("全部开启");
    expect(html).toContain("未添加");
    expect(html).toContain("发现后如何处理");
    expect(html).toContain("本机规则可能漏检");
    expect(html).not.toContain("用化名替换指定内容");
  });

  it("规则搜索定位编辑器，模板导出和预览可以被搜索", () => {
    for (const query of ["默认发送方式", "粘贴后动作", "敏感内容处理"]) {
      const entry = searchSettings(query, gates).find((entry) => entry.title === query)!;
      expect(entry.target ?? entry.title).toBe(query);
      expect(targetSettingsPageForSearch(entry.target ?? entry.title)).toBe("paste");
    }
    expect(searchSettings("模板备份", gates).some((entry) => entry.id === "prompt-export")).toBe(true);
    expect(searchSettings("示例内容", gates).some((entry) => entry.id === "prompt-preview")).toBe(true);
  });
});
