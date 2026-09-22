import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SimpleMenu, SimpleMenuItem } from "@/components/SimpleMenu";
import type { PromptSnippet } from "@/store/notesStore";
import { PromptTemplateCommonAction } from "./PromptTemplateCommonAction";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)]
    : []);
}

const builtin: PromptSnippet = { id: "workflow-requirements", label: "整理需求", text: "整理：{内容}", groupId: "general" };
const other: PromptSnippet = { id: "my-template", label: "客户反馈", text: "整理客户反馈：\n{内容}", groupId: "custom" };
const customCommon: PromptSnippet = { id: "custom-common", label: "我的常用", text: "常用正文", groupId: "general", isCommon: true };

function render(snippet: PromptSnippet, snippets: PromptSnippet[]) {
  const onChange = vi.fn();
  const close = vi.fn();
  const toggle = vi.fn();
  const node = PromptTemplateCommonAction({ snippet, snippets, onChange });
  const props = node.type === SimpleMenu ? node.props as ComponentProps<typeof SimpleMenu> : null;
  const trigger = props ? props.trigger({ open: true, controls: "common-menu", toggle }) : node;
  const children = props?.children(close);
  const nodes = elements(children);
  const item = (label: string) => nodes.find((element) => element.type === SimpleMenuItem
    && renderToStaticMarkup(<>{element.props.children as ReactNode}</>).replace(/<[^>]*>/g, "") === label)!.props as ComponentProps<typeof SimpleMenuItem>;
  const html = renderToStaticMarkup(<>{trigger}{children}</>);
  return { onChange, close, toggle, trigger: elements(trigger)[0], props, item, html };
}

describe("提示词模板常用操作", () => {
  it("设为常用按 ID 更新且保留模板、分组和原列表，不限制常用数量", () => {
    const snippets = [builtin, ...Array.from({ length: 10 }, (_, index) => ({ ...customCommon, id: `common-${index}` })), other];
    snippets.forEach(Object.freeze);
    Object.freeze(snippets);
    const view = render(other, snippets);
    expect(view.html).toContain('aria-label="将“客户反馈”设为常用"');
    expect(view.html).toContain("设为常用");
    (view.trigger.props.onClick as () => void)();
    expect(view.onChange).toHaveBeenCalledExactlyOnceWith(snippets.map((item) => item.id === other.id ? { ...item, isCommon: true } : item));
    const next = view.onChange.mock.calls[0][0] as PromptSnippet[];
    expect(next).not.toBe(snippets);
    expect(next[0]).toBe(snippets[0]);
    expect(snippets.at(-1)).toBe(other);
    expect(other.isCommon).toBeUndefined();
  });

  it("替换菜单只列其他模板，正文作为提示并明确原模板保留", () => {
    const demoted = { ...builtin, id: "workflow-diagnose", label: "已移出的内置", isCommon: false };
    const view = render(builtin, [builtin, other, customCommon, demoted]);
    expect(view.props?.menuAriaLabel).toBe("替换“整理需求”常用模板");
    expect(view.props?.menuClassName).toContain("max-h-72");
    expect(view.props?.menuClassName).toContain("overflow-y-auto");
    expect(view.html).toContain('aria-haspopup="menu"');
    expect(view.html).toContain('aria-controls="common-menu"');
    expect(view.html).toContain("替换后，原模板保留在其他模板");
    expect(view.html).toContain("替换为 客户反馈");
    expect(view.html).toContain("替换为 已移出的内置");
    expect(view.html).not.toContain("替换为 我的常用");
    expect(view.item("替换为 客户反馈").title).toBe(other.text);
    (view.trigger.props.onClick as () => void)();
    expect(view.toggle).toHaveBeenCalledOnce();
    expect(view.onChange).not.toHaveBeenCalled();
  });

  it("选择候选先关闭菜单再替换，原模板移到其他模板并保留全部字段", () => {
    const snippets = [builtin, customCommon, other];
    const view = render(builtin, snippets);
    view.item("替换为 客户反馈").onClick();
    expect(view.close).toHaveBeenCalledOnce();
    expect(view.onChange).toHaveBeenCalledExactlyOnceWith([
      { ...other, isCommon: true }, customCommon, { ...builtin, isCommon: false },
    ]);
    expect(view.close.mock.invocationCallOrder[0]).toBeLessThan(view.onChange.mock.invocationCallOrder[0]);
    expect(snippets).toEqual([builtin, customCommon, other]);
  });

  it("没有候选时显示禁用说明，仍可移出内置常用且不删除模板", () => {
    const view = render(builtin, [builtin, customCommon]);
    expect(view.item("先新增模板再替换").disabled).toBe(true);
    view.item("先新增模板再替换").onClick();
    expect(view.onChange).not.toHaveBeenCalled();
    view.item("移出常用").onClick();
    expect(view.onChange).toHaveBeenCalledExactlyOnceWith([{ ...builtin, isCommon: false }, customCommon]);
    expect(view.close.mock.invocationCallOrder[0]).toBeLessThan(view.onChange.mock.invocationCallOrder[0]);
  });

  it("以列表中的最新常用状态为准，不以过期 snippet 状态重复设为常用", () => {
    const view = render(other, [{ ...other, isCommon: true }, builtin]);
    expect(view.html).toContain("替换常用");
    expect(view.html).not.toContain("设为常用");
    view.item("移出常用").onClick();
    expect(view.onChange).toHaveBeenCalledExactlyOnceWith([{ ...other, isCommon: false }, builtin]);
  });

  it("已不存在的模板不会触发任何设置回调", () => {
    const missingOther = render(other, [builtin]);
    expect(missingOther.trigger.props.disabled).toBe(true);
    (missingOther.trigger.props.onClick as () => void)();
    expect(missingOther.onChange).not.toHaveBeenCalled();
    const missingCommon = render(builtin, [other]);
    expect(missingCommon.trigger.props.disabled).toBe(true);
    missingCommon.item("替换为 客户反馈").onClick();
    missingCommon.item("移出常用").onClick();
    expect(missingCommon.onChange).not.toHaveBeenCalled();
  });
});
