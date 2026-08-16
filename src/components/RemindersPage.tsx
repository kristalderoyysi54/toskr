import { Fragment, useState } from "react";
import { motion } from "motion/react";
import { CalendarDays } from "lucide-react";

import { SubscriptionsPage } from "@/components/subscriptions/SubscriptionsPage";
import { TaskPage } from "@/components/TaskPage";
import { focusRing } from "@/components/ui/focus-ring";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import type { TaskBuckets } from "@/lib/tasks";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

const SUBVIEWS = [
  { value: "tasks", label: "任务" },
  { value: "subscriptions", label: "订阅" },
] as const;

/**
 * 「提醒」页外壳：顶部「任务 / 订阅」二段切换，各子视图独立满屏
 * （单屏只展现一类内容）。任务子视图行末可唤出月历（默认隐藏，会话态）。
 *
 * 二级导航＝文字页签（2026-08-16 用户选定 B 案）：一级页签独占「轨道+浮块」
 * 物种，二级降为安静文字（选中加粗+短下划线，layoutId 平移），与一级同走
 * 左轴线（pl-4 + px-2 ≈ 一级页签文字起点），日历钮右对齐收尾。
 */
export function RemindersPage({ buckets, now }: { buckets: TaskBuckets; now: number }) {
  const subview = useUIStore((s) => s.remindersSubview);
  const bills = useNotesStore((s) => s.bills);
  // 默认不显示日历（用户指定）；会话态不持久化，每次启动都从隐藏开始
  const [taskCalendar, setTaskCalendar] = useState(false);
  return (
    <>
      {/* min-h 锁行高：订阅子视图无日历钮，避免切换时行高跳 2px。
          上下留白（pt-1/pb-2）：上下相邻元素均无自带间距，呼吸全靠本行 */}
      <div className="flex min-h-6 items-center pb-2 pl-4 pr-3.5 pt-1">
        <div role="tablist" aria-label="提醒子视图" className="flex items-center gap-0.5">
          {SUBVIEWS.map(({ value, label }, i) => {
            const active = subview === value;
            return (
              <Fragment key={value}>
                {i > 0 && (
                  <span
                    aria-hidden
                    className="px-0.5 text-micro text-muted-foreground/45"
                  >
                    ·
                  </span>
                )}
                <button
                  role="tab"
                  aria-selected={active}
                  onClick={() => useUIStore.getState().setRemindersSubview(value)}
                  className={cn(
                    "relative rounded-md px-2 pb-1 pt-0.5 text-label outline-none",
                    "transition-colors duration-(--duration-control)",
                    focusRing,
                    active
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
                  )}
                >
                  {label}
                  {active && (
                    <motion.span
                      aria-hidden
                      layoutId="reminders-subtab-line"
                      transition={{ duration: 0.12, ease: [0.2, 0.9, 0.3, 1] }}
                      className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground/85"
                    />
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
        {subview === "tasks" && (
          <IconButton
            label={taskCalendar ? "隐藏任务日历" : "显示任务日历"}
            size="sm"
            aria-pressed={taskCalendar}
            onClick={() => setTaskCalendar((v) => !v)}
            className={cn("ml-auto", taskCalendar && "text-primary")}
          >
            <CalendarDays />
          </IconButton>
        )}
      </div>
      {subview === "tasks" ? (
        <TaskPage buckets={buckets} now={now} calendar={taskCalendar} />
      ) : (
        <SubscriptionsPage bills={bills} now={now} />
      )}
    </>
  );
}
