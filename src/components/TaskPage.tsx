import { useRef, useState } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import type { TaskBuckets } from "@/lib/tasks";
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

  return (
    <>
      <TaskQuickAdd />
      <ScrollArea className="min-h-0 flex-1 px-2">
        {empty ? (
          <div className="flex flex-col items-center gap-2 px-6 pb-10 pt-16 text-center">
            <ListTodo className="size-6 text-muted-foreground/40" />
            <p className="text-[13px] font-medium text-muted-foreground">还没有任务</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground/70">
              在上方速记框记下待办，点 💡 切换闪念模式记灵感；
              <br />
              也可以在笔记卡片上右键「转为任务」。
            </p>
          </div>
        ) : (
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
              className="mb-1 ml-2 flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground/60 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
            >
              <Plus className="size-3" /> 新建分组
            </button>
            {buckets.done.length > 0 && (
              <div>
                <button
                  onClick={() => useUIStore.getState().toggleDoneOpen(TASK_DONE_KEY)}
                  className="flex items-center gap-1 px-1 py-0.5 text-[10px] text-muted-foreground/60 hover:text-foreground"
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
      <span className="text-[10px] font-normal tabular-nums opacity-60">
        {tasks.length}
      </span>
    </>
  );
  const headingCls = cn(
    "mb-1.5 flex select-none items-center gap-1 pl-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]",
    tone === "red" ? "text-red-500" : "text-violet-600 dark:text-violet-400"
  );
  return (
    <section>
      {collapseKey ? (
        <button
          onClick={() => useUIStore.getState().toggleDoneOpen(collapseKey)}
          title={collapsed ? "展开" : "折叠"}
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

  const commitRename = () => {
    setRenaming(false);
    renameTaskSection(section.id, name);
  };

  return (
    <section>
      <div className="group/tsec mb-1.5 flex h-5 items-center gap-1 pl-0.5 pr-1">
        <button
          aria-label={collapsed ? "展开分组" : "折叠分组"}
          onClick={() => toggleTaskSectionCollapsed(section.id)}
          className="rounded p-0.5 text-muted-foreground/60 hover:text-foreground"
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
            className="h-5 w-32 bg-transparent text-[11px] font-semibold uppercase tracking-[0.08em] outline-none"
          />
        ) : (
          <h3
            title="点击折叠/展开 · 双击重命名"
            className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
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
        <span className="text-[10px] tabular-nums text-muted-foreground/60">
          {tasks.length}
        </span>
        <div className="ml-auto">
          <SimpleMenu
            align="end"
            trigger={({ open, toggle }) => (
              <button
                aria-label="分组操作"
                onClick={toggle}
                className={cn(
                  "rounded p-0.5 text-muted-foreground/60 transition-opacity hover:text-foreground",
                  open ? "opacity-100" : "opacity-0 group-hover/tsec:opacity-100"
                )}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
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
      {!collapsed &&
        (tasks.length ? (
          <div className="flex flex-col gap-1 pl-2">
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} now={now} />
            ))}
          </div>
        ) : (
          <p className="px-2 py-1 text-[11px] text-muted-foreground/50">空</p>
        ))}
    </section>
  );
}
