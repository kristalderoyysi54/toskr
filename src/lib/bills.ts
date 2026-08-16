import type {
  Bill,
  BillCycle,
  ReminderOffsetDays,
} from "@/store/notesStore";

// ===== 账单（订阅/信用卡）纯函数域：周期滚动 / 提醒判定 / 消费聚合 =====
// 只做 type-import，保持与 store 无运行时环依赖（store 反向 value-import 本文件）。

const DAY_MS = 86_400_000;

/** 本地时区当天 00:00。 */
export function startOfBillDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 保留时分、只加天数（周付用；分量式构造，不做裸 ms 加减）。 */
function addDaysKeepTime(d: Date, days: number): Date {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours(),
    d.getMinutes(),
    0,
    0
  );
}

/**
 * 加月并按目标月天数钳制（月/季/半年/年付统一入口）。
 * 例：1/31 +1 月 → 2/28（闰年 2/29），不会溢出到 3 月。
 */
function addMonthsClamped(d: Date, months: number): Date {
  const day = d.getDate();
  const first = new Date(
    d.getFullYear(),
    d.getMonth() + months,
    1,
    d.getHours(),
    d.getMinutes(),
    0,
    0
  );
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  first.setDate(Math.min(day, lastDay));
  return first;
}

/** 下一期到期日。 */
export function advanceCycle(dueAt: number, cycle: BillCycle): number {
  const d = new Date(dueAt);
  switch (cycle) {
    case "weekly":
      return addDaysKeepTime(d, 7).getTime();
    case "monthly":
      return addMonthsClamped(d, 1).getTime();
    case "quarterly":
      return addMonthsClamped(d, 3).getTime();
    case "semiannual":
      return addMonthsClamped(d, 6).getTime();
    case "yearly":
      return addMonthsClamped(d, 12).getTime();
  }
}

export interface BillReminderHit {
  bill: Bill;
  offset: ReminderOffsetDays;
}

/**
 * 需要提醒的 (账单, 档位) 组合：active 且该档在当前账期内未提醒过。
 * 去重键 (billId, nextDueAt, offset) 隐含在 remindedFor 里——滚动周期后
 * remindedFor 重置，同档对新账期可再次触发。
 */
export function dueBillsToRemind(bills: Bill[], now: number): BillReminderHit[] {
  const hits: BillReminderHit[] = [];
  for (const bill of bills) {
    if (bill.status !== "active" || !bill.reminderOffsets.length) continue;
    // 防御性重置：正常路径滚动时已同步 remindedFor.dueAt，这里兜底不一致数据
    const reminded =
      bill.remindedFor.dueAt === bill.nextDueAt ? bill.remindedFor.offsets : [];
    for (const offset of bill.reminderOffsets) {
      if (reminded.includes(offset)) continue;
      const armed =
        offset === 0
          ? startOfBillDay(bill.nextDueAt) <= now
          : bill.nextDueAt - offset * DAY_MS <= now;
      if (armed) hits.push({ bill, offset });
    }
  }
  return hits;
}

/** 未来 N 天内到期的 active 账单（含今天，按到期日升序；逾期的不算「即将」）。 */
export function billsDueWithinDays(bills: Bill[], now: number, days = 7): Bill[] {
  const from = startOfBillDay(now);
  const d = new Date(from);
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
  return bills
    .filter((b) => b.status === "active" && b.nextDueAt >= from && b.nextDueAt < to)
    .sort((a, b) => a.nextDueAt - b.nextDueAt);
}

/**
 * 本月消费合计 = 本月已记账事件（含已暂停账单的历史，付了就是付了）
 * + active 账单本月内剩余的到期投影（周付可能多次；金额留空按 0 计）。
 */
