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

const labelsOf = (entries: unknown[]) =>
  entries.map((entry) => (entry as { label?: string; kind: string }).label ?? (entry as { kind: string }).kind);

describe("右键菜单骨架（方案 A）", () => {
  it("一级：发送区三项、常用区、整理与转换两个小窗；无溯源时没有回复关联", () => {
    const html = renderMenu();
    expect(html).toContain('data-flyout-trigger="用模板发送"');
    expect(html).toContain('data-flyout-trigger="整理"');
    expect(html).toContain('data-flyout-trigger="转换与导出"');
    expect(html).not.toContain('data-flyout-trigger="回复关联"');
    expect(html).not.toContain("发送选项");
    expect(html.indexOf("检查后发送…")).toBeLessThan(html.indexOf("用模板发送"));
    // 「保存为某次回复…」归入整理，不再混在发送选项里
    expect(labelsOf(menu.flyouts.get("整理")!().entries)).toContain("保存为某次回复…");
  });

  it("有溯源时回复关联单独成小窗，五个操作都在里面", () => {
    const linked: Note = {
      ...note,
      provenance: {
        kind: "deliveryResult",
        deliveryId: "d1",
        capturedAtMs: 1,
        sourceBundle: "com.example.chat",
        sourceItemIds: [],
      },
    };
    menu.items.clear();
    renderToStaticMarkup(createElement(NoteCard, { note: linked }));
    expect(labelsOf(menu.flyouts.get("回复关联")!().entries)).toEqual([
      "查看发送内容", "检查这条回复…", "更换对应发送…", "占位符映射已失效", "这不是对应回复…",
    ]);
  });

});

describe("用模板发送小窗", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
  });

  it("分组：当前目标推荐 → 其他模板，模板正文作为副标题，末尾管理入口与 ⌥ 提示", () => {
    renderMenu();
    const entries = menu.flyouts.get("用模板发送")!().entries;
    expect(labelsOf(entries)).toEqual([
      "当前目标推荐", "整理需求", "分析问题", "审查方案",
      "separator",
      "其他模板", "最小修改提示词", "翻译成中文",
      "separator",
      "管理模板…",
      "按住 ⌥ 点击：先检查再发送",
    ]);
    const first = entries.find((entry) => (entry as { label?: string }).label === "最小修改提示词") as { hint?: string };
    expect(first.hint).toBe("保留我的原指令： {内容} 不要改写此模板");
  });

  it("点选后按原模板正文与原 id 发送，并记为最近使用置顶", () => {
    renderMenu();
    const source = menu.flyouts.get("用模板发送")!();
    const entry = source.entries.find(
      (item) => (item as { label?: string }).label === "最小修改提示词"
    ) as { id: string };
    source.handlers.get(entry.id)!();
    expect(sendNotesToChat).toHaveBeenCalledExactlyOnceWith(
      [note.id], menu.snippets.remaining[0]!.text, { promptSnippetId: "custom-minimal" }
    );
    renderMenu();
    const labels = labelsOf(menu.flyouts.get("用模板发送")!().entries);
    expect(labels.slice(0, 2)).toEqual(["最近使用", "最小修改提示词"]);
    expect(labels.filter((label) => label === "最小修改提示词")).toHaveLength(1);
  });

  it("没有模板时只有可点击的「添加模板…」", () => {
    const saved = menu.snippets;
    menu.snippets = { prioritized: [], remaining: [] };
    renderMenu();
    const entries = menu.flyouts.get("用模板发送")!().entries as { label?: string; disabled?: boolean }[];
    expect(entries.map((entry) => entry.label)).toEqual(["添加模板…"]);
    expect(entries[0]!.disabled).toBe(false);
    menu.snippets = saved;
  });
});
