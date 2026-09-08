import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const menu = vi.hoisted(() => ({
  open: true,
  expanded: false,
  items: new Map<string, { onClick: () => void; expanded?: boolean }>(),
  setOpen: undefined as ((open: boolean) => void) | undefined,
  close: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => initial === false
      ? [menu.expanded, (expanded: boolean) => { menu.expanded = expanded; }]
      : actual.useState(initial),
  };
});

vi.mock("@/components/SimpleMenu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/SimpleMenu")>();
  return {
    ...actual,
    SimpleMenu: ({ trigger, children, onOpenChange }: ComponentProps<typeof actual.SimpleMenu>) => {
      menu.setOpen = (open) => {
        menu.open = open;
        onOpenChange?.(open);
      };
      return createElement("div", null,
        trigger({ open: menu.open, controls: "template-menu", toggle: () => menu.setOpen!(!menu.open) }),
        menu.open && children(() => {
          menu.close();
          menu.setOpen!(false);
        })
      );
    },
    SimpleMenuItem: (props: ComponentProps<typeof actual.SimpleMenuItem>) => {
      const label = renderToStaticMarkup(createElement("span", null, props.children)).replace(/<[^>]*>/g, "").trim();
      menu.items.set(label, props);
      return createElement(actual.SimpleMenuItem, props);
    },
  };
});

import { PromptTemplateSelect } from "./PromptTemplateSelect";

const prioritized = [
  { id: "workflow-requirements", label: "整理需求", text: "整理：{内容}", groupId: "general" },
  { id: "workflow-diagnose", label: "分析问题", text: "分析：{内容}", groupId: "general" },
  { id: "workflow-review-plan", label: "审查方案", text: "审查：{内容}", groupId: "general" },
];
const remaining = [
  { id: "custom-minimal", label: "最小修改提示词", text: "我的原始指令：{内容}", groupId: "custom" },
  { id: "translate", label: "翻译成中文", text: "翻译：{内容}", groupId: "general" },
];
const onChange = vi.fn();
const render = (value = "none") => {
  menu.items.clear();
  return renderToStaticMarkup(<PromptTemplateSelect value={value} prioritized={prioritized} remaining={remaining} onChange={onChange} />);
};

beforeEach(() => {
  menu.open = true;
  menu.expanded = false;
  menu.close.mockClear();
  onChange.mockClear();
});

describe("预检模板选择", () => {
  it("默认只显示无模板和三个常用项，展开及收起其他模板不更新草稿", () => {
    const html = render();
    for (const snippet of prioritized) expect(html).toContain(snippet.label);
    expect(menu.items.has("无模板")).toBe(true);
    expect(menu.items.has("最小修改提示词")).toBe(false);
    expect(menu.items.get("其他模板（2）")!.expanded).toBe(false);
    menu.items.get("其他模板（2）")!.onClick();
    expect(menu.expanded).toBe(true);
    const expanded = render();
    expect(expanded).toContain('aria-expanded="true"');
    expect(menu.items.has("最小修改提示词")).toBe(true);
    expect(menu.items.has("翻译成中文")).toBe(true);
    menu.items.get("其他模板（2）")!.onClick();
    expect(menu.expanded).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(menu.close).not.toHaveBeenCalled();
  });

  it("选择旧模板回传原 ID 并关闭菜单", () => {
    menu.expanded = true;
    render();
    menu.items.get("最小修改提示词")!.onClick();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("custom-minimal");
    expect(menu.close).toHaveBeenCalledOnce();
  });

  it("旧模板未展开时，触发按钮仍显示当前名称并可改回无模板", () => {
    const html = render("custom-minimal");
    expect(html).toContain('aria-label="本次提示词模板：最小修改提示词"');
    expect(html).toContain('title="最小修改提示词"');
    expect(menu.items.has("最小修改提示词")).toBe(false);
    menu.items.get("无模板")!.onClick();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("none");
    expect(menu.close).toHaveBeenCalledOnce();
  });

  it("重新打开时收起其他模板，不改变已经选中的模板", () => {
    menu.expanded = true;
    render("custom-minimal");
    menu.setOpen!(false);
    menu.setOpen!(true);
    expect(menu.expanded).toBe(false);
    const html = render("custom-minimal");
    expect(menu.items.has("最小修改提示词")).toBe(false);
    expect(html).toContain('aria-label="本次提示词模板：最小修改提示词"');
    expect(onChange).not.toHaveBeenCalled();
  });

  it("本次自定义模板保留名称，选中当前项不重复更新草稿", () => {
    const html = render("custom");
    expect(html).toContain('aria-label="本次提示词模板：本次自定义模板"');
    menu.items.get("本次自定义模板")!.onClick();
    expect(onChange).not.toHaveBeenCalled();
    expect(menu.close).toHaveBeenCalledOnce();
  });
});
