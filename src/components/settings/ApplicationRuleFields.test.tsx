import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SimpleSelect } from "@/components/SimpleSelect";
import { Segmented } from "@/components/ui/segmented";
import { ProfileOutputPreview } from "./ProfileOutputPreview";
import { ApplicationRuleFields } from "./ApplicationRuleFields";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)]
    : []);
}

function render(overrides: Partial<ComponentProps<typeof ApplicationRuleFields>> = {}) {
  const props: ComponentProps<typeof ApplicationRuleFields> = {
    profile: { id: "chat", name: "聊天应用", bundleIds: ["test.chat"], defaultFormat: "plain", defaultMarkdownMode: "preserve", enterPolicy: "confirm", privacyPolicy: "confirmRaw", keepPanel: false, promptGroupId: "general" },
    groups: [{ id: "writing", name: "写作", order: 1 }, { id: "general", name: "通用", order: 0 }],
    snippets: [{ id: "template-1", label: "整理", text: "整理：{内容}", groupId: "general" }],
    firewallEnabled: true,
    fallback: false,
    onUpdate: vi.fn(),
    ...overrides,
  };
  const tree = ApplicationRuleFields(props);
  const nodes = elements(tree);
  const select = (label: string) => nodes.find((node) => node.type === SimpleSelect && node.props.ariaLabel === `聊天应用 ${label}`)!.props as ComponentProps<typeof SimpleSelect>;
  return { props, nodes, select, html: () => renderToStaticMarkup(tree) };
}

describe("应用粘贴规则紧凑字段", () => {
  it("格式切换通过现有 helper 同时更新包装与 Markdown 字段", () => {
    const view = render();
    view.select("输出格式").onChange("strip-markdown");
    expect(view.props.onUpdate).toHaveBeenCalledExactlyOnceWith({ defaultFormat: "plain", defaultMarkdownMode: "strip" });
    view.select("输出格式").onChange("code");
    expect(view.props.onUpdate).toHaveBeenLastCalledWith({ defaultFormat: "code", defaultMarkdownMode: "preserve" });
    expect(view.props.profile.defaultMarkdownMode).toBe("preserve");
  });

  it("其他字段只回传各自 patch，不写入方案范围或保存状态", () => {
    const view = render();
    view.select("回车策略").onChange("never");
    view.select("发送前隐私策略").onChange("requireRedaction");
    const panel = view.nodes.find((node) => node.type === Segmented)!.props as ComponentProps<typeof Segmented>;
    panel.onChange("keep");
    view.select("提示词组").onChange("writing");
    expect(vi.mocked(view.props.onUpdate).mock.calls).toEqual([
      [{ enterPolicy: "never" }], [{ privacyPolicy: "requireRedaction" }], [{ keepPanel: true }], [{ promptGroupId: "writing" }],
    ]);
    expect(view.html()).toContain("固定面板时始终保持打开");
  });

  it("输出格式沿用设置搜索的默认发送方式锚点", () => {
    const view = render();
    expect(view.html()).toContain('data-settings-search="默认发送方式"');
    expect(view.html()).not.toContain('data-settings-search="输出方式"');
  });

  it("默认兜底展示实际安全值并锁定，直接调用回调也不能降级", () => {
    const view = render({ fallback: true });
    expect(view.select("回车策略")).toMatchObject({ disabled: true, value: "never" });
    expect(view.select("发送前隐私策略")).toMatchObject({ disabled: true, value: "requireRedaction" });
    view.select("回车策略").onChange("allow");
    view.select("发送前隐私策略").onChange("allowRaw");
    expect(view.props.onUpdate).not.toHaveBeenCalled();
    expect(view.select("输出格式").disabled).not.toBe(true);
    expect(view.html()).toContain("默认兜底用于未单独配置的应用");
  });

  it("隐私关闭时明确规则不生效，仍可预设策略且不声称高风险保护正在运行", () => {
    const view = render({ firewallEnabled: false });
    expect(view.html()).toContain("全局隐私检查已关闭，这项规则暂不生效");
    expect(view.html()).not.toContain("保留高风险原文仍需确认，且不会自动回车");
    view.select("发送前隐私策略").onChange("allowRaw");
    expect(view.props.onUpdate).toHaveBeenCalledExactlyOnceWith({ privacyPolicy: "allowRaw" });
  });

  it("辅助模板组按组顺序排列，缺失组显示通用回退说明", () => {
    const view = render();
    expect(view.select("提示词组").options.map((group) => group.value)).toEqual(["general", "writing"]);
    expect(view.html()).toContain("常用模板不受影响");
    expect(view.html()).toContain("不会自动套用模板");
    const missing = render({ profile: { ...view.props.profile, promptGroupId: "removed" } });
    expect(missing.select("提示词组").options[0]).toMatchObject({ value: "removed", label: "已删除的提示词组 · 请选择替代项" });
    expect(missing.html()).toContain("当前生效：通用");
  });

  it("真实格式预览常驻在辅助 details 外，并明确示例与临时覆盖边界", () => {
    const view = render();
    expect(view.nodes.filter((node) => node.type === ProfileOutputPreview)).toHaveLength(1);
    const details = view.nodes.find((node) => node.type === "details")!;
    expect(elements(details.props.children as ReactNode).some((node) => node.type === ProfileOutputPreview)).toBe(false);
    expect(view.html()).toContain("使用可编辑的示例内容");
    expect(view.html()).toContain("不模拟隐私处理");
    expect(view.html()).toContain("不包含主面板的本次临时覆盖");
    expect(view.html()).toContain("不会执行真实粘贴或回车");
  });
});
