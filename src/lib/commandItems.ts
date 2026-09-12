import type { Note, Task } from "@/store/notesStore";

/** 命令面板条目（O3，2026-09-12）：动作与搜索结果同列，纯数据便于测试。 */
export interface CommandItem {
  id: string;
  group: "动作" | "卡片" | "任务";
  label: string;
  hint?: string;
  shortcut?: string;
  run: () => void;
}

export interface CommandContext {
  page: "notes" | "clipboard" | "tasks" | "secret";
  contentSubview: "notes" | "messages" | "secret";
  checkedCount: number;
  focusedNoteId: string | null;
  notes: readonly Note[];
  tasks: readonly Task[];
  clipboardSectionId: string;
  actions: {
    sendChecked: (opts?: { forcePreflight?: boolean }) => void;
    sendNote: (id: string, opts?: { forcePreflight?: boolean }) => void;
    setPage: (page: CommandContext["page"]) => void;
    addSection: () => void;
    openSettings: () => void;
    openRecentDelivery: () => void;
    openSearch: () => void;
    focusNote: (id: string, page: "notes" | "clipboard") => void;
    focusTask: (id: string) => void;
  };
}

const MAX_RESULTS_PER_GROUP = 6;

function noteLabel(note: Note): string {
  const text = (note.title ?? note.text ?? "").split("\n")[0]?.trim() ?? "";
  return text || (note.url ? note.url : "（无文字）");
}

function matches(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query);
}

/** 按当前上下文与查询词生成条目：无查询词只给动作；有查询词时动作按文字过滤，再附卡片/任务命中。 */
export function buildCommandItems(ctx: CommandContext, rawQuery: string): CommandItem[] {
  const query = rawQuery.trim().toLowerCase();
  const onNoteList =
    (ctx.page === "notes" && ctx.contentSubview === "notes") || ctx.page === "clipboard";
  const actions: CommandItem[] = [];
  if (onNoteList && ctx.checkedCount > 0) {
    actions.push(
      {
        id: "send-checked",
        group: "动作",
        label: `发送勾选的 ${ctx.checkedCount} 张卡到对话`,
        shortcut: "⌘⏎",
        run: () => ctx.actions.sendChecked(),
      },
      {
        id: "preflight-checked",
        group: "动作",
        label: "检查后发送勾选的卡…",
        shortcut: "⇧⌘⏎",
        run: () => ctx.actions.sendChecked({ forcePreflight: true }),
      }
    );
  } else if (onNoteList && ctx.focusedNoteId) {
    const id = ctx.focusedNoteId;
    actions.push(
      {
        id: "send-focused",
        group: "动作",
        label: "发送焦点卡片到对话",
        shortcut: "⌘⏎",
        run: () => ctx.actions.sendNote(id),
      },
      {
        id: "preflight-focused",
        group: "动作",
        label: "检查后发送焦点卡片…",
        run: () => ctx.actions.sendNote(id, { forcePreflight: true }),
      }
    );
  }
  actions.push(
    { id: "search", group: "动作", label: "搜索当前页", shortcut: "⌘F", run: ctx.actions.openSearch },
    { id: "page-notes", group: "动作", label: "切到内容页", shortcut: "⌘←→", run: () => ctx.actions.setPage("notes") },
    { id: "page-clipboard", group: "动作", label: "切到剪贴页", run: () => ctx.actions.setPage("clipboard") },
    { id: "page-tasks", group: "动作", label: "切到提醒页", run: () => ctx.actions.setPage("tasks") },
    { id: "add-section", group: "动作", label: "新建分组", run: ctx.actions.addSection },
    { id: "recent", group: "动作", label: "最近发送记录", run: ctx.actions.openRecentDelivery },
    { id: "settings", group: "动作", label: "打开设置", run: ctx.actions.openSettings }
  );
  if (!query) return actions;
  const items = actions.filter((item) => matches(item.label, query));
  let noteHits = 0;
  for (const note of ctx.notes) {
    if (noteHits >= MAX_RESULTS_PER_GROUP) break;
    const label = noteLabel(note);
    if (!matches(label, query) && !matches(note.text ?? "", query)) continue;
    noteHits += 1;
    const page = note.sectionId === ctx.clipboardSectionId ? "clipboard" : "notes";
    items.push({
      id: `note:${note.id}`,
      group: "卡片",
      label,
      hint: page === "clipboard" ? "剪贴" : "笔记",
      run: () => ctx.actions.focusNote(note.id, page),
    });
  }
  let taskHits = 0;
  for (const task of ctx.tasks) {
    if (taskHits >= MAX_RESULTS_PER_GROUP) break;
    if (!matches(task.text, query)) continue;
    taskHits += 1;
    items.push({
      id: `task:${task.id}`,
      group: "任务",
      label: task.text.split("\n")[0]!,
      hint: task.status === "done" ? "已完成" : "任务",
      run: () => ctx.actions.focusTask(task.id),
    });
  }
  return items;
}

/** 底部提示行：随焦点上下文给 3–4 条最相关的快捷键（O3）。 */
export function keyHintsFor(input: {
  page: CommandContext["page"];
  contentSubview: CommandContext["contentSubview"];
  editing: boolean;
  searchOpen: boolean;
  focusedNote: boolean;
  checkedCount: number;
}): [string, string][] {
  if (input.editing) return [["⌘⏎", "保存"], ["Esc", "取消"]];
  if (input.searchOpen) return [["Esc", "关闭搜索"], ["↑↓", "移动焦点"]];
  if (input.page === "tasks") return [["⏎", "记下待办"], ["⌘K", "命令"], ["长按 ⌥ Option", "全部快捷键"]];
  if (input.page === "notes" && input.contentSubview !== "notes") return [["⌘K", "命令"], ["长按 ⌥ Option", "全部快捷键"]];
  if (input.checkedCount > 0) {
    return [["⌘⏎", `发送 ${input.checkedCount} 张`], ["⌘C", "复制为列表"], ["Esc", "取消勾选"], ["⌘K", "命令"]];
  }
  if (input.focusedNote) {
    return [["⌘⏎", "发送"], ["Space", "预览"], ["⏎", "编辑"], ["x", "勾选"], ["⌘K", "命令"]];
  }
  return [["↑↓", "选卡片"], ["⌘F", "搜索"], ["⌘K", "命令"], ["长按 ⌥ Option", "全部快捷键"]];
}