export function monthlySpendTotal(bills: Bill[], now: number): number {
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const nextMonthStart = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  let total = 0;
  for (const bill of bills) {
    for (const ev of bill.history) {
      if (ev.paidAt >= monthStart && ev.paidAt < nextMonthStart) total += ev.amount;
    }
    if (bill.status !== "active") continue;
    let due = bill.nextDueAt;
    let guard = 0;
    // 周付一个月最多 5 期，8 为带余量的安全上限（防御异常数据死循环）
    while (due < nextMonthStart && guard < 8) {
      if (due >= monthStart) total += bill.amount ?? 0;
      due = advanceCycle(due, bill.cycle);
      guard += 1;
    }
  }
  return total;
}

export interface MonthSpend {
  year: number;
  /** 0-11（与 Date#getMonth 对齐）。 */
  month: number;
  label: string;
  total: number;
}

/** 近 N 个月消费（含当月，按记账事件分桶；无数据月份补 0）。 */
export function monthlySpendTrend(
  bills: Bill[],
  now: number,
  months: number
): MonthSpend[] {
  const d = new Date(now);
  const buckets: MonthSpend[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    buckets.push({
      year: m.getFullYear(),
      month: m.getMonth(),
      label: `${m.getMonth() + 1}月`,
      total: 0,
    });
  }
  for (const bill of bills) {
    for (const ev of bill.history) {
      const e = new Date(ev.paidAt);
      const hit = buckets.find(
        (b) => b.year === e.getFullYear() && b.month === e.getMonth()
      );
      if (hit) hit.total += ev.amount;
    }
  }
  return buckets;
}

/** 近 6 个月消费（迷你趋势图用）。 */
export function sixMonthTrend(bills: Bill[], now: number): MonthSpend[] {
  return monthlySpendTrend(bills, now, 6);
}

/** 近 N 年消费（含今年，按记账事件分年；无数据年补 0）。 */
export function yearlySpendTrend(
  bills: Bill[],
  now: number,
  years: number
): { year: number; label: string; total: number }[] {
  const current = new Date(now).getFullYear();
  const buckets = Array.from({ length: years }, (_, i) => ({
    year: current - (years - 1 - i),
    label: String(current - (years - 1 - i)),
    total: 0,
  }));
  for (const bill of bills) {
    for (const ev of bill.history) {
      const hit = buckets.find((b) => b.year === new Date(ev.paidAt).getFullYear());
      if (hit) hit.total += ev.amount;
    }
  }
  return buckets;
}

/** 单账单的月折算金额（周付按年均 52.18 周换算；金额留空按 0）。 */
export function monthlyEquivalent(bill: Bill): number {
  const amount = bill.amount ?? 0;
  switch (bill.cycle) {
    case "weekly":
      return (amount * 52.18) / 12;
    case "monthly":
      return amount;
    case "quarterly":
      return amount / 3;
    case "semiannual":
      return amount / 6;
    case "yearly":
      return amount / 12;
  }
}

/**
 * 月固定支出 = 活跃订阅的月折算合计。刻意不含信用卡：还款额逐期波动，
 * 不是可预期的固定订阅支出。
 */
export function monthlyFixedSpend(bills: Bill[]): number {
  return bills
    .filter((b) => b.kind === "subscription" && b.status === "active")
    .reduce((sum, b) => sum + monthlyEquivalent(b), 0);
}

/** 类别构成（活跃订阅按月折算分桶；未填类别归 "other"）。降序。 */
export function categoryBreakdown(
  bills: Bill[]
): { category: string; total: number }[] {
  const map = new Map<string, number>();
  for (const bill of bills) {
    if (bill.kind !== "subscription" || bill.status !== "active") continue;
    const key = bill.category || "other";
    map.set(key, (map.get(key) ?? 0) + monthlyEquivalent(bill));
  }
  return [...map.entries()]
    .map(([category, total]) => ({ category, total }))
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total);
}

/** 今年记账累计。 */
export function yearSpendTotal(bills: Bill[], now: number): number {
  const year = new Date(now).getFullYear();
  let total = 0;
  for (const bill of bills) {
    for (const ev of bill.history) {
      if (new Date(ev.paidAt).getFullYear() === year) total += ev.amount;
    }
  }
  return total;
}

