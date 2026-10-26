import { describe, expect, it } from "vitest";

import type { AppleCalendarEvent } from "@/lib/tauri";

import { eventOverlaps, eventTimeLabel, groupEventsByDay, nextDayStart, sortEvents } from "./appleCalendar";

const at = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime();

function ev(partial: Partial<AppleCalendarEvent> & { startMs: number; endMs: number }): AppleCalendarEvent {
  return {
    id: `e@${partial.startMs}`,
    title: "会议",
    allDay: false,
    calendarId: "c1",
    calendarTitle: "工作",
    calendarColor: null,
    location: null,
    itemId: "item",
    recurring: false,
    ...partial,
  };
}

describe("appleCalendar", () => {
  it("nextDayStart 按日历日推进", () => {
    expect(nextDayStart(at(26))).toBe(at(27));
    expect(nextDayStart(at(31))).toBe(new Date(2026, 10, 1).getTime());
  });

  it("全天日程结束于次日 0 点，不落到次日", () => {
    const allDay = ev({ startMs: at(26), endMs: at(27), allDay: true });
    expect(eventOverlaps(allDay, at(26), at(27))).toBe(true);
    expect(eventOverlaps(allDay, at(27), at(28))).toBe(false);
  });

  it("零时长日程仍算进它所在的那天", () => {
    const point = ev({ startMs: at(26, 9), endMs: at(26, 9) });
    expect(eventOverlaps(point, at(26), at(27))).toBe(true);
  });

  it("跨天日程每天都出现，空天不建条目", () => {
    const trip = ev({ startMs: at(26, 20), endMs: at(28, 10) });
    const byDay = groupEventsByDay([trip], [at(25), at(26), at(27), at(28), at(29)]);
    expect([...byDay.keys()]).toEqual([at(26), at(27), at(28)]);
  });

  it("排序：全天在前，再按开始时刻", () => {
    const sorted = sortEvents([
      ev({ id: "b", startMs: at(26, 10), endMs: at(26, 11) }),
      ev({ id: "a", startMs: at(26, 9), endMs: at(26, 10) }),
      ev({ id: "all", startMs: at(26), endMs: at(27), allDay: true }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["all", "a", "b"]);
  });

  it("时间说明：同日只写时刻，跨天带结束日期", () => {
    expect(eventTimeLabel(ev({ startMs: at(26, 9), endMs: at(26, 10, 30) }), "全天")).toBe("09:00–10:30");
    expect(eventTimeLabel(ev({ startMs: at(26, 9), endMs: at(27), allDay: true }), "全天")).toBe("全天");
    expect(eventTimeLabel(ev({ startMs: at(26, 22), endMs: at(27, 1) }), "全天")).toMatch(/^22:00–.+ 01:00$/);
  });
});
