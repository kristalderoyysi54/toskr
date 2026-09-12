import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const menu = vi.hoisted(() => ({
  page: "main",
  items: new Map<string, { onClick?: () => void; onSelect?: (event: Event) => void }>(),
  flyouts: new Map<string, () => { entries: unknown[]; handlers: Map<string, () => void> }>(),
  open: undefined as ((open: boolean) => void) | undefined,
  keydown: undefined as ((event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void) | undefined,
  snippets: {
    prioritized: [
      { id: "workflow-requirement", label: "整理需求", text: "整理：{内容}" },
      { id: "workflow-debug", label: "分析问题", text: "分析：{内容}" },
      { id: "workflow-review", label: "审查方案", text: "审查：{内容}" },
    ],
    remaining: [
      { id: "custom-minimal", label: "最小修改提示词", text: "保留我的原指令：\n{内容}\n不要改写此模板" },
      { id: "translate", label: "翻译成中文", text: "翻译：{内容}" },
    ],
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => initial === "main"
      ? [menu.page, (page: string) => { menu.page = page; }]
      : actual.useState(initial),
  };
});

vi.mock("@/lib/targetProfiles", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/targetProfiles")>(),
  promptSnippetsForGroup: () => menu.snippets,
}));

vi.mock("@/components/MenuFlyoutTrigger", () => ({
  MenuFlyoutTrigger: (props: { label: string; getSource: () => { entries: unknown[]; handlers: Map<string, () => void> } }) => {
    menu.flyouts.set(props.label, props.getSource);
    return createElement("button", { "data-flyout-trigger": props.label }, props.label);
  },
}));

vi.mock("@/lib/actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/actions")>(),
  sendNotesToChat: vi.fn(),
}));

vi.mock("@/components/ui/context-menu", () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    ...Object.fromEntries([
      "ContextMenuTrigger", "ContextMenuLabel", "ContextMenuShortcut", "ContextMenuSubTrigger", "ContextMenuSubContent",
    ].map((name) => [name, (props: { children: ReactNode }) => wrapper(props)])),
    ContextMenu: ({ children, onOpenChange }: { children: ReactNode; onOpenChange: typeof menu.open }) => {
      menu.open = onOpenChange;
      return wrapper({ children });
    },
    ContextMenuSub: ({ children }: { children: ReactNode }) => createElement("div", { "data-submenu": "" }, children),
    ContextMenuSeparator: () => createElement("hr"),
    ContextMenuContent: ({ children, onKeyDownCapture }: { children: ReactNode; onKeyDownCapture: typeof menu.keydown }) => {
      menu.keydown = onKeyDownCapture;
      return createElement("div", { "data-note-menu": "" }, children);
    },
    ContextMenuItem: (props: {
      children: ReactNode;
      onClick?: () => void;
      onSelect?: (event: Event) => void;
      disabled?: boolean;
    }) => {
      const label = renderToStaticMarkup(createElement("span", null, props.children)).replace(/<[^>]*>/g, "").trim();
      menu.items.set(label, props);
      return createElement("button", { disabled: props.disabled }, props.children);
    },
  };
});

import { sendNotesToChat } from "@/lib/actions";
import { useNotesStore, type Note } from "@/store/notesStore";
import { NoteCard } from "./NoteCard";

const note: Note = { id: "template-note", text: "页面打不开", sectionId: "inbox", done: false, createdAt: 1 };
const renderMenu = () => {
  menu.items.clear();
  return renderToStaticMarkup(createElement(NoteCard, { note })).split('data-note-menu=""')[1]!;
};

beforeEach(() => {
  menu.page = "main";
  vi.mocked(sendNotesToChat).mockClear();
  useNotesStore.setState({ notes: [note], checkedIds: [] });
});

describe("发送选项子菜单小窗", () => {
  it("主层只留触发行，子菜单条目按顺序投影：模板列表、检查后发送、保存为某次回复", () => {
    const html = renderMenu();
    expect(html).toContain('data-flyout-trigger="发送选项"');
    expect(html).not.toContain("其他模板（2）");
    expect(html).not.toContain("整理需求");
    const source = menu.flyouts.get("发送选项")!();
    const labels = source.entries.map((entry) => (entry as { label?: string; kind: string }).label ?? entry);
    expect(labels).toEqual([
      "用模板发送",
      "整理需求", "分析问题", "审查方案",
      { kind: "separator", id: expect.any(String) },
      "最小修改提示词", "翻译成中文",
      "检查后发送…",
      "保存为某次回复",
    ]);
  });

  it("小窗回传条目 id 后按原模板正文与原 id 发送", () => {
    renderMenu();
    const source = menu.flyouts.get("发送选项")!();
    const entry = source.entries.find(
      (item) => (item as { label?: string }).label === "最小修改提示词"
    ) as { id: string };
    source.handlers.get(entry.id)!();
    expect(sendNotesToChat).toHaveBeenCalledExactlyOnceWith(
      [note.id], menu.snippets.remaining[0]!.text, { promptSnippetId: "custom-minimal" }
    );
  });
});
