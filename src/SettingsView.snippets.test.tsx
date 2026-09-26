import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IconButton } from "@/components/ui/icon-button";
import type { SimpleSelect } from "@/components/SimpleSelect";
import type { Disclosure } from "@/components/ui/disclosure";
import type { Button } from "@/components/ui/button";

const controls = vi.hoisted(() => ({
  icons: [] as ComponentProps<typeof IconButton>[],
  selects: [] as ComponentProps<typeof SimpleSelect>[],
  buttons: [] as ComponentProps<typeof Button>[],
  expandOthers: false,
  expandGroups: false,
  expandAdd: false,
  exportTemplates: vi.fn(),
  tip: vi.fn(),
}));

vi.mock("@/lib/promptTemplateExport", () => ({ exportPromptTemplates: controls.exportTemplates }));
vi.mock("@/lib/tip", () => ({ tip: controls.tip }));
vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  return {
    ...actual,
    Button: (props: ComponentProps<typeof Button>) => {
      controls.buttons.push(props);
      return <actual.Button {...props} />;
    },
  };
});

vi.mock("@/components/ui/icon-button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/icon-button")>();
  return {
    IconButton: (props: ComponentProps<typeof IconButton>) => {
      controls.icons.push(props);
      return <actual.IconButton {...props} />;
    },
  };
});
vi.mock("@/components/SimpleSelect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/SimpleSelect")>();
  return {
    SimpleSelect: (props: ComponentProps<typeof SimpleSelect>) => {
      controls.selects.push(props);
      return <actual.SimpleSelect {...props} />;
    },
  };
});
vi.mock("@/components/ui/disclosure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/disclosure")>();
  return {
    ...actual,
    Disclosure: (props: ComponentProps<typeof Disclosure>) => (
      <actual.Disclosure
        {...props}
        open={
          (controls.expandOthers && props.title.startsWith("其他模板")) ||
          (controls.expandAdd && props.title === "新增模板") || props.open
        }
        defaultOpen={
          (controls.expandOthers && props.title.startsWith("其他模板")) ||
          (controls.expandGroups && props.title === "管理提示词组") ||
          (controls.expandAdd && props.title === "新增模板")
        }
      />
    ),
  };
});

import { SnippetsSection } from "./SettingsView";
import { defaultSettings, type PromptSnippet, type Settings } from "@/store/notesStore";
import { WORKFLOW_PROMPT_SNIPPETS, WORKFLOW_PROMPT_SNIPPET_IDS } from "@/lib/promptTemplates";

const snippets: PromptSnippet[] = [
  { id: "custom-first", label: "自定义甲", text: "自定义甲正文", groupId: "general" },
  { id: WORKFLOW_PROMPT_SNIPPET_IDS[1]!, label: "常用乙", text: "常用乙正文", groupId: "general" },
  { id: "custom-middle", label: "自定义乙", text: "自定义乙正文", groupId: "general" },
  { id: WORKFLOW_PROMPT_SNIPPET_IDS[0]!, label: "常用甲", text: "常用甲正文", groupId: "general" },
  { id: WORKFLOW_PROMPT_SNIPPET_IDS[2]!, label: "常用丙", text: "常用丙正文", groupId: "general" },
  { id: "review", label: "旧审查模板", text: "旧审查正文", groupId: "general" },
];

function render(promptSnippets = snippets) {
  const patch = vi.fn<(change: Partial<Settings>) => void>();
  const html = renderToStaticMarkup(
    <SnippetsSection
      settings={{ ...defaultSettings(), promptSnippets }}
      patch={patch}
    />
  );
  const lastSnippets = () => patch.mock.calls.at(-1)![0].promptSnippets!;
  return { html, patch, lastSnippets };
}

function click(label: string, index: number) {
  const button = controls.icons.filter((icon) => icon.label === label)[index]!;
  expect(button.disabled).not.toBe(true);
  button.onClick!({} as React.MouseEvent<HTMLButtonElement>);
}

