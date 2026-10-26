import { CalendarDays } from "lucide-react";

import { focusRing } from "@/components/ui/focus-ring";
import { eventTimeLabel } from "@/lib/appleCalendar";
import { useT } from "@/lib/i18n";
import { api, type AppleCalendarEvent } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * 苹果日历日程：灰底块与可操作的任务行区分，图标取该日历在系统里的颜色；
 * 点击在「日历」App 里打开这条日程（Toskr 侧只读）。
 */
export function CalendarEventRow({ event }: { event: AppleCalendarEvent }) {
  const t = useT();
  const meta = [eventTimeLabel(event, t("全天")), event.calendarTitle, event.location]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={() => void api.appleCalendarOpenEvent(event).catch(() => {})}
      aria-label={t("日程：{title}，{meta}", { title: event.title, meta })}
      title={t("在「日历」中打开")}
      className={cn(
        "flex w-full items-start gap-1.5 rounded-lg bg-black/[0.04] px-2 py-1 text-left text-muted-foreground outline-none transition-colors hover:bg-black/[0.07] dark:bg-white/[0.06] dark:hover:bg-white/10",
        focusRing
      )}
    >
      <CalendarDays
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0"
        // token-exception: 用户日历的系统颜色（运行时数据），无对应 token
        style={event.calendarColor ? { color: event.calendarColor } : undefined}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body text-foreground/80">{event.title || t("（无标题）")}</p>
        <p className="truncate text-micro">{meta}</p>
      </div>
    </button>
  );
}