export interface CurrencyTotal {
  currency: string;
  total: number;
}

function sortTotals(map: Map<string, number>, primary: string): CurrencyTotal[] {
  return [...map.entries()]
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) =>
      a.currency === primary ? -1 : b.currency === primary ? 1 : b.total - a.total
    );
}

/** 分币种小计的展示串：「¥68 + US$16」；空集显示主货币 0。 */
export function formatCurrencyTotals(
  totals: CurrencyTotal[],
  primary: string
): string {
  if (!totals.length) return `${primary}0`;
  return totals
    .map((t) => `${t.currency}${formatBillAmount(t.total)}`)
    .join(" + ");
}

/**
 * 本月消费分币种小计（口径同 monthlySpendTotal：本月记账 + active 剩余投影）。
 * 不做汇率，跨币种以并列小计呈现（用户可见的真话）。
 */
export function monthlySpendTotalsByCurrency(
  bills: Bill[],
  now: number,
  primary: string
): CurrencyTotal[] {
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const nextMonthStart = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  const map = new Map<string, number>();
  const add = (currency: string, amount: number) =>
    map.set(currency, (map.get(currency) ?? 0) + amount);
  for (const bill of bills) {
    const currency = bill.currency ?? primary;
    for (const ev of bill.history) {
      if (ev.paidAt >= monthStart && ev.paidAt < nextMonthStart) add(currency, ev.amount);
    }
    if (bill.status !== "active") continue;
    let due = bill.nextDueAt;
    let guard = 0;
    while (due < nextMonthStart && guard < 8) {
      if (due >= monthStart) add(currency, bill.amount ?? 0);
      due = advanceCycle(due, bill.cycle);
      guard += 1;
    }
  }
  return sortTotals(map, primary);
}

/** 月固定支出分币种小计（活跃订阅月折算）。 */
export function monthlyFixedSpendByCurrency(
  bills: Bill[],
  primary: string
): CurrencyTotal[] {
  const map = new Map<string, number>();
  for (const bill of bills) {
    if (bill.kind !== "subscription" || bill.status !== "active") continue;
    const currency = bill.currency ?? primary;
    map.set(currency, (map.get(currency) ?? 0) + monthlyEquivalent(bill));
  }
  return sortTotals(map, primary);
}

/** 今年记账分币种小计。 */
export function yearSpendTotalsByCurrency(
  bills: Bill[],
  now: number,
  primary: string
): CurrencyTotal[] {
  const year = new Date(now).getFullYear();
  const map = new Map<string, number>();
  for (const bill of bills) {
    const currency = bill.currency ?? primary;
    for (const ev of bill.history) {
      if (new Date(ev.paidAt).getFullYear() === year) {
        map.set(currency, (map.get(currency) ?? 0) + ev.amount);
      }
    }
  }
  return sortTotals(map, primary);
}

/** 账单集里出现的币种数（缺省币按 primary 计）。 */
export function distinctCurrencies(bills: Bill[], primary: string): string[] {
  return [...new Set(bills.map((b) => b.currency ?? primary))];
}

/** 上月记账合计（环比基数；只看已发生的记账，不含投影）。 */
export function prevMonthSpendTotal(bills: Bill[], now: number): number {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  let total = 0;
  for (const bill of bills) {
    for (const ev of bill.history) {
      if (ev.paidAt >= start && ev.paidAt < end) total += ev.amount;
    }
  }
  return total;
}

/**
 * 账单在 [start, end) 内的到期日（当天 00:00，升序去重）：
 * 过去看 history 记账、未来按 nextDueAt 投影；周条/月历共用。
 */
