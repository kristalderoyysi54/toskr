import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlarmClock,
  CheckCircle2,
  Circle,
  CircleDot,
  FolderInput,
  ListChecks,
  Plus,
  Send,
  Trash2,
  X,
  Lightbulb,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { deleteTasksWithUndo, sendTaskToChat } from "@/lib/actions";
import {
  dueBadgeLabel,
  dueTone,
  presetCfgDue,
  presetCfgLabel,
  PRIORITY_BAR,
  PRIORITY_LABEL,
} from "@/lib/tasks";
import { cn } from "@/lib/utils";
import {
  TASK_INBOX_ID,
  useNotesStore,
  type ChecklistItem,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "待办",
  doing: "进行中",
  done: "完成",
};
const PRIORITY_CYCLE: TaskPriority[] = ["none", "low", "mid", "high"];

/** 关闭 Radix 右键菜单：自定义按钮不走 Item onSelect，主动派发 Esc。 */
function closeContextMenu() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** epoch ms → date 输入值（本地时区）。 */
function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** epoch ms → time 输入值（本地时区）。 */
function toTimeInput(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 任务行：收起态为紧凑单行；单击展开详情卡（Apple 提醒事项风格）——
 * 完整标题编辑 + 备注 + 检查列表（子任务）。Esc / 点击行外收起（失焦即保存）。
 */
export function TaskRow({ task, now }: { task: Task; now: number }) {
  const focused = useUIStore((s) => s.focusedId === task.id);
  const flashing = useUIStore((s) => s.flashId === task.id);
  const expanded = useUIStore((s) => s.editingId === task.id);
  const rowRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(task.text);
  const [noteDraft, setNoteDraft] = useState(task.note ?? "");

  const { cycleTaskStatus, cycleTaskPriority, setTaskStatus, setTaskPriority } =
    useNotesStore.getState();

  // 键盘导航焦点滚动可见（与 NoteCard 同款）
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  // 长文本自适应增高（DraftInput 同款），封顶防止撑爆面板
  const autoResize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  };

  // 展开：装载草稿并聚焦标题（新挂载元素 + 延时 focus，绕开 WKWebView 焦点惰性）
  useEffect(() => {
    if (expanded) {
      setDraft(task.text);
      setNoteDraft(task.note ?? "");
      window.setTimeout(() => {
        titleRef.current?.focus();
        autoResize(titleRef.current);
      }, 30);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // 点击行外收起（编辑控件的 blur 已各自保存，这里只负责关闭）
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) {
        useUIStore.getState().setEditingId(null);
      }
    };
    document.addEventListener("mousedown", onDown, { capture: true });
    return () =>
      document.removeEventListener("mousedown", onDown, { capture: true });
  }, [expanded]);

  const saveTitle = () => {
    if (draft.trim() && draft !== task.text) {
      useNotesStore.getState().updateTaskText(task.id, draft);
    }
  };
  const saveNote = () => {
    if (noteDraft !== (task.note ?? "")) {
      useNotesStore.getState().updateTaskNote(task.id, noteDraft);
    }
  };
  const collapse = () => {
    saveTitle();
    saveNote();
    useUIStore.getState().setEditingId(null);
  };

  const done = task.status === "done";
  const StatusIcon =
    task.status === "done" ? CheckCircle2 : task.status === "doing" ? CircleDot : Circle;
  const checklist = task.checklist ?? [];
  const checklistDone = checklist.filter((c) => c.done).length;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rowRef}
          onClick={() => {
            useUIStore.getState().setFocusedId(task.id);
            useUIStore.getState().setEditingId(task.id);
          }}
          className={cn(
            "group rounded-lg border border-transparent px-2 py-1.5 shadow-sm",
            // 闪念灵感：紫色底与普通待办区分
            task.kind === "spark"
              ? "bg-violet-50 dark:bg-violet-400/10"
              : "bg-white dark:bg-zinc-800",
            "hover:border-black/10 dark:hover:border-white/10",
            focused && "ring-1 ring-black/20 dark:ring-white/25",
            expanded && "ring-1 ring-primary/40",
            flashing && "flash-highlight"
          )}
        >
          {/* ===== 行头（收起/展开共用）===== */}
          <div className="flex items-center gap-2">
            {/* 优先级色条：点击循环 无→低→中→高 */}
            <button
              aria-label={`优先级：${PRIORITY_LABEL[task.priority]}（点击切换）`}
              title={`优先级：${PRIORITY_LABEL[task.priority]}`}
              onClick={(e) => {
                e.stopPropagation();
                cycleTaskPriority(task.id);
              }}
              className="flex h-6 w-2 shrink-0 items-center justify-center"
            >
              <span
                className={cn("h-5 w-[3px] rounded-full", PRIORITY_BAR[task.priority])}
              />
            </button>

            {/* 闪念：💡（点击转正式待办）；普通任务：状态点三态循环 */}
            {task.kind === "spark" && !done ? (
              <button
                aria-label="灵感转为待办"
                title="💡 灵感 · 点击转为待办"
                onClick={(e) => {
                  e.stopPropagation();
                  useNotesStore.getState().sparkToTask(task.id);
                }}
                className="shrink-0"
              >
                <Lightbulb className="size-4 fill-violet-400 text-violet-500" />
              </button>
            ) : (
              <button
                aria-label={`状态：${STATUS_LABEL[task.status]}（点击切换）`}
                title={`状态：${STATUS_LABEL[task.status]}`}
                onClick={(e) => {
                  e.stopPropagation();
                  cycleTaskStatus(task.id);
                }}
                className="shrink-0"
              >
                <StatusIcon
                  className={cn(
                    "size-4",
                    task.status === "done" && "text-emerald-500",
                    task.status === "doing" && "text-primary",
                    task.status === "todo" && "text-muted-foreground/50"
                  )}
                />
              </button>
            )}

            {expanded ? (
              <textarea
                ref={titleRef}
                value={draft}
                rows={1}
                onChange={(e) => {
                  setDraft(e.target.value);
                  autoResize(e.target);
                }}
                onClick={(e) => e.stopPropagation()}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    collapse();
                  } else if (e.key === "Escape") {
                    collapse();
                  }
                }}
                className="min-w-0 flex-1 resize-none bg-transparent text-[13px] font-medium leading-snug outline-none"
              />
            ) : (
              <p
                title={task.text}
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px]",
                  done && "text-muted-foreground line-through opacity-60"
                )}
              >
                {task.text}
              </p>
            )}

            {/* 收起态：检查列表进度徽标 */}
            {!expanded && checklist.length > 0 && (
              <span
                title={`检查列表 ${checklistDone}/${checklist.length}`}
                className="flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground/70"
              >
                <ListChecks className="size-3" />
                {checklistDone}/{checklist.length}
              </span>
            )}

            {/* 收起态才在行头放到期/删除；展开态移到详情底部操作行，把宽度留给标题 */}
            {!expanded && <DuePopover task={task} now={now} />}
            {!expanded && (
              <button
                aria-label="删除任务"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteTasksWithUndo([task.id], "已删除 1 个任务");
                }}
                className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>

          {/* ===== 展开详情：备注 + 检查列表（自上而下下拉展开）===== */}
          <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="detail"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 480, damping: 42 }}
              className="overflow-hidden"
            >
            <div className="ml-8 mt-1 flex flex-col gap-1.5 pb-1">
              <textarea
                value={noteDraft}
                placeholder="备注"
                rows={1}
                onChange={(e) => {
                  setNoteDraft(e.target.value);
                  autoResize(e.target);
                }}
                onClick={(e) => e.stopPropagation()}
                onBlur={saveNote}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") collapse();
                }}
                className="resize-none bg-transparent text-[12px] leading-relaxed text-muted-foreground outline-none placeholder:text-muted-foreground/50"
              />
              {checklist.length > 0 && (
                <div className="flex flex-col">
                  {checklist.map((c) => (
                    <ChecklistRow key={c.id} taskId={task.id} item={c} />
                  ))}
                </div>
              )}
              <ChecklistAdder taskId={task.id} />
              {/* 详情底部操作行：到期 + 删除（行头空间留给完整标题） */}
              <div className="flex items-center gap-1.5 pt-0.5">
                <DuePopover task={task} now={now} alwaysVisible />
                <span className="flex-1" />
                <button
                  aria-label="删除任务"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteTasksWithUndo([task.id], "已删除 1 个任务");
                  }}
                  className="rounded p-0.5 text-muted-foreground/70 hover:text-red-500"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
            </motion.div>
          )}
          </AnimatePresence>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-40">
        <ContextMenuItem onClick={() => void sendTaskToChat(task.id)}>
          <Send className="size-3.5" /> 发送到对话
        </ContextMenuItem>
        {task.kind === "spark" && (
          <ContextMenuItem onClick={() => useNotesStore.getState().sparkToTask(task.id)}>
            <Lightbulb className="size-3.5" /> 转为待办
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {/* 状态/优先级平铺行内选择：窄面板下二级子菜单会翻转遮挡主菜单 */}
        <div className="px-2 py-1">
          <p className="mb-1 text-[10px] text-muted-foreground">状态</p>
          <div className="flex gap-1">
            {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => {
                  setTaskStatus(task.id, s);
                  closeContextMenu();
                }}
                className={cn(
                  "flex-1 rounded-md border px-1 py-0.5 text-[11px]",
                  task.status === s
                    ? "border-primary/50 bg-primary/10 font-medium"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
        <div className="px-2 py-1">
          <p className="mb-1 text-[10px] text-muted-foreground">优先级</p>
          <div className="flex gap-1">
            {PRIORITY_CYCLE.map((p) => (
              <button
                key={p}
                title={PRIORITY_LABEL[p]}
                onClick={() => {
                  setTaskPriority(task.id, p);
                  closeContextMenu();
                }}
                className={cn(
                  "flex h-6 flex-1 items-center justify-center rounded-md border",
                  task.priority === p
                    ? "border-primary/50 bg-primary/10"
                    : "border-border hover:bg-black/5 dark:hover:bg-white/10"
                )}
              >
                <span className={cn("h-3.5 w-[3px] rounded-full", PRIORITY_BAR[p])} />
              </button>
            ))}
          </div>
        </div>
        <MoveToSectionSub task={task} />
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() => deleteTasksWithUndo([task.id], "已删除 1 个任务")}
        >
          <Trash2 className="size-3.5" /> 删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 「移动到分组」子菜单（多于一个分组时显示）。 */
function MoveToSectionSub({ task }: { task: Task }) {
  const taskSections = useNotesStore((s) => s.taskSections);
  if (taskSections.length <= 1) return null;
  const currentId = task.sectionId ?? TASK_INBOX_ID;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FolderInput className="mr-2 size-3.5" /> 移动到
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-32">
        {taskSections
          .filter((s) => s.id !== currentId)
          .map((s) => (
            <ContextMenuItem
              key={s.id}
              onClick={() =>
                useNotesStore.getState().moveTasksToSection([task.id], s.id)
              }
            >
              {s.name}
            </ContextMenuItem>
          ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** 检查列表项：圆圈勾选 + 行内编辑（清空文本即删除）+ 悬停删除。 */
function ChecklistRow({ taskId, item }: { taskId: string; item: ChecklistItem }) {
  const [text, setText] = useState(item.text);
  // 外部变化（勾选等重渲染）时同步最新文本
  useEffect(() => setText(item.text), [item.text]);

  const commit = () => {
    if (text !== item.text) {
      useNotesStore.getState().updateChecklistItem(taskId, item.id, text);
    }
  };

  return (
    <div className="group/check flex items-center gap-1.5 rounded px-0.5 py-0.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]">
      <button
        aria-label={item.done ? "取消勾选" : "勾选"}
        onClick={(e) => {
          e.stopPropagation();
          useNotesStore.getState().toggleChecklistItem(taskId, item.id);
        }}
        className="shrink-0"
      >
        {item.done ? (
          <CheckCircle2 className="size-3.5 text-emerald-500" />
        ) : (
          <Circle className="size-3.5 text-muted-foreground/50" />
        )}
      </button>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-[12px] outline-none",
          item.done && "text-muted-foreground line-through opacity-60"
        )}
      />
      <button
        aria-label="删除检查项"
        onClick={(e) => {
          e.stopPropagation();
          useNotesStore.getState().deleteChecklistItem(taskId, item.id);
        }}
        className="hidden shrink-0 rounded p-0.5 text-muted-foreground/60 hover:text-foreground group-hover/check:block"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/** 新增检查项输入：回车连续添加。 */
function ChecklistAdder({ taskId }: { taskId: string }) {
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    useNotesStore.getState().addChecklistItem(taskId, t);
    setText("");
  };
  return (
    <div className="flex items-center gap-1.5 px-0.5">
      <Plus className="size-3.5 shrink-0 text-muted-foreground/50" />
      <input
        value={text}
        placeholder="添加检查项…"
        onChange={(e) => setText(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/50"
      />
    </div>
  );
}

/**
 * 到期时间设置 Popover：快捷预设 + 自定义（日期/时间分开输入，草稿式——
 * 只有点「设定」或按 Enter 才提交，段内编辑不会中途关闭）+ 清除。
 */
function DuePopover({
  task,
  now,
  alwaysVisible,
}: {
  task: Task;
  now: number;
  /** 详情展开态常显（收起态无到期时仅悬停出现）。 */
  alwaysVisible?: boolean;
}) {
  const duePresets = useNotesStore((s) => s.settings.duePresets);
  const [open, setOpenRaw] = useState(false);
  // 关闭后按钮多驻留一拍：Radix 退出动画（100ms）期间锚点若被 hidden
  // 收走，弹层会失锚闪到屏幕角落
  const [lingering, setLingering] = useState(false);
  const setOpen = (v: boolean) => {
    setOpenRaw(v);
    if (!v) {
      setLingering(true);
      window.setTimeout(() => setLingering(false), 180);
    }
  };
  const [dateDraft, setDateDraft] = useState("");
  const [timeDraft, setTimeDraft] = useState("20:00");

  // 打开时装载现值（无到期默认今天 20:00）
  useEffect(() => {
    if (open) {
      const base = task.dueAt !== null ? new Date(task.dueAt) : new Date();
      setDateDraft(toDateInput(base));
      setTimeDraft(task.dueAt !== null ? toTimeInput(base) : "20:00");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setDue = (ms: number | null) => {
    useNotesStore.getState().setTaskDue(task.id, ms);
    setOpen(false);
  };
  const commitCustom = () => {
    if (!dateDraft) return;
    const ms = new Date(`${dateDraft}T${timeDraft || "09:00"}`).getTime();
    if (!Number.isNaN(ms)) setDue(ms);
  };
  const tone = task.dueAt !== null ? dueTone(task.dueAt, now) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {task.dueAt !== null ? (
          <button
            onClick={(e) => e.stopPropagation()}
            title="修改到期时间"
            className={cn(
              "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] tabular-nums",
              tone === "overdue" && "bg-red-500/15 text-red-600 dark:text-red-400",
              tone === "today" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
              tone === "later" && "bg-black/[0.06] text-muted-foreground dark:bg-white/10"
            )}
          >
            {dueBadgeLabel(task.dueAt, now)}
          </button>
        ) : (
          <button
            onClick={(e) => e.stopPropagation()}
            title="设置到期提醒"
            className={cn(
              "shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-[10px] text-muted-foreground/70 hover:text-foreground",
              // 弹层开着（含退出动画驻留期）必须留在布局里：hidden 会让
              // Radix 锚点塌掉、弹层跳位
              alwaysVisible || open || lingering ? "flex" : "hidden group-hover:flex"
            )}
          >
            <AlarmClock className="size-3" /> 到期
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-56 p-2"
        onClick={(e) => e.stopPropagation()}
        // 阻断到全局快捷键（Esc 关面板等）；Radix 自身的 Esc 关闭走 capture 不受影响
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commitCustom();
          }
        }}
      >
        <div className="flex flex-col gap-1">
          {duePresets.map((p) => (
            <button
              key={p.id}
              onClick={() => setDue(presetCfgDue(p, Date.now()))}
              className="rounded-md px-2 py-1 text-left text-[12px] hover:bg-black/5 dark:hover:bg-white/10"
            >
              {presetCfgLabel(p)}
            </button>
          ))}
          <div className="my-1 h-px bg-border/60" />
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={dateDraft}
              onChange={(e) => setDateDraft(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-1.5 py-1 text-[12px] outline-none focus:border-primary/50"
            />
            <input
              type="time"
              value={timeDraft}
              onChange={(e) => setTimeDraft(e.target.value)}
              className="w-[74px] shrink-0 rounded-md border border-border bg-transparent px-1.5 py-1 text-[12px] tabular-nums outline-none focus:border-primary/50"
            />
          </div>
          <button
            onClick={commitCustom}
            className="rounded-md bg-primary px-2 py-1 text-[12px] text-primary-foreground hover:opacity-90"
          >
            设定该时间
          </button>
          {task.dueAt !== null && (
            <button
              onClick={() => setDue(null)}
              className="rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
            >
              清除到期
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
