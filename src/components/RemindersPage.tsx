import { Fragment, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { AlertTriangle, CalendarDays, ListFilter } from "lucide-react";

import { SubscriptionsPage } from "@/components/subscriptions/SubscriptionsPage";
import { TaskPage } from "@/components/TaskPage";
import { TodayPage } from "@/components/TodayPage";
import { focusRing } from "@/components/ui/focus-ring";
import { IconButton } from "@/components/ui/icon-button";
import { SlidingTabIndicator } from "@/components/ui/sliding-tab-indicator";
import { useT } from "@/lib/i18n";
import { SETTINGS_SECTION } from "@/lib/settingsSync";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { TaskBuckets } from "@/lib/tasks";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

const SUBVIEWS = [
  { value: "today", label: "今天" },
  { value: "tasks", label: "任务" },
  { value: "subscriptions", label: "订阅" },
] as const;

/**
 * 「提醒」页外壳：顶部「今天 / 任务 / 订阅」切换，各子视图独立满屏
 * （单屏只展现一类内容）。任务子视图行末可唤出月历（默认隐藏，会话态）。
 *
 * 二级导航＝文字页签（2026-08-16 用户选定 B 案）：一级页签独占「轨道+浮块」
 * 物种，二级降为安静文字（选中加粗+短下划线，layoutId 平移），与一级同走
 * 左轴线（pl-4 + px-2 ≈ 一级页签文字起点），日历钮右对齐收尾。
 */
export function RemindersPage({ buckets, now }: { buckets: TaskBuckets; now: number }) {
  const t = useT();
  const storedSubview = useUIStore((s) => s.remindersSubview);
  const bills = useNotesStore((s) => s.bills);
  const subscriptionsEnabled = useNotesStore((s) => s.settings.subscriptionsEnabled);
  // 订阅功能关闭时没有订阅页签：残留的 subscriptions 落回「今天」
  const subview =
    storedSubview === "subscriptions" && !subscriptionsEnabled ? "today" : storedSubview;
  const subviews = subscriptionsEnabled
    ? SUBVIEWS
    : SUBVIEWS.filter((v) => v.value !== "subscriptions");
  // 默认不显示日历（用户指定）；会话态不持久化，每次启动都从隐藏开始
  const [taskCalendar, setTaskCalendar] = useState(false);
  // 筛选栏同为会话态：关闭即清空条件，回到分组视图
  const [taskFilter, setTaskFilter] = useState(false);
  // 提醒事项同步失败：头部给一个黄色提示钮，点开设置的「日历与提醒事项」页
  const syncError = useNotesStore((s) =>
    s.settings.appleRemindersEnabled ? s.settings.appleRemindersLastError : null
  );
  return (
    <>
      {/* min-h 锁行高：今天/订阅子视图无筛选/日历钮，避免切换时行高跳 2px。
          上下留白（pt-1/pb-2）：上下相邻元素均无自带间距，呼吸全靠本行。
          订阅功能关闭时只剩「今天 · 任务」两个页签 */}
      <div className="flex min-h-6 items-center pb-2 pl-4 pr-3.5 pt-1">
        <div role="tablist" aria-label={t("提醒子视图")} className="flex items-center gap-0.5">
          {subviews.map(({ value, label }, i) => {
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
                  {t(label)}
                  {active && (
                    <SlidingTabIndicator
                      layoutId="reminders-subtab-line"
                      variant="underline"
                    />
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
        <div className="ml-auto flex items-center">
          {syncError && (
            <IconButton
              label={t("提醒事项同步失败：{error}（点击查看）", { error: syncError })}
              size="sm"
              onClick={() => {
                void api.openSettingsWindow();
                void emitTo("settings", SETTINGS_SECTION, "apple");
              }}
              className="text-warning"
            >
              <AlertTriangle />
            </IconButton>
          )}
          {subview === "tasks" && (
            <>
              <IconButton
                label={taskFilter ? t("关闭搜索与筛选") : t("搜索与筛选任务")}
                size="sm"
                aria-pressed={taskFilter}
                onClick={() => setTaskFilter((v) => !v)}
                className={cn(taskFilter && "text-primary")}
              >
                <ListFilter />
              </IconButton>
              <IconButton
                label={taskCalendar ? t("隐藏任务日历") : t("显示任务日历")}
                size="sm"
                aria-pressed={taskCalendar}
                onClick={() => setTaskCalendar((v) => !v)}
                className={cn(taskCalendar && "text-primary")}
              >
                <CalendarDays />
              </IconButton>
            </>
          )}
        </div>
      </div>
      {subview === "today" ? (
        <TodayPage now={now} />
      ) : subview === "tasks" ? (
        <TaskPage
          buckets={buckets}
          now={now}
          calendar={taskCalendar}
          filterOpen={taskFilter}
          onCloseFilter={() => setTaskFilter(false)}
        />
      ) : (
        <SubscriptionsPage bills={bills} now={now} />
      )}
    </>
  );
}
