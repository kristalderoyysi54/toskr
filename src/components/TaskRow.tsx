import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "motion/react";
import {
  AlarmClock,
  CheckCircle2,
  Circle,
  CircleDot,
  FolderInput,
  GripVertical,
  ListChecks,
  Plus,
  Send,
  Sparkles,
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
import { IconButton } from "@/components/ui/icon-button";
import { TargetSendMenuItem } from "@/components/TargetSendMenuItem";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { deleteTasksWithUndo, sendTaskToChat } from "@/lib/actions";
import { splitSubtasks } from "@/lib/ai";
import { springDetail } from "@/lib/motion";
import {
  dueBadgeLabel,
  dueTone,
  presetCfgDue,
  presetCfgLabel,
  PRIORITY_BAR,
  PRIORITY_LABEL,
} from "@/lib/tasks";
import { TEXTAREA_MAX_H } from "@/lib/textarea";
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
  const cardOpacity = useNotesStore((s) => s.settings.cardOpacity);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(task.text);
  const [noteDraft, setNoteDraft] = useState(task.note ?? "");

  const { cycleTaskStatus, cycleTaskPriority } = useNotesStore.getState();

  // 拖拽排序：完成态禁用（disabled 时 listeners 由 dnd-kit 置为 undefined）。
  // 收起行整行可拖 + 左缘把手；展开编辑态只留把手可拖（root 若继续转发
  // pointerdown，编辑器里划选文字会误触发排序）。attributes/onKeyDown 只放
  // 把手：root 一旦拿 tabIndex，会与全局 Space 快捷键（任务页 Space=切完成，
  // 见 App.tsx）抢键；把手自身的键盘冲突由 data-drag-handle 让路规则解决。
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: task.id,
      disabled: task.status === "done",
    });

  // 键盘导航焦点滚动可见（与 NoteCard 同款）
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  // 长文本自适应增高（DraftInput 同款），封顶防止撑爆面板
  const autoResize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_H)}px`;
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
      const t = e.target as Element | null;
      // Radix 弹层（到期选择器等）portal 在 body 上，DOM 不在 rowRef 内——
      // 不豁免的话，点弹层里的日期/时间输入会被误判「行外」，行收起连带弹层关闭
      if (t?.closest?.("[data-radix-popper-content-wrapper]")) return;
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
          ref={(el) => {
            setNodeRef(el);
            rowRef.current = el;
          }}
          style={
            {
              transform: CSS.Transform.toString(transform),
              transition,
              "--card-alpha": `${Math.round(cardOpacity * 100)}%`,
            } as CSSProperties
          }
          // 收起态抓行内任意处拖拽排序（4px 激活阈值不影响点击展开）；按钮/
          // 输入框已各自 stopPropagation 或靠距离阈值天然免疫（见文件顶部注释）。
          // 展开态只走左缘把手，避免编辑器内划选文字触发拖动
          onPointerDown={(e) => {
            if (!expanded) listeners?.onPointerDown?.(e);
          }}
          onClick={() => {
            useUIStore.getState().setFocusedId(task.id);
            useUIStore.getState().setEditingId(task.id);
          }}
          className={cn(
            "group relative rounded-lg border border-transparent px-2 py-1.5",
            // 闪念灵感：紫色底与普通待办区分。两种底色都吃 --card-alpha
            // （设置 → 卡片透明度），与笔记/剪贴板卡同一套配方
            task.kind === "spark"
              ? "bg-[rgb(245_243_255/var(--card-alpha,100%))] dark:bg-[rgb(167_139_250/calc(var(--card-alpha,100%)*0.1))]"
              : "bg-[rgb(255_255_255/var(--card-alpha,100%))] dark:bg-[rgb(39_39_42/var(--card-alpha,100%))]",
            focused && "ring-1 ring-black/20 dark:ring-white/25",
            expanded && "ring-1 ring-primary/40",
            flashing && "flash-highlight",
            isDragging && "z-10 opacity-70 elevation-3"
          )}
        >
          {/* 左缘拖拽把手（悬停显现，与 NoteCard 同款）：展开态的唯一拖拽入口 */}
          <button
            {...attributes}
            data-drag-handle
            onKeyDown={(e) => listeners?.onKeyDown?.(e)}
            onPointerDown={(e) => {
              e.stopPropagation();
              listeners?.onPointerDown?.(e);
            }}
            onClick={(e) => e.stopPropagation()}
            aria-label="拖拽排序（Space 拾起，方向键移动）"
            className={cn(
              "absolute -left-4 top-2 cursor-grab touch-none p-0.5",
              "text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100",
              "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
              "active:cursor-grabbing",
              done && "hidden"
            )}
          >
            <GripVertical className="size-3.5" />
          </button>

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
            {task.priority !== "none" && (
              <span className="shrink-0 text-micro font-semibold leading-none text-muted-foreground">
                {PRIORITY_LABEL[task.priority]}
              </span>
            )}

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
                className="min-w-0 flex-1 resize-none bg-transparent text-title font-medium leading-snug outline-none"
              />
            ) : (
              <p
                title={task.text}
                className={cn(
                  "min-w-0 flex-1 truncate text-title",
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
                className="flex shrink-0 items-center gap-0.5 text-micro tabular-nums text-muted-foreground/70"
              >
                <ListChecks className="size-3" />
                {checklistDone}/{checklist.length}
              </span>
            )}

            {/* 收起态才在行头放到期/删除；展开态移到详情底部操作行，把宽度留给标题 */}
            {!expanded && <DuePopover task={task} now={now} />}
            {!expanded && (
              <IconButton
                label="删除任务"
                size="2xs"
                reveal="hover-focus"
                tone="danger"
                onClick={() => deleteTasksWithUndo([task.id], "已删除 1 个任务")}
              >
                <Trash2 />
              </IconButton>
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
              transition={springDetail}
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
                className="resize-none bg-transparent text-body leading-relaxed text-muted-foreground outline-none placeholder:text-muted-foreground/50"
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
                  className="rounded-sm p-0.5 text-muted-foreground/70 outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-primary/50"
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

      <TaskMenu task={task} />
    </ContextMenu>
  );
}

/** 任务右键菜单（行与横栏瓷砖共用）。 */
function TaskMenu({ task }: { task: Task }) {
  return (
        <ContextMenuContent className="w-40">
          <TargetSendMenuItem onClick={() => void sendTaskToChat(task.id)}>
            <Send className="size-3.5" /> 发送到对话
          </TargetSendMenuItem>
          <TargetSendMenuItem
            onClick={() => void sendTaskToChat(task.id, { forcePreflight: true })}
          >
            <ListChecks className="size-3.5" /> 预检并发送
          </TargetSendMenuItem>
          <ContextMenuItem onClick={() => void splitSubtasks(task.id)}>
            <Sparkles className="size-3.5" /> AI 拆解子任务
          </ContextMenuItem>
          {task.kind === "spark" && (
            <ContextMenuItem onClick={() => useNotesStore.getState().sparkToTask(task.id)}>
              <Lightbulb className="size-3.5" /> 转为待办
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          {/* 状态/优先级平铺行内选择：窄面板下二级子菜单会翻转遮挡主菜单 */}
          <div className="px-2 py-1">
            <p className="mb-1 text-micro text-muted-foreground">状态</p>
            <div className="flex gap-1">
              {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    useNotesStore.getState().setTaskStatus(task.id, s);
                    closeContextMenu();
                  }}
                  className={cn(
                    "flex-1 rounded-md border px-1 py-0.5 text-label",
                    task.status === s
                      ? "border-border bg-primary/10 font-medium dark:border-input"
                      : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>
          <div className="px-2 py-1">
            <p className="mb-1 text-micro text-muted-foreground">优先级</p>
            <div className="flex gap-1">
              {PRIORITY_CYCLE.map((p) => (
                <button
                  key={p}
                  title={PRIORITY_LABEL[p]}
                  onClick={() => {
                    useNotesStore.getState().setTaskPriority(task.id, p);
                    closeContextMenu();
                  }}
                  className={cn(
                    "flex h-6 flex-1 items-center justify-center rounded-md border",
                    task.priority === p
                      ? "border-border bg-primary/10 dark:border-input"
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
    <div className="group flex items-center gap-1.5 rounded-sm px-0.5 py-0.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]">
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
          "min-w-0 flex-1 bg-transparent text-body outline-none",
          item.done && "text-muted-foreground line-through opacity-60"
        )}
      />
      <IconButton
        label="删除检查项"
        size="2xs"
        reveal="hover-focus"
        tone="danger"
        onClick={() => useNotesStore.getState().deleteChecklistItem(taskId, item.id)}
      >
        <X />
      </IconButton>
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
        className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground/50"
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
  dense,
}: {
  task: Task;
  now: number;
  /** 详情展开态常显（收起态无到期时仅悬停出现）。 */
  alwaysVisible?: boolean;
  /** 紧凑形态（横栏瓷砖）：快捷档双列网格，整体压进矮窗口。 */
  dense?: boolean;
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
              // 还原重塑前形态（用户定稿）：纯文字 tone chip，不带图标
              "shrink-0 rounded-md px-1.5 py-0.5 text-micro tabular-nums",
              tone === "overdue" && "bg-destructive/15 text-destructive",
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
              "shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-micro text-muted-foreground/70 hover:text-foreground",
              // 弹层开着（含退出动画驻留期）必须留在布局里：hidden 会让
              // Radix 锚点塌掉、弹层跳位
              alwaysVisible || open || lingering ? "flex" : "hidden group-hover:flex"
            )}
          >
            <AlarmClock className="size-2.5" /> 到期
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        // 高度钳到 Radix 可用空间（横栏窗口矮，超出即内滚，防被窗口截断）
        className={cn(
          "slim-scroll max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-2",
          dense ? "w-64" : "w-56"
        )}
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
          <div className={dense ? "grid grid-cols-2 gap-1" : "flex flex-col gap-1"}>
            {duePresets.map((p) => (
              <button
                key={p.id}
                onClick={() => setDue(presetCfgDue(p, Date.now()))}
                className="rounded-md px-2 py-1 text-left text-body hover:bg-black/5 dark:hover:bg-white/10"
              >
                {presetCfgLabel(p)}
              </button>
            ))}
          </div>
          <div className="my-1 h-px bg-border/60" />
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={dateDraft}
              onChange={(e) => setDateDraft(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-1.5 py-1 text-body outline-none focus:border-primary/50"
            />
            <input
              type="time"
              value={timeDraft}
              onChange={(e) => setTimeDraft(e.target.value)}
              className="w-20 shrink-0 rounded-md border border-border bg-transparent px-1.5 py-1 text-body tabular-nums outline-none focus:border-primary/50"
            />
          </div>
          <button
            onClick={commitCustom}
            className="rounded-md bg-primary px-2 py-1 text-body text-primary-foreground hover:opacity-90"
          >
            设定该时间
          </button>
          {task.dueAt !== null && (
            <button
              onClick={() => setDue(null)}
              className="rounded-md px-2 py-1 text-left text-body text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
            >
              清除到期
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 瓷砖详情弹层（横栏版展开卡）：标题 / 备注 / 检查列表 / 到期 / 删除。 */
function TileDetail({
  task,
  now,
  onClose,
}: {
  task: Task;
  now: number;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(task.text);
  const [noteDraft, setNoteDraft] = useState(task.note ?? "");
  const checklist = task.checklist ?? [];
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
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    window.setTimeout(() => titleRef.current?.focus(), 30);
  }, []);
  return (
    <div
      className="slim-scroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // 阻断到全局快捷键；Esc 保存并关闭
        e.stopPropagation();
        if (e.key === "Escape") {
          saveTitle();
          saveNote();
          onClose();
        }
      }}
    >
      <textarea
        ref={titleRef}
        value={draft}
        rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={saveTitle}
        className="shrink-0 resize-none bg-transparent text-body font-medium leading-snug outline-none"
      />
      <textarea
        value={noteDraft}
        rows={2}
        placeholder="备注…"
        onChange={(e) => setNoteDraft(e.target.value)}
        onBlur={saveNote}
        className="resize-none bg-transparent text-body leading-relaxed text-muted-foreground outline-none placeholder:text-muted-foreground/50"
      />
      {checklist.length > 0 && (
        <div className="flex flex-col">
          {checklist.map((c) => (
            <ChecklistRow key={c.id} taskId={task.id} item={c} />
          ))}
        </div>
      )}
      <ChecklistAdder taskId={task.id} />
      <div className="flex items-center gap-1.5 pt-0.5">
        <DuePopover task={task} now={now} alwaysVisible dense />
        <span className="flex-1" />
        <button
          aria-label="删除任务"
          onClick={() => {
            onClose();
            deleteTasksWithUndo([task.id], "已删除 1 个任务");
          }}
          className="rounded-sm p-0.5 text-muted-foreground/70 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** 横栏方块瓷砖（上/下边栏）：与任务行同一套操作——状态点循环、
 *  💡转待办、优先级循环、到期弹层、右键完整菜单、检查进度徽标；
 *  双击原位展开为详情编辑卡（标题/备注/子任务，卡内滚动），
 *  点卡外/Esc 收起，键盘焦点环。 */
export function TaskTile({ task, now }: { task: Task; now: number }) {
  const focused = useUIStore((s) => s.focusedId === task.id);
  const cardOpacity = useNotesStore((s) => s.settings.cardOpacity);
  const tileRef = useRef<HTMLDivElement>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  useEffect(() => {
    if (focused) {
      tileRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [focused]);
  // 点卡外收起（到期弹层 portal 在 body，需豁免，同 TaskRow 展开逻辑）
  useEffect(() => {
    if (!detailOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.("[data-radix-popper-content-wrapper]")) return;
      if (tileRef.current && !tileRef.current.contains(e.target as Node)) {
        setDetailOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown, { capture: true });
    return () =>
      document.removeEventListener("mousedown", onDown, { capture: true });
  }, [detailOpen]);
  const spark = task.kind === "spark";
  const done = task.status === "done";
  const checklist = task.checklist ?? [];
  const checklistDone = checklist.filter((c) => c.done).length;
  const StatusIcon =
    task.status === "done"
      ? CheckCircle2
      : task.status === "doing"
        ? CircleDot
        : Circle;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={tileRef}
          style={{ "--card-alpha": `${Math.round(cardOpacity * 100)}%` } as CSSProperties}
          onClick={() => useUIStore.getState().setFocusedId(task.id)}
          onDoubleClick={() => {
            if (!detailOpen) setDetailOpen(true);
          }}
          className={cn(
            "group relative flex h-auto shrink-0 cursor-default select-none flex-col overflow-hidden rounded-lg px-2 pb-1.5 pt-1.5 transition-[width] duration-150",
            detailOpen ? "w-96" : "aspect-[16/17]",
            "bg-[rgb(255_255_255/var(--card-alpha,100%))] dark:bg-[rgb(39_39_42/var(--card-alpha,100%))]",
            // 闪念紫底同样乘上 --card-alpha（基础配方在上一行，spark 覆盖之）
            spark &&
              "bg-[rgb(245_243_255/calc(var(--card-alpha,100%)*0.9))] dark:bg-[rgb(46_16_101/calc(var(--card-alpha,100%)*0.4))]",
            // 横栏 ←/→ 导航的「选中」视觉：与笔记卡选中同款蓝框（任务无勾选
            // 语义，焦点即选中）
            // 只用 ring 不用 border：边框会把彩色通栏往内挤出一圈卡片底色
            focused && !detailOpen && "ring-2 ring-primary/70",
            detailOpen && "ring-1 ring-primary/40"
          )}
        >
          {detailOpen ? (
            <TileDetail task={task} now={now} onClose={() => setDetailOpen(false)} />
          ) : (
            <>
              <div className="mb-1 flex items-center gap-1">
                {spark && !done ? (
                  <button
                    aria-label="灵感转为待办"
                    title="💡 灵感 · 点击转为待办"
                    onClick={(e) => {
                      e.stopPropagation();
                      useNotesStore.getState().sparkToTask(task.id);
                    }}
                    className="shrink-0 rounded-full text-violet-500 hover:text-violet-600"
                  >
                    <Lightbulb className="size-4" />
                  </button>
                ) : (
                  <button
                    aria-label={`状态：${STATUS_LABEL[task.status]}（点击切换）`}
                    title={`状态：${STATUS_LABEL[task.status]}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      useNotesStore.getState().cycleTaskStatus(task.id);
                    }}
                    className={cn(
                      "shrink-0 rounded-full text-muted-foreground hover:text-foreground",
                      task.status === "doing" && "text-primary",
                      done && "text-emerald-600 dark:text-emerald-400"
                    )}
                  >
                    <StatusIcon className="size-4" />
                  </button>
                )}
                {/* 优先级色条：点击循环 无→低→中→高（与任务行一致） */}
                <button
                  aria-label={`优先级：${PRIORITY_LABEL[task.priority]}（点击切换）`}
                  title={`优先级：${PRIORITY_LABEL[task.priority]}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    useNotesStore.getState().cycleTaskPriority(task.id);
                  }}
                  className="flex h-5 w-2 shrink-0 items-center justify-center"
                >
                  <span
                    className={cn(
                      "h-4 w-[3px] rounded-full",
                      PRIORITY_BAR[task.priority]
                    )}
                  />
                </button>
                {checklist.length > 0 && (
                  <span
                    title={`检查列表 ${checklistDone}/${checklist.length}`}
                    className="flex shrink-0 items-center gap-0.5 text-micro tabular-nums text-muted-foreground"
                  >
                    <ListChecks className="size-3" />
                    {checklistDone}/{checklist.length}
                  </span>
                )}
                <span className="ml-auto" onClick={(e) => e.stopPropagation()}>
                  <DuePopover task={task} now={now} alwaysVisible dense />
                </span>
              </div>
              <p
                className={cn(
                  checklist.length ? "line-clamp-2" : "line-clamp-[6]",
                  "whitespace-pre-wrap text-body leading-normal [overflow-wrap:anywhere]",
                  done && "text-muted-foreground line-through opacity-60"
                )}
              >
                {task.text}
              </p>
              {/* 子待办预览：默认展示可容纳的前几条（圆点可点选切换完成） */}
              {checklist.length > 0 && (
                <div className="mt-1 flex min-h-0 flex-col gap-0.5 overflow-hidden">
                  {checklist.slice(0, 4).map((c) => (
                    <div
                      key={c.id}
                      className="flex min-w-0 items-center gap-1.5 text-label"
                    >
                      <button
                        aria-label={c.done ? "标记未完成" : "标记完成"}
                        onClick={(e) => {
                          e.stopPropagation();
                          useNotesStore
                            .getState()
                            .toggleChecklistItem(task.id, c.id);
                        }}
                        className={cn(
                          "shrink-0 rounded-full",
                          c.done
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-muted-foreground/60 hover:text-foreground"
                        )}
                      >
                        {c.done ? (
                          <CheckCircle2 className="size-3" />
                        ) : (
                          <Circle className="size-3" />
                        )}
                      </button>
                      <span
                        className={cn(
                          "truncate text-muted-foreground",
                          c.done && "line-through opacity-60"
                        )}
                      >
                        {c.text}
                      </span>
                    </div>
                  ))}
                  {checklist.length > 4 && (
                    <span className="text-micro text-muted-foreground/60">
                      还有 {checklist.length - 4} 条…
                    </span>
                  )}
                </div>
              )}
              {task.note && (
                <p className="mt-0.5 line-clamp-1 text-micro text-muted-foreground/70">
                  {task.note}
                </p>
              )}
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <TaskMenu task={task} />
    </ContextMenu>
  );
}
