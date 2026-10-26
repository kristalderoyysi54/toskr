import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FlyoutSource = {
  entries: { kind: string; id: string; label?: string; disabled?: boolean }[];
  handlers: Map<string, () => void>;
};

const menu = vi.hoisted(() => ({
  items: new Map<string, { onClick?: () => void; onSelect?: () => void }>(),
  flyouts: new Map<string, () => { entries: { kind: string; id: string; label?: string }[]; handlers: Map<string, () => void> }>(),
  close: undefined as ((event: { preventDefault: () => void }) => void) | undefined,
}));

// 子菜单走独立小窗：触发行渲染成「标签 + 展开后的条目文字」便于断言层级，并记下 getSource
vi.mock("@/components/MenuFlyoutTrigger", () => ({
  MenuFlyoutTrigger: (props: { label: string; getSource: () => FlyoutSource }) => {
    menu.flyouts.set(props.label, props.getSource);
    return createElement(
      "div",
      { "data-submenu": props.label },
      props.label,
      ...props.getSource().entries.map((entry) => entry.label ?? "")
    );
  },
}));

vi.mock("@/lib/ai", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ai")>(),
  splitSubtasks: vi.fn(),
}));
vi.mock("@/lib/actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/actions")>(),
  sendTaskToChat: vi.fn(),
}));

vi.mock("@/components/ui/context-menu", () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    ContextMenu: wrapper,
    ContextMenuTrigger: wrapper,
    // cardMenuLayout 的投影器会引用这些导出（本文件的菜单不再用 Radix 子菜单）
    ContextMenuLabel: wrapper,
    ContextMenuShortcut: wrapper,
    ContextMenuSub: wrapper,
    ContextMenuSubTrigger: wrapper,
    ContextMenuSubContent: wrapper,
    ContextMenuSeparator: () => createElement("hr"),
    ContextMenuContent: ({ children, onCloseAutoFocus }: {
      children: ReactNode;
      onCloseAutoFocus: typeof menu.close;
    }) => {
      menu.close = onCloseAutoFocus;
      return createElement("div", { "data-task-menu": "" }, children);
    },
    ContextMenuItem: (props: {
      children: ReactNode;
      onClick?: () => void;
      onSelect?: () => void;
      variant?: string;
    }) => {
      const label = renderToStaticMarkup(createElement("span", null, props.children))
        .replace(/<[^>]*>/g, "").trim();
      menu.items.set(label, props);
      return createElement("button", { "data-variant": props.variant }, props.children);
    },
  };
});

import { splitSubtasks } from "@/lib/ai";
import { sendTaskToChat } from "@/lib/actions";
import { TASK_INBOX_ID, useNotesStore, type Task } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import { TaskRow, TaskTile } from "./TaskRow";

const task: Task = {
  id: "menu-task",
  text: "核对首页文案",
  status: "todo",
  priority: "none",
  dueAt: null,
  createdAt: 1,
  remindedAt: null,
  sectionId: TASK_INBOX_ID,
};

beforeEach(() => {
  menu.items.clear();
  menu.flyouts.clear();
  menu.close = undefined;
  useNotesStore.setState({ tasks: [task], taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }] });
  useUIStore.setState({ focusedId: null, editingId: null });
});

describe("任务菜单", () => {
  it.each([TaskRow, TaskTile])("行与横栏菜单与笔记卡同骨架：发送区在顶部，拆解子任务在常用区，不再有更多操作", (Component) => {
    const html = renderToStaticMarkup(createElement(Component, { task, now: 10 }));
    const menuHtml = html.split('data-task-menu=""')[1]!;
    const order = ["发送到对话", "检查后发送…", "标记完成", "编辑任务…", "设置提醒时间…", "AI 拆解子任务", "优先级"];
    const positions = order.map((label) => menuHtml.indexOf(label));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    expect(html).not.toContain("更多操作");
    expect(html).toContain('data-variant="destructive"');
  });

  it("一级菜单的发送与拆解直接触发原动作", () => {
    renderToStaticMarkup(createElement(TaskRow, { task, now: 10 }));
    menu.items.get("AI 拆解子任务")!.onClick!();
    expect(splitSubtasks).toHaveBeenCalledWith(task.id);
    menu.items.get("检查后发送…")!.onClick!();
    expect(sendTaskToChat).toHaveBeenCalledWith(task.id, { forcePreflight: true });
  });

  it("编辑在菜单关闭后才打开真实任务编辑态，避免焦点被菜单抢回", () => {
    renderToStaticMarkup(createElement(TaskRow, { task, now: 10 }));
    menu.items.get("编辑任务…")!.onSelect!();
    expect(useUIStore.getState().editingId).toBeNull();
    const preventDefault = vi.fn();
    menu.close!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(useUIStore.getState().editingId).toBe(task.id);
    expect(useUIStore.getState().focusedId).toBe(task.id);
  });

  it("完成与恢复使用既有任务状态，进行中仍可从主层设置", () => {
    renderToStaticMarkup(createElement(TaskRow, { task, now: 10 }));
    menu.items.get("标记进行中")!.onClick!();
    expect(useNotesStore.getState().tasks[0]!.status).toBe("doing");
    menu.items.get("标记完成")!.onClick!();
    expect(useNotesStore.getState().tasks[0]!.status).toBe("done");
    renderToStaticMarkup(createElement(TaskRow, { task: { ...task, status: "done" }, now: 10 }));
    menu.items.get("标记进行中")!.onClick!();
    expect(useNotesStore.getState().tasks[0]!.status).toBe("doing");
    menu.items.get("恢复为待办")!.onClick!();
    expect(useNotesStore.getState().tasks[0]!.status).toBe("todo");
  });
});
