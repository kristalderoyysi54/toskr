import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sample = vi.hoisted(() => ({ value: "" }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useId: () => "template-trial",
    useState: () => [sample.value, (value: string) => { sample.value = value; }],
  };
});

import { PromptTemplateEditor } from "./PromptTemplateEditor";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)]
    : []);
}

function render(overrides: Partial<ComponentProps<typeof PromptTemplateEditor>> = {}) {
  const props = {
    label: "分析问题",
    text: "请分析：\n{内容}\n先不修改。",
    groupId: "general",
    groupOptions: [{ value: "general", label: "通用" }],
    onLabelChange: vi.fn(),
    onTextChange: vi.fn(),
    onGroupChange: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const nodes = elements(PromptTemplateEditor(props));
  const byId = (suffix: string) => nodes.find((node) => node.props.id === `template-trial-${suffix}`)!;
  const preview = nodes.find((node) => node.type === "pre")!;
  return { props, nodes, byId, preview: preview.props.children as string };
}

beforeEach(() => { sample.value = ""; });

describe("模板编辑试用预览", () => {
  it("默认收起且使用具体示例，每个标签只关联一个输入控件", () => {
    const { nodes, byId, preview } = render();
    expect(nodes.find((node) => node.type === "details")!.props.open).toBeUndefined();
    expect(preview).toBe(`请分析：\n${byId("material").props.placeholder}\n先不修改。`);
    for (const label of nodes.filter((node) => node.type === "label")) {
      expect(nodes.filter((node) => node.props.id === label.props.htmlFor)).toHaveLength(1);
      expect(elements(label.props.children as ReactNode)).toHaveLength(0);
    }
  });

  it("示例材料只用于当前未保存模板的本地组合，不触发保存或模板修改", () => {
    const first = render();
    const change = first.byId("material").props.onChange as (event: { target: { value: string } }) => void;
    change({ target: { value: "价格 $& <script>示例</script>" } });
    const updated = render({ ...first.props, text: "未保存的新模板：{内容}", label: "未保存名称" });
    expect(updated.preview).toBe("未保存的新模板：价格 $& <script>示例</script>");
    expect(first.props.onSave).not.toHaveBeenCalled();
    expect(first.props.onTextChange).not.toHaveBeenCalled();
    expect(first.props.onLabelChange).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(updated.nodes.find((node) => node.type === "pre")!);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("无占位符时按实际发送规则追加材料，清空材料后恢复示例", () => {
    sample.value = "客户要求周五前交付";
    const current = render({ text: "请整理任务" });
    expect(current.preview).toBe("请整理任务\n\n客户要求周五前交付");
    (current.byId("material").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "" } });
    const cleared = render({ text: "请整理任务" });
    expect(cleared.preview).toBe(`请整理任务\n\n${cleared.byId("material").props.placeholder}`);
  });

  it("编辑输入和保存取消保留原回调，新增空模板不能点击添加", () => {
    const current = render();
    (current.byId("text").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "新模板" } });
    expect(current.props.onTextChange).toHaveBeenCalledExactlyOnceWith("新模板");
    const key = current.byId("text").props.onKeyDown as (event: { key: string; metaKey?: boolean; preventDefault: () => void }) => void;
    const preventDefault = vi.fn();
    key({ key: "Enter", metaKey: true, preventDefault });
    expect(current.props.onSave).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    key({ key: "Escape", preventDefault });
    expect(current.props.onCancel).toHaveBeenCalledOnce();
    const empty = render({ label: "", text: "", onCancel: undefined });
    expect(empty.nodes.find((node) => node.props.children === "添加模板")!.props.disabled).toBe(true);
  });

  it("搜索可控制预览展开，并保留示例材料及手动收起回调", () => {
    sample.value = "正在使用的示例材料";
    const onPreviewOpenChange = vi.fn();
    const current = render({ previewOpen: true, onPreviewOpenChange });
    const details = current.nodes.find((node) => node.type === "details")!;
    expect(details.props.open).toBe(true);
    expect(details.props["data-settings-search"]).toBe("试用预览");
    expect(current.preview).toContain("正在使用的示例材料");
    (details.props.onToggle as (event: { currentTarget: { open: boolean } }) => void)({ currentTarget: { open: false } });
    expect(onPreviewOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(sample.value).toBe("正在使用的示例材料");
    expect(current.props.onSave).not.toHaveBeenCalled();
  });
});