describe("设置中的常用提示词模板", () => {
  beforeEach(() => {
    controls.icons = [];
    controls.selects = [];
    controls.buttons = [];
    controls.expandOthers = false;
    controls.expandGroups = false;
    controls.expandAdd = false;
    controls.exportTemplates.mockReset().mockResolvedValue(null);
    controls.tip.mockClear();
  });

  it("常用模板默认可见，旧模板与自定义项统一收起且显示总数", () => {
    const { html } = render();
    expect(html).toContain("常用模板");
    expect(html).toContain("常用甲正文");
    expect(html).toContain("常用乙正文");
    expect(html).toContain("常用丙正文");
    expect(html).toContain(">其他模板</span>");
    expect(html).toContain(">3 个</span>");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("自定义甲正文");
    expect(html).not.toContain("旧审查正文");
    expect(html).toContain("选用模板后，模板会和选中内容组合后发送");
    expect(html).toContain("管理提示词组");
    expect(html).not.toContain("新建提示词组");
    expect(html).toContain("新增模板");
    expect(html).not.toContain('placeholder="模板内容，写 {内容} 指定插入位置，支持多行"');
    expect(html.indexOf("管理提示词组")).toBeGreaterThan(html.indexOf("常用丙正文"));
  });

  it("上移下移边界按当前展示区判断，避免移动后顺序没有可见变化", () => {
    controls.expandOthers = true;
    render();
    const up = controls.icons.filter((icon) => icon.label === "上移");
    const down = controls.icons.filter((icon) => icon.label === "下移");
    expect(up[0]!.disabled).toBe(true);
    expect(up[1]!.disabled).toBe(false);
    expect(up[3]!.disabled).toBe(true);
    expect(down[2]!.disabled).toBe(true);
    expect(down[3]!.disabled).toBe(false);
    expect(down[5]!.disabled).toBe(true);
  });

  it("常用项移动交换原数组中的同区相邻id，其他模板保持原位", () => {
    const { lastSnippets } = render();
    click("下移", 0);
    expect(lastSnippets().map((item) => item.id)).toEqual([
      snippets[0]!.id, snippets[3]!.id, snippets[2]!.id, snippets[1]!.id,
      snippets[4]!.id, snippets[5]!.id,
    ]);
  });

  it("自建常用与降级内置项按覆盖标记分区，移动使用新的同区邻居", () => {
    const customized = snippets.map((snippet) => snippet.id === "custom-first"
      ? { ...snippet, isCommon: true }
      : snippet.id === WORKFLOW_PROMPT_SNIPPET_IDS[1]
        ? { ...snippet, isCommon: false }
        : snippet);
    const { html, lastSnippets } = render(customized);
    expect(html).toContain("自定义甲正文");
    expect(html).not.toContain("常用乙正文");
    expect(html).toContain(">3 个</span>");
    click("下移", 0);
    expect(lastSnippets().map((snippet) => snippet.id)).toEqual([
      snippets[3]!.id, snippets[1]!.id, snippets[2]!.id,
      snippets[0]!.id, snippets[4]!.id, snippets[5]!.id,
    ]);
    expect(lastSnippets().find((snippet) => snippet.id === "custom-first")?.isCommon).toBe(true);
    expect(lastSnippets().find((snippet) => snippet.id === WORKFLOW_PROMPT_SNIPPET_IDS[1])?.isCommon).toBe(false);
  });

  it("全部移出常用后保留其他模板及设置入口", () => {
    const { html } = render(snippets.map((snippet) => ({ ...snippet, isCommon: false })));
    expect(html).toContain("暂无常用模板");
    expect(html).toContain(">其他模板</span>");
    expect(html).toContain(">6 个</span>");
  });

  it("其他模板移动与删除都命中原id，不使用折叠分区的局部下标", () => {
    controls.expandOthers = true;
    const { lastSnippets } = render();
    click("下移", 4);
    expect(lastSnippets().map((item) => item.id)).toEqual([
      snippets[0]!.id, snippets[1]!.id, snippets[5]!.id, snippets[3]!.id,
      snippets[4]!.id, snippets[2]!.id,
    ]);
    click("删除模板", 4);
    expect(lastSnippets()).toEqual(snippets.filter((item) => item.id !== "custom-middle"));
  });

  it("修改其他模板所属分组只更新该id，保留常用与其他项顺序", () => {
    controls.expandOthers = true;
    const { lastSnippets } = render();
    controls.selects.find((select) => select.ariaLabel === "自定义乙 所属提示词组")!.onChange("other-group");
    expect(lastSnippets()).toEqual(snippets.map((item) =>
      item.id === "custom-middle" ? { ...item, groupId: "other-group" } : item
    ));
  });

  it("页尾展开后仍可访问提示词组管理", () => {
    controls.expandGroups = true;
    const { html } = render();
    expect(html).toContain("新建提示词组");
    expect(html).toContain('aria-label="新提示词组名称"');
    expect(html.indexOf("新建提示词组")).toBeGreaterThan(html.indexOf("常用丙正文"));
  });

  it("来源标记区分内置、已修改和自建项", () => {
    controls.expandOthers = true;
    const { html } = render([WORKFLOW_PROMPT_SNIPPETS[0]!, snippets[1]!, snippets[0]!]);
    expect(html).toContain(">内置</span>");
    expect(html).toContain(">内置·已修改</span>");
    expect(html).toContain(">自建</span>");
  });

  it("展开新增表单后可使用试用预览，默认不展开试用内容", () => {
    controls.expandAdd = true;
    const { html } = render();
    expect(html).toContain('placeholder="模板内容，写 {内容} 指定插入位置，支持多行"');
    expect(html).toContain("试用预览");
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[\s=>])/);
    expect(html).toContain("添加模板");
  });

  it("导出当前全部已保存模板及分组，成功后反馈实际数量", async () => {
    controls.exportTemplates.mockResolvedValue({ path: "/tmp/templates.json", count: snippets.length });
    const { patch } = render();
    await controls.buttons.find((button) => button.children === "导出所有模板")!.onClick!({} as React.MouseEvent<HTMLButtonElement>);
    expect(controls.exportTemplates).toHaveBeenCalledExactlyOnceWith(snippets, defaultSettings().promptGroups);
    expect(controls.tip).toHaveBeenCalledExactlyOnceWith("ok", "已导出 6 个提示词模板");
    expect(patch).not.toHaveBeenCalled();
  });

  it("取消保存不报成功，也不改变模板", async () => {
    const { patch } = render();
    await controls.buttons.find((button) => button.children === "导出所有模板")!.onClick!({} as React.MouseEvent<HTMLButtonElement>);
    expect(controls.tip).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("导出失败使用现有提示通道反馈", async () => {
    controls.exportTemplates.mockRejectedValue(new Error("磁盘不可写"));
    render();
    await controls.buttons.find((button) => button.children === "导出所有模板")!.onClick!({} as React.MouseEvent<HTMLButtonElement>);
    expect(controls.tip).toHaveBeenCalledExactlyOnceWith("warn", "模板导出失败：Error: 磁盘不可写");
  });
});
