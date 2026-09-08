import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const menu = vi.hoisted(() => ({
  items: new Map<string, { onClick?: () => void; onSelect?: () => void }>(),
  close: undefined as ((event: { preventDefault: () => void }) => void) | undefined,
}));

vi.mock("@/components/ui/context-menu", () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    ContextMenu: wrapper,
    ContextMenuTrigger: wrapper,
    ContextMenuSubContent: wrapper,
    ContextMenuSubTrigger: wrapper,
    ContextMenuSub: ({ children }: { children: ReactNode }) => createElement("div", { "data-submenu": "" }, children),
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
  menu.close = undefined;
  useNotesStore.setState({ tasks: [task], taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }] });
  useUIStore.setState({ focusedId: null, editingId: null });
});

describe("任务菜单", () => {
  it.each([TaskRow, TaskTile])("行与横栏菜单都优先完成、编辑和提醒，发送留在更多操作", (Component) => {
    const html = renderToStaticMarkup(createElement(Component, { task, now: 10 }));
    const firstLevel = html.split('data-task-menu=""')[1]!.split('data-submenu=""')[0]!;
    expect(firstLevel).toContain("标记完成");
    expect(firstLevel).toContain("编辑任务");
    expect(firstLevel).toContain("设置提醒时间");
    expect(firstLevel).toContain("优先级");
    expect(firstLevel).not.toMatch(/发送到对话|检查后发送|AI 拆解子任务/);
    expect(html).toContain("更多操作");
    expect(html).toContain("AI 拆解子任务");
    expect(html).toContain('data-variant="destructive"');
  });

  it("编辑在菜单关闭后才打开真实任务编辑态，避免焦点被菜单抢回", () => {
    renderToStaticMarkup(createElement(TaskRow, { task, now: 10 }));
    menu.items.get("编辑任务")!.onSelect!();
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
