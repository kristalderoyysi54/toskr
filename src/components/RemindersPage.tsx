import { useState } from "react";
import { CalendarDays } from "lucide-react";

import { SubscriptionsPage } from "@/components/subscriptions/SubscriptionsPage";
import { TaskPage } from "@/components/TaskPage";
import { IconButton } from "@/components/ui/icon-button";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import type { TaskBuckets } from "@/lib/tasks";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/**
 * 「提醒」页外壳：顶部「任务 / 订阅」二段切换，各子视图独立满屏
 * （单屏只展现一类内容）。任务子视图右上可唤出月历（默认隐藏，会话态）。
 */
export function RemindersPage({ buckets, now }: { buckets: TaskBuckets; now: number }) {
  const subview = useUIStore((s) => s.remindersSubview);
  const bills = useNotesStore((s) => s.bills);
  // 默认不显示日历（用户指定）；会话态不持久化，每次启动都从隐藏开始
  const [taskCalendar, setTaskCalendar] = useState(false);
  return (
    <>
      <div className="relative flex justify-center pb-1">
        <Segmented
          size="xs"
          ariaLabel="提醒子视图"
          value={subview}
          options={[
            { value: "tasks", label: "任务" },
            { value: "subscriptions", label: "订阅" },
          ]}
          onChange={(v) => useUIStore.getState().setRemindersSubview(v)}
        />
        {subview === "tasks" && (
          <IconButton
            label={taskCalendar ? "隐藏任务日历" : "显示任务日历"}
            size="sm"
            aria-pressed={taskCalendar}
            onClick={() => setTaskCalendar((v) => !v)}
            className={cn("absolute right-3.5 top-0", taskCalendar && "text-primary")}
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