export function billOccurrencesInRange(
  bill: Bill,
  start: number,
  end: number
): number[] {
  if (bill.status !== "active") return [];
  const days = new Set<number>();
  for (const ev of bill.history) {
    if (ev.periodDueAt >= start && ev.periodDueAt < end) {
      days.add(startOfBillDay(ev.periodDueAt));
    }
  }
  let due = bill.nextDueAt;
  let guard = 0;
  // 月历最多约 6 周 × 周付 = 单账单 <10 次；40 防御异常数据
  while (due < end && guard < 40) {
    if (due >= start) days.add(startOfBillDay(due));
    due = advanceCycle(due, bill.cycle);
    guard += 1;
  }
  return [...days].sort((a, b) => a - b);
}

/** 信用卡「每月 N 日还款」→ 下一个还款日（今天符合即今天；短月钳到月末）。 */
export function nextMonthlyDueAt(dayOfMonth: number, now: number): number {
  const day = Math.min(Math.max(Math.round(dayOfMonth), 1), 31);
  const d = new Date(now);
  const at = (year: number, month: number) => {
    const last = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(day, last)).getTime();
  };
  const thisMonth = at(d.getFullYear(), d.getMonth());
  if (thisMonth >= startOfBillDay(now)) return thisMonth;
  return at(d.getFullYear(), d.getMonth() + 1);
}

/** 金额展示：最多两位小数、去尾零（68 → "68"，68.5 → "68.5"）。 */
export function formatBillAmount(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

/** HUD 提醒文案：「Netflix 3 天后续费 ¥68」「招商银行信用卡 今天还款」。
 *  currency 为全局缺省符号；单笔自带 currency 时优先。 */
export function billDueLabel(bill: Bill, now: number, currency: string): string {
  const days = Math.round(
    (startOfBillDay(bill.nextDueAt) - startOfBillDay(now)) / DAY_MS
  );
  const verb = bill.kind === "creditCard" ? "还款" : "续费";
  const symbol = bill.currency ?? currency;
  const amountTxt =
    bill.amount != null ? ` ${symbol}${formatBillAmount(bill.amount)}` : "";
  if (days < 0) return `${bill.name} ${verb}已逾期 ${-days} 天${amountTxt}`;
  const when = days === 0 ? "今天" : days === 1 ? "明天" : `${days} 天后`;
  return `${bill.name} ${when}${verb}${amountTxt}`;
}

/** 列表排序：active 在前（组内到期早在前），暂停/取消垫底（按名称）。 */
export function compareBills(a: Bill, b: Bill): number {
  const rank = (bill: Bill) => (bill.status === "active" ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (rank(a) === 0) return a.nextDueAt - b.nextDueAt;
  return a.name.localeCompare(b.name, "zh-Hans-CN");
}

export const CYCLE_LABEL: Record<BillCycle, string> = {
  weekly: "每周",
  monthly: "每月",
  quarterly: "每季",
  semiannual: "半年",
  yearly: "每年",
};

/** 周期五色（周条/月历色点与图例；用户可辨识的数据调色板，非样式 token）。 */
// token-exception: 周期色点是数据调色板（参照 SECTION_COLORS 先例），刻意独立于 design-token
export const CYCLE_COLORS: Record<BillCycle, string> = {
  weekly: "#0ea5e9",
  monthly: "#8b5cf6",
  quarterly: "#22c55e",
  semiannual: "#f97316",
  yearly: "#eab308",
};

/** 首字母色块兜底色板（与 SECTION_COLORS 同族的数据调色板）。 */
// token-exception: 数据调色板，非样式 token
const BILL_FALLBACK_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

/** 按名称稳定派生兜底色（创建时算一次落库，不随主题/改名重算）。 */
export function billFallbackColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return BILL_FALLBACK_COLORS[hash % BILL_FALLBACK_COLORS.length];
}

/** 色块头像首字：中文取首个汉字，其余取首字符大写。 */
export function billAvatarInitial(name: string): string {
  const first = [...name.trim()][0] ?? "?";
  return first.toUpperCase();
}
