import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const menu = vi.hoisted(() => ({
  page: "main",
  items: new Map<string, { onClick?: () => void; onSelect?: (event: Event) => void }>(),
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
const select = (label: string) => {
  const event = new Event("select", { cancelable: true });
  menu.items.get(label)!.onSelect!(event);
  return event;
};

beforeEach(() => {
  menu.page = "main";
  vi.mocked(sendNotesToChat).mockClear();
  useNotesStore.setState({ notes: [note], checkedIds: [] });
});

describe("笔记的其他模板页", () => {
  it("常用模板直接显示，展开其他模板只切页，旧模板按原文和原 id 发送", () => {
    renderMenu();
    expect(select("发送选项").defaultPrevented).toBe(true);
    const mainTemplates = renderMenu();
    expect(mainTemplates).toContain("整理需求");
    expect(mainTemplates).toContain("分析问题");
    expect(mainTemplates).toContain("审查方案");
    expect(mainTemplates).toContain("其他模板（2）");
    expect(mainTemplates).not.toContain("最小修改提示词");
    expect(mainTemplates).not.toContain("翻译成中文");
    expect(select("其他模板（2）").defaultPrevented).toBe(true);
    expect(sendNotesToChat).not.toHaveBeenCalled();
    const otherTemplates = renderMenu();
    expect(otherTemplates).toContain("最小修改提示词");
    expect(otherTemplates).toContain("翻译成中文");
    expect(otherTemplates).not.toContain("data-submenu");
    menu.items.get("最小修改提示词")!.onClick!();
    expect(sendNotesToChat).toHaveBeenCalledExactlyOnceWith(
      [note.id], menu.snippets.remaining[0]!.text, { promptSnippetId: "custom-minimal" }
    );
  });

  it("返回按钮和左方向键回发送选项，菜单重新打开回主层", () => {
    menu.page = "other-templates";
    renderMenu();
    expect(select("返回发送选项").defaultPrevented).toBe(true);
    expect(menu.page).toBe("send");
    menu.page = "other-templates";
    renderMenu();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    menu.keydown!({ key: "ArrowLeft", preventDefault, stopPropagation });
    expect(menu.page).toBe("send");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    menu.page = "other-templates";
    menu.open!(true);
    expect(menu.page).toBe("main");
    const reopened = renderMenu();
    expect(reopened).toContain("发送选项");
    expect(reopened).not.toContain("最小修改提示词");
    expect(sendNotesToChat).not.toHaveBeenCalled();
  });
});
