import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effectCursor: 0,
  dependencies: [] as (readonly unknown[])[],
  effects: [] as (() => void)[],
  dirty: false,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: (calculate: () => unknown) => calculate(),
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
      return [hooks.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(hooks.values[index], next)) hooks.dirty = true;
        hooks.values[index] = next;
      }];
    },
    useLayoutEffect: (effect: () => void, dependencies: readonly unknown[]) => {
      const index = hooks.effectCursor++;
      const previous = hooks.dependencies[index];
      if (!previous || dependencies.some((item, at) => !Object.is(item, previous[at]))) {
        hooks.effects.push(effect);
        hooks.dependencies[index] = dependencies;
      }
    },
  };
});

import { SnippetsSection } from "./SettingsView";
import { PromptTemplateEditor } from "@/components/settings/PromptTemplateEditor";
import { Disclosure } from "@/components/ui/disclosure";
import { defaultSettings, type PromptSnippet } from "@/store/notesStore";
import { WORKFLOW_PROMPT_SNIPPETS } from "@/lib/promptTemplates";

type Node = ReactElement<Record<string, unknown>>;
function visibleElements(node: ReactNode): Node[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    const closed = child.type === Disclosure && !(child.props.open ?? child.props.defaultOpen);
    return [child, ...(closed ? [] : visibleElements(child.props.children as ReactNode))];
  });
}

const custom = { id: "custom-first", label: "自建模板", text: "保留原文：{内容}", groupId: "general" };
function mount(snippets: PromptSnippet[] = [custom, WORKFLOW_PROMPT_SNIPPETS[0]!]) {
  let props: ComponentProps<typeof SnippetsSection> = {
    settings: { ...defaultSettings(), promptSnippets: snippets },
    patch: vi.fn(),
  };
  let nodes: Node[] = [];
  const render = (next: Partial<typeof props> = {}) => {
    props = { ...props, ...next };
    let passes = 0;
    do {
      hooks.cursor = 0;
      hooks.effectCursor = 0;
      hooks.dirty = false;
      nodes = visibleElements(SnippetsSection(props));
      hooks.effects.splice(0).forEach((effect) => effect());
      if (++passes > 10) throw new Error("搜索展开未稳定");
    } while (hooks.dirty);
  };
  const editor = () => nodes.find((node) => node.type === PromptTemplateEditor)!.props as ComponentProps<typeof PromptTemplateEditor>;
  const disclosure = (title: string) => nodes.find((node) => node.type === Disclosure && node.props.title === title)!.props as ComponentProps<typeof Disclosure>;
  const search = (sequence = 1) => render({ searchTarget: "试用预览", searchSequence: sequence });
  render();
  return { render, editor, disclosure, search, patch: props.patch as ReturnType<typeof vi.fn>, nodes: () => nodes };
}

beforeEach(() => {
  hooks.values = [];
  hooks.dependencies = [];
  hooks.effects = [];
});

