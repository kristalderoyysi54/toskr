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
    case "yearly":
      return clampedMonthDate(b.getFullYear() + 1, anchor.getMonth(), anchor.getDate(), h, min);
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
  const next = nextRecurrenceDue(rec, dueAt, completedAt);
  if (rec.until !== undefined) {
    const u = new Date(rec.until);
    const endOfUntil = new Date(u.getFullYear(), u.getMonth(), u.getDate() + 1).getTime();
    if (next >= endOfUntil) return null;
  }
  return {
    dueAt: next,
    recurrence: rec.count !== undefined ? { ...rec, count: rec.count - 1 } : rec,
  };
}

const WEEKDAY_SHORT = "日一二三四五六";

/** 重复规则短标签（行内 chip 用）。 */
export function recurrenceLabel(rec: TaskRecurrence, dueAt: number | null): string {
  const anchor = dueAt !== null ? new Date(dueAt) : new Date();
  const until = rec.until !== undefined ? new Date(rec.until) : null;
  const end = until
    ? `，到 ${until.getFullYear()}/${until.getMonth() + 1}/${until.getDate()}`
    : rec.count !== undefined
      ? `，剩 ${rec.count} 次`
      : "";
  const suffix = (rec.basis === "completion" ? "（完成后起算）" : "") + end;
  switch (rec.freq) {
    case "daily":
      return `每天${suffix}`;
    case "weekdays":
      return `工作日${suffix}`;
    case "weekly": {
      const days = rec.weekdays?.length ? rec.weekdays : [anchor.getDay()];
      return `每周${days.map((d) => WEEKDAY_SHORT[d]).join("")}${suffix}`;
    }
    case "monthly":
      return `每月 ${rec.monthDay ?? anchor.getDate()} 日${suffix}`;
    case "yearly":
      return `每年 ${anchor.getMonth() + 1}/${anchor.getDate()}${suffix}`;
  }
}
