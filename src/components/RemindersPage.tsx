import { SubscriptionsPage } from "@/components/subscriptions/SubscriptionsPage";
import { TaskPage } from "@/components/TaskPage";
import { Segmented } from "@/components/ui/segmented";
import type { TaskBuckets } from "@/lib/tasks";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/**
 * 「提醒」页外壳：顶部「任务 / 订阅」二段切换，各子视图独立满屏
 * （单屏只展现一类内容）。任务子视图 = 原任务页零改动。
 */
export function RemindersPage({ buckets, now }: { buckets: TaskBuckets; now: number }) {
  const subview = useUIStore((s) => s.remindersSubview);
  const bills = useNotesStore((s) => s.bills);
  return (
    <>
      <div className="flex justify-center pb-1.5 pt-0.5">
        {/* 宽松胶囊（用户指定 2026-08-16）：sm 档 + 选项加宽内距，一眼可点 */}
        <Segmented
          size="sm"
          ariaLabel="提醒子视图"
          value={subview}
          options={[
            { value: "tasks", label: <span className="px-4">任务</span> },
            { value: "subscriptions", label: <span className="px-4">订阅</span> },
          ]}
          onChange={(v) => useUIStore.getState().setRemindersSubview(v)}
        />
      </div>
      {subview === "tasks" ? (
        <TaskPage buckets={buckets} now={now} />
      ) : (
        <SubscriptionsPage bills={bills} now={now} />
      )}
    </>
  );
}
