import { useEffect, useMemo, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CalendarX2,
  ChevronDown,
  ChevronRight,
  ListTodo,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Lightbulb,
} from "lucide-react";

import {
  SimpleMenu,
  SimpleMenuItem,
  SimpleMenuSeparator,
} from "@/components/SimpleMenu";
import { TaskCalendar } from "@/components/TaskCalendar";
import { TaskQuickAdd } from "@/components/TaskQuickAdd";
import { TaskRow } from "@/components/TaskRow";
import { WindowedListItem } from "@/components/WindowedListItem";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useStickyHeader } from "@/lib/stickyHeader";
import { undoableTip } from "@/lib/actions";
import {
  filterTasks,
  isSmartBandTask,
  taskFilterActive,
  type TaskBuckets,
  type TaskFilter,
  type TaskFilterChip,
} from "@/lib/tasks";
import { cn } from "@/lib/utils";
import {
  TASK_INBOX_ID,
  useNotesStore,
  type Task,
  type TaskSection,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import { sectionName } from "@/lib/i18n/builtinNames";
import { t as translate, useT, type MessageKey } from "@/lib/i18n";
import { clockLabel } from "@/lib/taskRecurrence";

/** 任务页「已完成」折叠区在 uiStore.doneOpen 里的固定 key。 */
export const TASK_DONE_KEY = "tasks:done";
/** 智能区折叠态 key（存"是否折叠"，缺省展开）。 */
export const TASK_OVERDUE_COLLAPSED_KEY = "tasks:overdue-collapsed";
export const TASK_SPARKS_COLLAPSED_KEY = "tasks:sparks-collapsed";

/**
 * 任务页：闪念速记 + 智能区（已到期红 / 💡灵感紫）+ 可折叠自定义分组 + 已完成。
 * calendar：月历面板（「提醒」页头部日历开关唤出，默认隐藏）。
 */
export function TaskPage({
  buckets,
  now,
  calendar = false,
  filterOpen = false,
  onCloseFilter,
}: {
  buckets: TaskBuckets;
  now: number;
  calendar?: boolean;
  /** 搜索与筛选栏（「提醒」页头部筛选钮唤出）；有条件时打平分组显示命中结果。 */
  filterOpen?: boolean;
  onCloseFilter?: () => void;
}) {
  const t = useT();
  const doneOpen = useUIStore((s) => s.doneOpen[TASK_DONE_KEY] ?? false);
  const allTasks = useNotesStore((s) => s.tasks);
  const [filter, setFilter] = useState<TaskFilter>(EMPTY_FILTER);
  // 关闭筛选栏即清空条件（会话态，不记忆）
  useEffect(() => {
    if (!filterOpen) setFilter(EMPTY_FILTER);
  }, [filterOpen]);
  const filtering = filterOpen && taskFilterActive(filter);
  const filtered = useMemo(
    () => (filtering ? filterTasks(allTasks, filter, now) : []),
    [filtering, allTasks, filter, now]
  );
  const empty =
    !buckets.overdue.length &&
    !buckets.sparks.length &&
    !buckets.done.length &&
    buckets.groups.length === 1 &&
    buckets.groups.every((g) => !g.tasks.length);

  // ===== 拖拽排序 / 跨分组（复刻 App.tsx 笔记的 DndContext 参考实现）=====
  const dragExpandRef = useRef<{ sec: string; timer: number } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const clearDragExpand = () => {
    if (dragExpandRef.current) {
      window.clearTimeout(dragExpandRef.current.timer);
      dragExpandRef.current = null;
    }
  };

  // 智能区（已到期/灵感/已完成）是横切计算出的视图，不是可投放的分组容器：
  // 悬停目标若落在智能区里的任务行上，一律忽略——只有 sec: 容器本身，或
  // 悬停在"真实归属某分组"的任务行上，才算命中一个分组
  const onDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    const activeId = String(active.id);
    const state = useNotesStore.getState();
    const activeTask = state.tasks.find((t) => t.id === activeId);
    if (!activeTask) return;

    const overTask = state.tasks.find((t) => t.id === overId);
    const targetSection = overId.startsWith("sec:")
      ? overId.slice(4)
      : overTask && !isSmartBandTask(overTask, now)
        ? (overTask.sectionId ?? TASK_INBOX_ID)
        : null;
    if (!targetSection) return;

    const activeSection = activeTask.sectionId ?? TASK_INBOX_ID;
    if (targetSection !== activeSection) {
      state.moveTasksToSection([activeId], targetSection);
    }
    // 拖到折叠分组上悬停 500ms 自动展开
    const section = state.taskSections.find((s) => s.id === targetSection);
    if (section?.collapsed) {
      if (dragExpandRef.current?.sec !== targetSection) {
        clearDragExpand();
        dragExpandRef.current = {
          sec: targetSection,
          timer: window.setTimeout(() => {
            useNotesStore.getState().toggleTaskSectionCollapsed(targetSection);
            dragExpandRef.current = null;
          }, 500),
        };
      }
    } else if (dragExpandRef.current) {
      clearDragExpand();
    }
  };

  const onDragEnd = (event: DragEndEvent) => {
    clearDragExpand();
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    if (overId.startsWith("sec:")) return;
    const overTask = useNotesStore.getState().tasks.find((t) => t.id === overId);
    if (overTask && isSmartBandTask(overTask, now)) return;
    if (active.id !== over.id) {
      useNotesStore.getState().reorderTasks(String(active.id), overId);
    }
  };

  return (
    <>
      <TaskQuickAdd />
      {filterOpen && (
        <TaskFilterBar
          filter={filter}
          onChange={setFilter}
          count={filtering ? filtered.length : null}
          onClose={() => onCloseFilter?.()}
        />
      )}
      <ScrollArea className="min-h-0 flex-1 px-2.5" viewportClassName="px-1">
        {calendar && (
          <div className="pb-2 pt-1">
            <TaskCalendar now={now} />
          </div>
        )}
        {filtering ? (
          filtered.length ? (
            <div className="flex flex-col gap-1 pb-2 pt-1">
              {filtered.map((t, index) => (
                <WindowedListItem key={t.id} itemId={t.id} estimatedHeight={36} eager={index < 18}>
                  <TaskRow task={t} now={now} />
                </WindowedListItem>
              ))}
            </div>
          ) : (
            <EmptyState icon={<Search />} title={t("没有符合条件的任务")} />
          )
        ) : empty ? (
          <EmptyState
            icon={<ListTodo />}
            title={t("还没有任务")}
            hint={
              <>
                {t("在上方速记框记下待办，点 💡 切换闪念模式记灵感；")}
                <br />
                {t("也可以在笔记卡片上右键「转为任务」。")}
              </>
            }
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={clearDragExpand}
          >
            <div className="flex flex-col gap-3 pb-2 pt-1">
              {buckets.overdue.length > 0 && (
                <SmartSection
                  title={t("已到期")}
                  tone="red"
                  tasks={buckets.overdue}
                  now={now}
                  collapseKey={TASK_OVERDUE_COLLAPSED_KEY}
                  eager
                  action={<OverdueRescheduleMenu tasks={buckets.overdue} />}
                />
              )}
              {buckets.sparks.length > 0 && (
                <SmartSection
                  title={t("灵感")}
                  tone="violet"
                  icon={<Lightbulb className="size-3 fill-violet-400 text-violet-500" />}
                  tasks={buckets.sparks}
                  now={now}
                  collapseKey={TASK_SPARKS_COLLAPSED_KEY}
                  eager={buckets.overdue.length === 0}
                />
              )}
              {buckets.groups.map(({ section, tasks }, index) => (
                <TaskGroupBlock
                  key={section.id}
                  section={section}
                  tasks={tasks}
                  now={now}
                  eager={
                    index === 0 &&
                    buckets.overdue.length === 0 &&
                    buckets.sparks.length === 0
                  }
                />
              ))}
              <button
                onClick={() => useNotesStore.getState().addTaskSection()}
                className="mb-1 ml-2 flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-label text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
              >
                <Plus className="size-3" /> {t("新建分组")}
              </button>
              {buckets.done.length > 0 && (
                <div>
                  <button
                    onClick={() => useUIStore.getState().toggleDoneOpen(TASK_DONE_KEY)}
                    className="flex items-center gap-1 px-1 py-0.5 text-micro text-muted-foreground hover:text-foreground"
                  >
                    {doneOpen ? (
                      <ChevronDown className="size-2.5" />
                    ) : (
                      <ChevronRight className="size-2.5" />
                    )}
                    {t("已完成 {n}", { n: buckets.done.length })}
                  </button>
                  {doneOpen && (
                    <div className="mt-1 flex flex-col gap-1">
                      {buckets.done.map((t) => (
                        <WindowedListItem
                          key={t.id}
                          itemId={t.id}
                          estimatedHeight={36}
                        >
                          <TaskRow task={t} now={now} />
                        </WindowedListItem>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </DndContext>
        )}
      </ScrollArea>
    </>
  );
}

const EMPTY_FILTER: TaskFilter = { query: "", chips: [] };

const FILTER_CHIPS: { value: TaskFilterChip; label: MessageKey }[] = [
  { value: "week", label: "7 天内到期" },
  { value: "high", label: "高优先级" },
  { value: "checklist", label: "有检查项" },
  { value: "message", label: "来自消息" },
  { value: "recurring", label: "重复" },
  { value: "done", label: "已完成" },
];

/** 搜索框 + 条件 chip（chip 之间取交集）。 */
function TaskFilterBar({
  filter,
  onChange,
  count,
  onClose,
}: {
  filter: TaskFilter;
  onChange: (f: TaskFilter) => void;
  count: number | null;
  onClose: () => void;
}) {
  const t = useT();
  const toggle = (chip: TaskFilterChip) =>
    onChange({
      ...filter,
      chips: filter.chips.includes(chip)
        ? filter.chips.filter((c) => c !== chip)
        : [...filter.chips, chip],
    });
  return (
    <div className="mx-3 mb-1.5 flex flex-col gap-1.5">
      <label className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
          onKeyDown={(e) => {
            // 阻断到全局快捷键；Esc 先清空关键词，再按一次关闭筛选栏
            e.stopPropagation();
            if (e.key === "Escape" && !e.nativeEvent.isComposing) {
              if (filter.query) onChange({ ...filter, query: "" });
              else onClose();
            }
          }}
          placeholder={t("搜索标题、备注、检查项…")}
          aria-label={t("搜索任务")}
          className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
        />
        {count !== null && (
          <span className="shrink-0 text-micro tabular-nums text-muted-foreground">{t("{n} 条", { n: count })}</span>
        )}
      </label>
      <div className="flex flex-wrap gap-1">
        {FILTER_CHIPS.map(({ value, label }) => {
          const on = filter.chips.includes(value);
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(value)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-micro outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                on
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {t(label)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 智能区（已到期 / 灵感）：跨分组横切；带 collapseKey 时标题可点击折叠。 */
function SmartSection({
  title,
  tone,
  icon,
  tasks,
  now,
  collapseKey,
  eager = false,
  action,
}: {
  title: string;
  tone: "red" | "violet";
  icon?: React.ReactNode;
  tasks: Task[];
  now: number;
  collapseKey?: string;
  eager?: boolean;
  /** 区头右端操作（已到期区的「全部顺延」）。 */
  action?: React.ReactNode;
}) {
  const t = useT();
  // doneOpen 是通用的布尔切换器；这里语义存「是否折叠」，缺省展开
  const collapsed = useUIStore((s) => (collapseKey ? !!s.doneOpen[collapseKey] : false));
  const { headerRef, bodyRef, scrollToStartIfStuck } = useStickyHeader(collapsed);
  const heading = (
    <>
      {icon}
      {title}
      {/* 计数微 chip：染智能区色（红/紫软底），与普通分组的中性 chip 同族 */}
      <span
        className={cn(
          "rounded-sm px-1 py-px text-micro font-semibold tabular-nums",
          tone === "red" ? "bg-destructive/10" : "bg-violet-500/10"
        )}
      >
        {tasks.length}
      </span>
    </>
  );
  const headingCls = cn(
    "flex min-w-0 flex-1 select-none items-center gap-1 pl-0.5 text-label font-semibold uppercase tracking-[0.08em]",
    tone === "red" ? "text-destructive" : "text-violet-600 dark:text-violet-400"
  );
  return (
    <section>
      <div ref={headerRef} className="sticky top-0 z-10 mb-1.5 flex items-center gap-1 pr-1">
      {collapseKey ? (
        <button
          type="button"
          onClick={() => {
            if (!scrollToStartIfStuck()) useUIStore.getState().toggleDoneOpen(collapseKey);
          }}
          title={collapsed ? t("展开") : t("折叠")}
          aria-label={collapsed ? t("展开{title}分组", { title }) : t("折叠{title}分组", { title })}
          aria-expanded={!collapsed}
          className={cn(
            headingCls,
            "w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          )}
        >
          {collapsed ? (
            <ChevronRight className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
          {heading}
        </button>
      ) : (
        <h3 className={headingCls}>
          {heading}
        </h3>
      )}
      {action}
      </div>
      {!collapsed && (
        <div ref={bodyRef} className="-mx-1 -mb-1 flex flex-col gap-1 px-1 pb-1">
          {tasks.map((t, index) => (
            <WindowedListItem
              key={t.id}
              itemId={t.id}
              estimatedHeight={36}
              eager={eager && index < 18}
            >
              <TaskRow task={t} now={now} />
            </WindowedListItem>
          ))}
        </div>
      )}
    </section>
  );
}

/** 顺延目标：每次打开菜单按当下时刻算（今晚 20:00 已过则不给）。 */
function rescheduleOptions(now: number): { label: string; at: number }[] {
  const d = new Date(now);
  const at = (addDays: number, hour: number) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays, hour, 0, 0, 0).getTime();
  const toMonday = ((8 - d.getDay()) % 7) || 7;
  return [
    { label: translate("今天 {time}", { time: clockLabel(20, 0) }), at: at(0, 20) },
    { label: translate("明天 {time}", { time: clockLabel(9, 0) }), at: at(1, 9) },
    { label: translate("下周一 {time}", { time: clockLabel(9, 0) }), at: at(toMonday, 9) },
  ].filter((o) => o.at > now);
}

/** 已到期区头「全部顺延」：积压的逾期任务一次挪到同一时间点，可撤销。 */
export function OverdueRescheduleMenu({ tasks }: { tasks: Task[] }) {
  const t = useT();
  const run = (dueAt: number | null, label: string) => {
    const ids = tasks.map((task) => task.id);
    useNotesStore.getState().rescheduleTasks(ids, dueAt);
    undoableTip(
      dueAt === null
        ? t("已清除 {n} 个任务的到期时间", { n: ids.length })
        : t("已顺延 {n} 个任务到{label}", { n: ids.length, label })
    );
  };
  return (
    <SimpleMenu
      align="end"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            "flex shrink-0 items-center gap-0.5 rounded-sm px-1 text-micro text-muted-foreground outline-none hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring",
            open && "text-foreground"
          )}
        >
          {t("全部顺延")} <ChevronDown className="size-2.5" />
        </button>
      )}
    >
      {(close) => (
        <>
          {rescheduleOptions(Date.now()).map((o) => (
            <SimpleMenuItem
              key={o.label}
              onClick={() => {
                close();
                run(o.at, o.label);
              }}
            >
              <CalendarClock className="size-3.5" /> {o.label}
            </SimpleMenuItem>
          ))}
          <SimpleMenuSeparator />
          <SimpleMenuItem
            onClick={() => {
              close();
              run(null, "");
            }}
          >
            <CalendarX2 className="size-3.5" /> {t("清除到期时间")}
          </SimpleMenuItem>
        </>
      )}
    </SimpleMenu>
  );
}

/** 自定义任务分组：可折叠 / 双击改名 / ⋯菜单（重命名、上移下移、删除）。 */
function TaskGroupBlock({
  section,
  tasks,
  now,
  eager = false,
}: {
  section: TaskSection;
  tasks: Task[];
  now: number;
  eager?: boolean;
}) {
  const {
    renameTaskSection,
    deleteTaskSection,
    moveTaskSection,
    toggleTaskSectionCollapsed,
  } = useNotesStore.getState();
  const t = useT();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(sectionName(section));
  const collapsed = !!section.collapsed;
  // 单击组名折叠 / 双击改名：延迟消歧，双击时取消未执行的折叠
  const clickTimer = useRef(0);
  const { headerRef, bodyRef, scrollToStartIfStuck } = useStickyHeader(collapsed);

  // 跨分组拖拽的投放目标：空分组/折叠分组也可投放（同笔记 SectionGroup）
  const { setNodeRef, isOver } = useDroppable({ id: `sec:${section.id}` });

  const commitRename = () => {
    setRenaming(false);
    if (name !== sectionName(section)) renameTaskSection(section.id, name);
  };

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "rounded-lg transition-colors",
        isOver && "bg-primary/[0.06] ring-1 ring-primary/30"
      )}
    >
      <div
        ref={headerRef}
        className="group sticky top-0 z-10 mb-1.5 flex h-5 items-center gap-1 pl-0.5 pr-1"
      >
        <button
          aria-label={collapsed ? t("展开分组") : t("折叠分组")}
          aria-expanded={!collapsed}
          onClick={() => toggleTaskSectionCollapsed(section.id)}
          className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
        >
          {collapsed ? (
            <ChevronRight className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
        </button>
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.nativeEvent.isComposing) commitRename();
              if (e.key === "Escape") {
                setName(sectionName(section));
                setRenaming(false);
              }
            }}
            className="h-5 w-32 bg-transparent text-label font-semibold uppercase tracking-[0.08em] outline-none"
          />
        ) : (
          <h3
            title={t("点击折叠/展开（吸顶时回到组首） · 双击重命名")}
            className="cursor-pointer select-none text-label font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
            onClick={() => {
              window.clearTimeout(clickTimer.current);
              clickTimer.current = window.setTimeout(() => {
                if (!scrollToStartIfStuck()) toggleTaskSectionCollapsed(section.id);
              }, 220);
            }}
            onDoubleClick={() => {
              window.clearTimeout(clickTimer.current);
              setName(sectionName(section));
              setRenaming(true);
            }}
          >
            {sectionName(section)}
          </h3>
        )}
        <span className="rounded-sm surface-inset px-1 py-px text-micro font-semibold tabular-nums text-muted-foreground">
          {tasks.length}
        </span>
        <div className="ml-auto">
          <SimpleMenu
            align="end"
            trigger={({ open, toggle }) => (
              <IconButton
                label={t("分组操作")}
                size="2xs"
                reveal="hover-focus"
                onClick={toggle}
                className={open ? "opacity-100 pointer-events-auto" : undefined}
              >
                <MoreHorizontal />
              </IconButton>
            )}
          >
            {(close) => (
              <>
                <SimpleMenuItem
                  onClick={() => {
                    close();
                    setName(sectionName(section));
                    setRenaming(true);
                  }}
                >
                  <Pencil className="size-3.5" /> {t("重命名")}
                </SimpleMenuItem>
                <SimpleMenuItem
                  onClick={() => {
                    close();
                    moveTaskSection(section.id, -1);
                  }}
                >
                  <ArrowUp className="size-3.5" /> {t("上移")}
                </SimpleMenuItem>
                <SimpleMenuItem
                  onClick={() => {
                    close();
                    moveTaskSection(section.id, 1);
                  }}
                >
                  <ArrowDown className="size-3.5" /> {t("下移")}
                </SimpleMenuItem>
                {section.id !== TASK_INBOX_ID && (
                  <>
                    <SimpleMenuSeparator />
                    <SimpleMenuItem
                      destructive
                      onClick={() => {
                        close();
                        deleteTaskSection(section.id);
                      }}
                    >
                      <Trash2 className="size-3.5" /> {t("删除分组")}
                    </SimpleMenuItem>
                  </>
                )}
              </>
            )}
          </SimpleMenu>
        </div>
      </div>
      {!collapsed && (
        <div ref={bodyRef} className="-mx-1 -mb-1 px-1 pb-1">
        <SortableContext
          items={tasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.length ? (
            <div className="flex flex-col gap-1">
              {tasks.map((t, index) => (
                <WindowedListItem
                  key={t.id}
                  itemId={t.id}
                  estimatedHeight={36}
                  eager={eager && index < 18}
                >
                  <TaskRow task={t} now={now} />
                </WindowedListItem>
              ))}
            </div>
          ) : (
            <EmptyState variant="inline" title={t("此分组为空")} />
          )}
        </SortableContext>
        </div>
      )}
    </section>
  );
}
