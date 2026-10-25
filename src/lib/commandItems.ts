import { t } from "@/lib/i18n";
import type { Note, Task } from "@/store/notesStore";

/** 命令面板条目（O3，2026-09-12）：动作与搜索结果同列，纯数据便于测试。 */
export interface CommandItem {
  id: string;
  /** 分组取值是逻辑 key（中文），显示处用 t(group) 翻译。 */
  group: "动作" | "卡片" | "任务";
  /** 已按当前语言翻译。 */
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
  return text || (note.url ? note.url : t("（无文字）"));
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
        label: t("发送勾选的 {n} 张卡到对话", { n: ctx.checkedCount }),
        shortcut: "⌘⏎",
        run: () => ctx.actions.sendChecked(),
      },
      {
        id: "preflight-checked",
        group: "动作",
        label: t("检查后发送勾选的卡…"),
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
        label: t("发送焦点卡片到对话"),
        shortcut: "⌘⏎",
        run: () => ctx.actions.sendNote(id),
      },
      {
        id: "preflight-focused",
        group: "动作",
        label: t("检查后发送焦点卡片…"),
        run: () => ctx.actions.sendNote(id, { forcePreflight: true }),
      }
    );
  }
  actions.push(
    { id: "search", group: "动作", label: t("搜索当前页"), shortcut: "⌘F", run: ctx.actions.openSearch },
    { id: "page-notes", group: "动作", label: t("切到内容页"), shortcut: "⌘←→", run: () => ctx.actions.setPage("notes") },
    { id: "page-clipboard", group: "动作", label: t("切到剪贴页"), run: () => ctx.actions.setPage("clipboard") },
    { id: "page-tasks", group: "动作", label: t("切到提醒页"), run: () => ctx.actions.setPage("tasks") },
    { id: "add-section", group: "动作", label: t("新建分组"), run: ctx.actions.addSection },
    { id: "recent", group: "动作", label: t("最近发送记录"), run: ctx.actions.openRecentDelivery },
    { id: "settings", group: "动作", label: t("打开设置"), run: ctx.actions.openSettings }
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
      hint: page === "clipboard" ? t("剪贴") : t("笔记"),
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
      hint: task.status === "done" ? t("已完成") : t("任务"),
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
  if (input.editing) return [["⌘⏎", t("保存")], ["Esc", t("取消")]];
  if (input.searchOpen) return [["Esc", t("关闭搜索")], ["↑↓", t("移动焦点")]];
  if (input.page === "tasks") return [["⏎", t("记下待办")], ["⌘K", t("命令")], [t("长按 ⌥ Option"), t("全部快捷键")]];
  if (input.page === "notes" && input.contentSubview !== "notes") return [["⌘K", t("命令")], [t("长按 ⌥ Option"), t("全部快捷键")]];
  if (input.checkedCount > 0) {
    return [["⌘⏎", t("发送 {n} 张", { n: input.checkedCount })], ["⌘C", t("复制为列表")], ["Esc", t("取消勾选")], ["⌘K", t("命令")]];
  }
  if (input.focusedNote) {
    return [["⌘⏎", t("发送")], ["Space", t("预览")], ["⏎", t("编辑")], ["x", t("勾选")], ["⌘K", t("命令")]];
  }
  return [["↑↓", t("选卡片")], ["⌘F", t("搜索")], ["⌘K", t("命令")], [t("长按 ⌥ Option"), t("全部快捷键")]];
}
