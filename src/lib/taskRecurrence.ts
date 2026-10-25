import { getLocale, intlLocale, t } from "@/lib/i18n";
import type { TaskRecurrence } from "@/store/notesStore";

/** 重复任务的期次计算（纯函数；只依赖类型，供 store 直接引用而不成环）。 */

/** 某年某月第 day 日（超出月末取月末），保留给定时刻。 */
function clampedMonthDate(y: number, m: number, day: number, h: number, min: number): number {
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, last), h, min, 0, 0).getTime();
}

/** 从 base 之后（不含 base 当天）找下一个符合规则的日子，时刻取 timeOf。 */
function stepAfter(rec: TaskRecurrence, base: number, timeOf: Date, anchor: Date): number {
  const h = timeOf.getHours();
  const min = timeOf.getMinutes();
  const b = new Date(base);
  const at = (addDays: number) =>
    new Date(b.getFullYear(), b.getMonth(), b.getDate() + addDays, h, min, 0, 0).getTime();
  switch (rec.freq) {
    case "daily":
      return at(1);
    case "weekdays":
    case "weekly": {
      const days =
        rec.freq === "weekdays" ? [1, 2, 3, 4, 5] : rec.weekdays?.length ? rec.weekdays : [anchor.getDay()];
      for (let add = 1; add <= 7; add++) {
        if (days.includes(new Date(at(add)).getDay())) return at(add);
      }
      return at(7);
    }
    case "monthly":
      return clampedMonthDate(b.getFullYear(), b.getMonth() + 1, rec.monthDay ?? anchor.getDate(), h, min);
    case "yearly": {
      // 从完成时：完成日加一个日历年；按计划：原始月日（闰日平年取 2/28，闰年回到 2/29）
      const { month, day } =
        rec.basis === "completion"
          ? { month: b.getMonth(), day: b.getDate() }
          : rec.yearlyAnchor ?? { month: anchor.getMonth(), day: anchor.getDate() };
      return clampedMonthDate(b.getFullYear() + 1, month, day, h, min);
    }
  }
}

/**
 * 重复任务下一期的到期时间。按计划：从本期 dueAt 往后推；从完成时：从完成时刻往后推。
 * 两种都保留本期的时刻，并跳过已过去的期次（逾期多日才完成的每日任务，下一期落在今天之后）。
 */
export function nextRecurrenceDue(
  rec: TaskRecurrence,
  dueAt: number,
  completedAt: number
): number {
  const timeOf = new Date(dueAt);
  const anchor = new Date(dueAt);
  let next = stepAfter(rec, rec.basis === "completion" ? completedAt : dueAt, timeOf, anchor);
  // 按计划补齐：跳过 completedAt 之前的期次（上限防异常数据死循环）
  for (let i = 0; i < 1000 && next <= completedAt; i++) {
    next = stepAfter(rec, next, timeOf, anchor);
  }
  return next;
}

/**
 * 完成本期后的下一期：期次计算 + 结束条件。返回 null = 规则已到头，不再生成。
 * 下一期沿用的规则里 count 已减 1；until 原样带下去。
 */
export function nextRecurrence(
  rec: TaskRecurrence,
  dueAt: number,
  completedAt: number
): { dueAt: number; recurrence: TaskRecurrence } | null {
  if (rec.count !== undefined && rec.count <= 1) return null;
  // 每年按计划：把原始月日写进规则带下去，否则 2/29 落到 2/28 后再也回不来
  let carried = rec;
  if (rec.freq === "yearly") {
    const { yearlyAnchor, ...rest } = rec;
    const d = new Date(dueAt);
    carried =
      rec.basis === "completion"
        ? rest
        : { ...rest, yearlyAnchor: yearlyAnchor ?? { month: d.getMonth(), day: d.getDate() } };
  }
  const next = nextRecurrenceDue(carried, dueAt, completedAt);
  if (rec.until !== undefined) {
    const u = new Date(rec.until);
    const endOfUntil = new Date(u.getFullYear(), u.getMonth(), u.getDate() + 1).getTime();
    if (next >= endOfUntil) return null;
  }
  return {
    dueAt: next,
    recurrence: carried.count !== undefined ? { ...carried, count: carried.count - 1 } : carried,
  };
}

const WEEKDAY_SHORT = "日一二三四五六";

const zh = () => getLocale() === "zh";
const pad2 = (n: number) => String(n).padStart(2, "0");
/** 英文星期名（0 = 周日；2023-01-01 恰为周日）。 */
const enWeekday = (d: number, weekday: "short" | "narrow") =>
  new Date(2023, 0, 1 + d).toLocaleDateString(intlLocale(), { weekday });

/** 星期短名：中文「周一」，英文「Mon」。 */
export function weekdayLabel(d: number): string {
  return zh() ? `周${WEEKDAY_SHORT[d]}` : enWeekday(d, "short");
}

/** 星期单字（七格表头/选择器用）：中文「一」，英文默认「M」，宽格可传 "short" 得「Mon」。 */
export function weekdayChar(d: number, en: "narrow" | "short" = "narrow"): string {
  return zh() ? WEEKDAY_SHORT[d] : enWeekday(d, en);
}

/** 时刻：中文 24 小时制（padHour 决定小时补零），英文「8:00 PM」。 */
export function clockLabel(hour: number, minute: number, padHour = true): string {
  if (zh()) return `${padHour ? pad2(hour) : hour}:${pad2(minute)}`;
  return new Date(2023, 0, 1, hour, minute).toLocaleTimeString(intlLocale(), {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** 月日：中文「10月3日」，英文「Oct 3」。 */
export function monthDayLabel(date: Date): string {
  if (zh()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

/** 月份标题：中文「2026 年 10 月」，英文「October 2026」。 */
export function monthYearLabel(date: Date): string {
  if (zh()) return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
  return date.toLocaleDateString(intlLocale(), { year: "numeric", month: "long" });
}

/** 重复规则短标签（行内 chip 用）。 */
export function recurrenceLabel(rec: TaskRecurrence, dueAt: number | null): string {
  const anchor = dueAt !== null ? new Date(dueAt) : new Date();
  const until = rec.until !== undefined ? new Date(rec.until) : null;
  const end = until
    ? t("，到 {date}", {
        date: zh()
          ? `${until.getFullYear()}/${until.getMonth() + 1}/${until.getDate()}`
          : until.toLocaleDateString(intlLocale(), { year: "numeric", month: "short", day: "numeric" }),
      })
    : rec.count !== undefined
      ? t("，剩 {n} 次", { n: rec.count })
      : "";
  const suffix = (rec.basis === "completion" ? t("（完成后起算）") : "") + end;
  switch (rec.freq) {
    case "daily":
      return t("每天") + suffix;
    case "weekdays":
      return t("工作日") + suffix;
    case "weekly": {
      const days = rec.weekdays?.length ? rec.weekdays : [anchor.getDay()];
      const names = zh() ? days.map((d) => WEEKDAY_SHORT[d]).join("") : days.map(weekdayLabel).join(", ");
      return t("每周{days}", { days: names }) + suffix;
    }
    case "monthly":
      return t("每月 {day} 日", { day: rec.monthDay ?? anchor.getDate() }) + suffix;
    case "yearly": {
      if (rec.basis === "completion") return t("每年") + suffix;
      const { month, day } = rec.yearlyAnchor ?? { month: anchor.getMonth(), day: anchor.getDate() };
      const date = zh() ? `${month + 1}/${day}` : monthDayLabel(new Date(2024, month, day));
      return t("每年 {date}", { date }) + suffix;
    }
  }
}
