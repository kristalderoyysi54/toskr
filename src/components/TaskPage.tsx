import { useRef, useState } from "react";
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
  ChevronDown,
  ChevronRight,
  ListTodo,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Lightbulb,
} from "lucide-react";

import {
  SimpleMenu,
  SimpleMenuItem,
  SimpleMenuSeparator,
} from "@/components/SimpleMenu";
import { TaskQuickAdd } from "@/components/TaskQuickAdd";
import { TaskRow } from "@/components/TaskRow";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { isSmartBandTask, type TaskBuckets } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import {
  TASK_INBOX_ID,
  useNotesStore,
  type Task,
  type TaskSection,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 任务页「已完成」折叠区在 uiStore.doneOpen 里的固定 key。 */
export const TASK_DONE_KEY = "tasks:done";
/** 灵感区折叠态 key（存"是否折叠"，缺省展开）。 */
const SPARKS_COLLAPSED_KEY = "tasks:sparks-collapsed";

/**
 * 任务页：闪念速记 + 智能区（已到期红 / 💡灵感紫）+ 可折叠自定义分组 + 已完成。
 */
export function TaskPage({ buckets, now }: { buckets: TaskBuckets; now: number }) {
  const doneOpen = useUIStore((s) => s.doneOpen[TASK_DONE_KEY] ?? false);
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
      <ScrollArea className="min-h-0 flex-1 px-2">
        {empty ? (
          <EmptyState
            icon={<ListTodo />}
            title="还没有任务"
            hint={
              <>
                在上方速记框记下待办，点 💡 切换闪念模式记灵感；
                <br />
                也可以在笔记卡片上右键「转为任务」。
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
                <SmartSection title="已到期" tone="red" tasks={buckets.overdue} now={now} />
              )}
              {buckets.sparks.length > 0 && (
                <SmartSection
                  title="灵感"
                  tone="violet"
                  icon={<Lightbulb className="size-3 fill-violet-400 text-violet-500" />}
                  tasks={buckets.sparks}
                  now={now}
                  collapseKey={SPARKS_COLLAPSED_KEY}
                />
              )}
              {buckets.groups.map(({ section, tasks }) => (
                <TaskGroupBlock key={section.id} section={section} tasks={tasks} now={now} />
              ))}
              <button
                onClick={() => useNotesStore.getState().addTaskSection()}
                className="mb-1 ml-2 flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-label text-muted-foreground/60 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
              >
                <Plus className="size-3" /> 新建分组
              </button>
              {buckets.done.length > 0 && (
                <div>
                  <button
                    onClick={() => useUIStore.getState().toggleDoneOpen(TASK_DONE_KEY)}
                    className="flex items-center gap-1 px-1 py-0.5 text-micro text-muted-foreground/60 hover:text-foreground"
                  >
                    {doneOpen ? (
                      <ChevronDown className="size-2.5" />
                    ) : (
                      <ChevronRight className="size-2.5" />
                    )}
                    已完成 {buckets.done.length}
                  </button>
                  {doneOpen && (
                    <div className="mt-1 flex flex-col gap-1 pl-2">
                      {buckets.done.map((t) => (
                        <TaskRow key={t.id} task={t} now={now} />
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

/** 智能区（已到期 / 灵感）：跨分组横切；带 collapseKey 时标题可点击折叠。 */
function SmartSection({
  title,
  tone,
  icon,
  tasks,
  now,
  collapseKey,
}: {
  title: string;
  tone: "red" | "violet";
  icon?: React.ReactNode;
  tasks: Task[];
  now: number;
  collapseKey?: string;
}) {
  // doneOpen 是通用的布尔切换器；这里语义存「是否折叠」，缺省展开
  const collapsed = useUIStore((s) => (collapseKey ? !!s.doneOpen[collapseKey] : false));
  const heading = (
    <>
      {icon}
      {title}
      <span className="text-micro font-normal tabular-nums opacity-60">
        {tasks.length}
      </span>
    </>
  );
  const headingCls = cn(
    "mb-1.5 flex select-none items-center gap-1 pl-0.5 text-label font-semibold uppercase tracking-[0.08em]",
    tone === "red" ? "text-destructive" : "text-violet-600 dark:text-violet-400"
  );
  return (
    <section>
      {collapseKey ? (
        <button
          onClick={() => useUIStore.getState().toggleDoneOpen(collapseKey)}
          title={collapsed ? "展开" : "折叠"}
          aria-expanded={!collapsed}
          className={cn(headingCls, "w-full")}
        >
          {collapsed ? (
            <ChevronRight className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
          {heading}
        </button>
      ) : (
        <h3 className={headingCls}>{heading}</h3>
      )}
      {!collapsed && (
        <div className="flex flex-col gap-1 pl-2">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

/** 自定义任务分组：可折叠 / 双击改名 / ⋯菜单（重命名、上移下移、删除）。 */
function TaskGroupBlock({
  section,
  tasks,
  now,
}: {
  section: TaskSection;
  tasks: Task[];
  now: number;
}) {
  const {
    renameTaskSection,
    deleteTaskSection,
    moveTaskSection,
    toggleTaskSectionCollapsed,
  } = useNotesStore.getState();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(section.name);
  const collapsed = !!section.collapsed;
  // 单击组名折叠 / 双击改名：延迟消歧，双击时取消未执行的折叠
  const clickTimer = useRef(0);

  // 跨分组拖拽的投放目标：空分组/折叠分组也可投放（同笔记 SectionGroup）
  const { setNodeRef, isOver } = useDroppable({ id: `sec:${section.id}` });

  const commitRename = () => {
    setRenaming(false);
    renameTaskSection(section.id, name);
  };

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "rounded-lg transition-colors",
        isOver && "bg-primary/[0.06] ring-1 ring-primary/30"
      )}
    >
      <div className="group mb-1.5 flex h-5 items-center gap-1 pl-0.5 pr-1">
        <button
          aria-label={collapsed ? "展开分组" : "折叠分组"}
          aria-expanded={!collapsed}
          onClick={() => toggleTaskSectionCollapsed(section.id)}
          className="rounded-sm p-0.5 text-muted-foreground/60 hover:text-foreground"
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
                setName(section.name);
                setRenaming(false);
              }
            }}
            className="h-5 w-32 bg-transparent text-label font-semibold uppercase tracking-[0.08em] outline-none"
          />
        ) : (
          <h3
            title="点击折叠/展开 · 双击重命名"
            className="cursor-pointer select-none text-label font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
            onClick={() => {
              window.clearTimeout(clickTimer.current);
              clickTimer.current = window.setTimeout(
                () => toggleTaskSectionCollapsed(section.id),
                220
              );
            }}
            onDoubleClick={() => {
              window.clearTimeout(clickTimer.current);
              setName(section.name);
              setRenaming(true);
            }}
          >
            {section.name}
          </h3>
        )}
        <span className="text-micro tabular-nums text-muted-foreground/60">
          {tasks.length}
        </span>
        <div className="ml-auto">
          <SimpleMenu
            align="end"
            trigger={({ open, toggle }) => (
              <IconButton
                label="分组操作"
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
                    setName(section.name);
                    setRenaming(true);
                  }}
                >
                  <Pencil className="size-3.5" /> 重命名
                </SimpleMenuItem>
                <SimpleMenuItem
                  onClick={() => {
                    close();
                    moveTaskSection(section.id, -1);
                  }}
                >
                  <ArrowUp className="size-3.5" /> 上移
                </SimpleMenuItem>
                <SimpleMenuItem
                  onClick={() => {
                    close();
                    moveTaskSection(section.id, 1);
                  }}
                >
                  <ArrowDown className="size-3.5" /> 下移
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
                      <Trash2 className="size-3.5" /> 删除分组
                    </SimpleMenuItem>
                  </>
                )}
              </>
            )}
          </SimpleMenu>
        </div>
      </div>
      {!collapsed && (
        <SortableContext
          items={tasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.length ? (
            <div className="flex flex-col gap-1 pl-2">
              {tasks.map((t) => (
                <TaskRow key={t.id} task={t} now={now} />
              ))}
            </div>
          ) : (
            <EmptyState variant="inline" title="此分组为空" />
          )}
        </SortableContext>
      )}
    </section>
  );
}