describe("试用预览搜索直达", () => {
  it("AI 创建入口打开新增区及助手，保留草稿且传入最新 AI 配置", () => {
    const view = mount();
    const create = () => (view.nodes().find((node) => node.props.children === "AI 创建模板")!.props.onClick as () => void)();
    create();
    view.render();
    expect(view.disclosure("新增模板").open).toBe(true);
    expect(view.editor().aiOpen).toBe(true);
    view.editor().onLabelChange("新增草稿");
    view.editor().onTextChange("草稿正文：{内容}");
    view.disclosure("新增模板").onOpenChange!(false);
    view.render();
    create();
    const settings = { ...defaultSettings(), promptSnippets: [custom], aiEnabled: true, aiBaseUrl: "https://new.example/v1", aiModel: "new-model" };
    view.render({ settings });
    expect(view.editor()).toMatchObject({ label: "新增草稿", text: "草稿正文：{内容}", aiOpen: true, aiSettings: settings });
    expect(view.patch).not.toHaveBeenCalled();
  });

  it("保存新增模板后关闭新增和 AI 面板，展开其他模板且不被同一搜索请求重新打开", () => {
    const view = mount();
    (view.nodes().find((node) => node.props.children === "AI 创建模板")!.props.onClick as () => void)();
    view.render();
    view.editor().onLabelChange("新增模板名称");
    view.editor().onTextChange("新增正文");
    view.render();
    view.search();
    view.editor().onSave();
    view.render();
    expect(view.disclosure("新增模板").open).toBe(false);
    expect(view.disclosure("其他模板").open).toBe(true);
    expect(view.nodes().some((node) => node.type === PromptTemplateEditor)).toBe(false);
    expect(view.patch).toHaveBeenCalledOnce();
    expect(view.patch.mock.calls[0]![0].promptSnippets.at(-1)).toMatchObject({ label: "新增模板名称", text: "新增正文", groupId: "general" });
    view.disclosure("新增模板").onOpenChange!(true);
    view.render();
    expect(view.editor()).toMatchObject({ aiOpen: false, label: "", text: "" });
  });

  it("没有草稿时打开第一个现有模板及其他模板父区，不写入设置", () => {
    const view = mount();
    view.search();
    expect(view.disclosure("其他模板").open).toBe(true);
    expect(view.editor()).toMatchObject({ label: custom.label, text: custom.text, previewOpen: true });
    expect(view.patch).not.toHaveBeenCalled();
  });

  it("被替换的内置模板搜索时展开其他模板，并保留修改草稿", () => {
    const builtin = { ...WORKFLOW_PROMPT_SNIPPETS[0]!, isCommon: false };
    const view = mount([builtin, { ...custom, isCommon: true }]);
    view.search();
    expect(view.disclosure("其他模板").open).toBe(true);
    view.editor().onTextChange("内置模板的未保存修改");
    view.disclosure("其他模板").onOpenChange!(false);
    view.render();
    view.search(2);
    expect(view.disclosure("其他模板").open).toBe(true);
    expect(view.editor()).toMatchObject({ label: builtin.label, text: "内置模板的未保存修改", previewOpen: true });
    expect(view.patch).not.toHaveBeenCalled();
  });

  it("自建常用模板的预览搜索不展开无关的其他模板", () => {
    const view = mount([{ ...custom, isCommon: true }, { ...WORKFLOW_PROMPT_SNIPPETS[0]!, isCommon: false }]);
    view.search();
    expect(view.disclosure("其他模板").open).toBe(false);
    expect(view.editor()).toMatchObject({ label: custom.label, previewOpen: true });
    expect(view.patch).not.toHaveBeenCalled();
  });

  it("保留已有编辑草稿，父区被收起后也能重新展开预览", () => {
    const view = mount();
    view.search();
    view.editor().onTextChange("尚未保存的新正文：{内容}");
    view.editor().onLabelChange("尚未保存的新名称");
    view.editor().onPreviewOpenChange!(false);
    view.disclosure("其他模板").onOpenChange!(false);
    view.render();
    view.search(2);
    expect(view.editor()).toMatchObject({ label: "尚未保存的新名称", text: "尚未保存的新正文：{内容}", previewOpen: true });
    expect(view.disclosure("其他模板").open).toBe(true);
    expect(view.patch).not.toHaveBeenCalled();
  });

  it("保留已收起的新增草稿，不用现有模板替换它", () => {
    const view = mount();
    view.disclosure("新增模板").onOpenChange!(true);
    view.render();
    view.editor().onLabelChange("我的新模板");
    view.editor().onTextChange("新增草稿：{内容}");
    view.disclosure("新增模板").onOpenChange!(false);
    view.render();
    view.search();
    expect(view.disclosure("新增模板").open).toBe(true);
    expect(view.editor()).toMatchObject({ label: "我的新模板", text: "新增草稿：{内容}", previewOpen: true });
    expect(view.editor().onCancel).toBeUndefined();
    expect(view.patch).not.toHaveBeenCalled();
  });

  it("没有模板时打开空白新增表单及预览，不补造模板", () => {
    const view = mount([]);
    view.search();
    expect(view.disclosure("新增模板").open).toBe(true);
    expect(view.editor()).toMatchObject({ label: "", text: "", previewOpen: true });
    expect(view.patch).not.toHaveBeenCalled();
  });

  it("保存或取消后同一请求不会重开，新搜索请求仍可再次打开", () => {
    const view = mount();
    view.search();
    view.editor().onSave();
    view.render();
    expect(view.patch).toHaveBeenCalledOnce();
    expect(view.nodes().some((node) => node.type === PromptTemplateEditor)).toBe(false);
    view.search(2);
    expect(view.editor().previewOpen).toBe(true);
    view.editor().onCancel!();
    view.render();
    expect(view.nodes().some((node) => node.type === PromptTemplateEditor)).toBe(false);
    expect(view.patch).toHaveBeenCalledOnce();
  });

  it("清空搜索后允许重新从序号 1 打开预览", () => {
    const view = mount();
    view.search(1);
    view.editor().onCancel!();
    view.render();
    expect(view.nodes().some((node) => node.type === PromptTemplateEditor)).toBe(false);
    view.render({ searchTarget: null, searchSequence: 0 });
    view.search(1);
    expect(view.editor()).toMatchObject({ text: custom.text, previewOpen: true });
    expect(view.patch).not.toHaveBeenCalled();
  });
});
