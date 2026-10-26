import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { APPLE_CALENDAR_CHANGED_EVENT, api, type AppleCalendarEvent } from "@/lib/tauri";
import { monthDayLabel } from "@/lib/taskRecurrence";
import { useNotesStore } from "@/store/notesStore";

const NO_EVENTS: AppleCalendarEvent[] = [];

/** 本地日界：day 当天 0 点 → 次日 0 点（按日历日推进，夏令时日不是 24h）。 */
export function nextDayStart(day: number): number {
  const d = new Date(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** 日程与 [start, end) 是否相交；全天日程的结束时刻落在次日 0 点，不算进次日。 */
export function eventOverlaps(event: AppleCalendarEvent, start: number, end: number): boolean {
  return event.startMs < end && Math.max(event.endMs, event.startMs + 1) > start;
}

/** 把日程分到各天（跨天日程每天都出现）；days 为各天 0 点。 */
export function groupEventsByDay(
  events: AppleCalendarEvent[],
  days: number[]
): Map<number, AppleCalendarEvent[]> {
  const byDay = new Map<number, AppleCalendarEvent[]>();
  for (const day of days) {
    const end = nextDayStart(day);
    const list = events.filter((event) => eventOverlaps(event, day, end));
    if (list.length) byDay.set(day, sortEvents(list));
  }
  return byDay;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const hm = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** 时间说明：全天 / 09:00–10:30 / 跨天时带上结束日期。 */
export function eventTimeLabel(event: AppleCalendarEvent, allDayLabel: string): string {
  if (event.allDay) return allDayLabel;
  const startDay = new Date(event.startMs);
  startDay.setHours(0, 0, 0, 0);
  const sameDay = event.endMs <= nextDayStart(startDay.getTime());
  return sameDay
    ? `${hm(event.startMs)}–${hm(event.endMs)}`
    : `${hm(event.startMs)}–${monthDayLabel(new Date(event.endMs))} ${hm(event.endMs)}`;
}

/** 全天在前，其余按开始时刻、再按标题。 */
export function sortEvents(events: AppleCalendarEvent[]): AppleCalendarEvent[] {
  return [...events].sort(
    (a, b) =>
      Number(b.allDay) - Number(a.allDay) ||
      a.startMs - b.startMs ||
      a.title.localeCompare(b.title)
  );
}

/**
 * 区间内的苹果日历日程（设置里关闭叠加时恒为空）。系统日历库变化时自动重拉；
 * 隐藏的日历在前端过滤，切换显示不必重新查询。
 */
export function useAppleCalendarEvents(startMs: number, endMs: number): AppleCalendarEvent[] {
  const enabled = useNotesStore((s) => s.settings.appleCalendarEnabled);
  const hiddenIds = useNotesStore((s) => s.settings.appleCalendarHiddenIds);
  const [events, setEvents] = useState<AppleCalendarEvent[]>([]);

  useEffect(() => {
    if (!enabled) {
      setEvents([]);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api
        .appleCalendarEvents(startMs, endMs)
        .then((next) => {
          if (alive) setEvents(next);
        })
        .catch(() => {});
    };
    load();
    // iCloud 同步时变化通知会连发，合并成一次重拉
    const unlisten = listen(APPLE_CALENDAR_CHANGED_EVENT, () => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      void unlisten.then((stop) => stop());
    };
  }, [enabled, startMs, endMs]);

  return useMemo(() => {
    if (!enabled) return NO_EVENTS;
    const hidden = Array.isArray(hiddenIds) ? hiddenIds : [];
    // 区间切换时旧结果到新结果之间有一拍空档，按当前区间过滤免得错日显示
    return events.filter(
      (event) => !hidden.includes(event.calendarId) && eventOverlaps(event, startMs, endMs)
    );
  }, [enabled, events, hiddenIds, startMs, endMs]);
}
