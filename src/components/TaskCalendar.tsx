import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { TaskRow } from "@/components/TaskRow";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { startOfBillDay } from "@/lib/bills";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { useNotesStore, type Task } from "@/store/notesStore";

const WEEK_HEADER = ["一", "二", "三", "四", "五", "六", "日"];

/** 相邻月占位格斜纹（与订阅月历同款）。 */
const HATCH_STYLE = {
  backgroundImage:
    "repeating-linear-gradient(135deg, transparent, transparent 3px, currentColor 3px, currentColor 4px)",
} as const;

/**
 * 任务月历（默认隐藏，由「提醒」页头部日历开关唤出）：
 * 有到期任务的天显示计数点；点选某天列出当天任务，并可直接为该天添加任务
 * （今天默认 20:00 到期、未来天 9:00——避免「刚加就逾期」）。
 */
export function TaskCalendar({ now }: { now: number }) {
  const tasks = useNotesStore((s) => s.tasks);
  const [monthOffset, setMonthOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState(() => startOfBillDay(now));
  const [draft, setDraft] = useState("");
  const today = startOfBillDay(now);
  const base = new Date(now);
  const monthFirst = new Date(base.getFullYear(), base.getMonth() + monthOffset, 1);

  const { cells, byDay } = useMemo(() => {
    const y = monthFirst.getFullYear();
    const m = monthFirst.getMonth();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const rows = Math.ceil((lead + daysInMonth) / 7);
    const monthStart = new Date(y, m, 1).getTime();
    const monthEnd = new Date(y, m + 1, 1).getTime();
    const cells = Array.from({ length: rows * 7 }, (_, i) => {
      const day = new Date(y, m, 1 - lead + i).getTime();
      return { day, inMonth: day >= monthStart && day < monthEnd };
    });
    const byDay = new Map<number, Task[]>();
    for (const task of tasks) {
      if (task.dueAt === null) continue;
      const day = startOfBillDay(task.dueAt);
      const list = byDay.get(day) ?? [];
      list.push(task);
      byDay.set(day, list);
    }
    for (const list of byDay.values()) {
      list.sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
    }
    return { cells, byDay };
    // monthFirst 由 monthOffset 派生
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, monthOffset, now]);

  const dayTasks = byDay.get(selectedDay) ?? [];

  const addForDay = () => {
    const text = draft.trim();
    if (!text) return;
    const d = new Date(selectedDay);
    // 今天 20:00 / 未来 9:00：今天上午加任务用 9:00 会立刻变逾期红
    const hour = selectedDay === today ? 20 : 9;
    const dueAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0).getTime();
    const { result, id } = useNotesStore.getState().addTask(text);
    if (result === "added" && id) {
      useNotesStore.getState().setTaskDue(id, dueAt);
      setDraft("");
      tip("added", `已加到 ${d.getMonth() + 1}月${d.getDate()}日`);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="surface-inset rounded-xl p-2">
        <div className="mb-1 flex items-center gap-1">
          <p className="flex-1 pl-1 text-label font-semibold tabular-nums">
            {monthFirst.getFullYear()} 年 {monthFirst.getMonth() + 1} 月
          </p>
          {monthOffset !== 0 && (
            <button
              onClick={() => setMonthOffset(0)}
              className="rounded-md px-1.5 py-0.5 text-micro text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
            >
              今天
            </button>
          )}
          <IconButton label="上个月" size="2xs" onClick={() => setMonthOffset((v) => v - 1)}>
            <ChevronLeft />
          </IconButton>
          <IconButton label="下个月" size="2xs" onClick={() => setMonthOffset((v) => v + 1)}>
            <ChevronRight />
          </IconButton>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {WEEK_HEADER.map((w) => (
            <span key={w} className="py-0.5 text-center text-micro text-muted-foreground">
              {w}
            </span>
          ))}
          {cells.map(({ day, inMonth }) => {
            const selected = day === selectedDay;
            const due = byDay.get(day) ?? [];
            const pending = due.filter((t) => t.status !== "done").length;
            return (
              <button
                key={day}
                onClick={() => setSelectedDay(day)}
                aria-label={`${new Date(day).getMonth() + 1}月${new Date(day).getDate()}日${
                  due.length ? `，${due.length} 个任务` : ""
                }`}
                className={cn(
                  "relative flex h-9 flex-col items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : inMonth
                      ? "bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
                      : "bg-black/[0.03] text-muted-foreground/70 hover:bg-black/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                )}
              >
                {!inMonth && !selected && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-lg text-border/60"
                    style={HATCH_STYLE}
                  />
                )}
                <span
                  className={cn(
                    "relative text-label tabular-nums",
                    day === today && !selected && "font-semibold text-primary"
                  )}
                >
                  {new Date(day).getDate()}
                </span>
                {/* 待办计数点：未完成任务数（完成的不再点亮） */}
                <span className="flex h-2 items-center gap-0.5">
                  {pending > 0 && (
                    <span
                      className={cn(
                        "rounded-full px-1 text-micro font-semibold tabular-nums leading-none",
                        selected
                          ? "bg-primary-foreground/90 text-primary"
                          : "bg-destructive/80 text-white"
                      )}
                    >
                      {pending}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {/* 选中日：当天任务 + 就地添加 */}
      <div>
        <p className="px-1 pb-0.5 text-micro text-muted-foreground">
          {dayLabel(selectedDay, today)}
        </p>
        <div className="flex items-center gap-1.5 px-0.5 pb-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addForDay();
            }}
            placeholder={`为${dayLabel(selectedDay, today)}添加任务…`}
            aria-label="为选中日期添加任务"
            className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-1.5 py-1 text-body outline-none focus:border-primary/50"
          />
          <IconButton label="添加到该日" size="sm" onClick={addForDay} disabled={!draft.trim()}>
            <Plus />
          </IconButton>
        </div>
        {dayTasks.length ? (
          <div className="flex flex-col gap-1">
            {dayTasks.map((t) => (
              <TaskRow key={t.id} task={t} now={now} />
            ))}
          </div>
        ) : (
          <EmptyState variant="inline" title="当天没有到期任务" />
        )}
      </div>
    </div>
  );
}

function dayLabel(day: number, today: number): string {
  const d = new Date(day);
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  const diff = Math.round((day - today) / 86_400_000);
  if (diff === 0) return `今天 · ${date}`;
  if (diff === 1) return `明天 · ${date}`;
  return date;
}
