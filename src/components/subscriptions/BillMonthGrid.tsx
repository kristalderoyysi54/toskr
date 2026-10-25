import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { BillAvatar } from "@/components/subscriptions/BillList";
import { IconButton } from "@/components/ui/icon-button";
import {
  advanceCycle,
  billOccurrencesInRange,
  CYCLE_COLORS,
  CYCLE_LABEL,
  startOfBillDay,
} from "@/lib/bills";
import { useT } from "@/lib/i18n";
import { monthDayLabel, monthYearLabel, weekdayChar } from "@/lib/taskRecurrence";
import { cn } from "@/lib/utils";
import type { Bill, BillCycle } from "@/store/notesStore";

/** 周一起排的表头（星期序号，显示时按语言取单字）。 */
const WEEK_HEADER = [1, 2, 3, 4, 5, 6, 0];

/** 相邻月占位格的斜纹底（参考稿样式；明暗双色由 currentColor 透明度承担）。 */
const HATCH_STYLE = {
  backgroundImage:
    "repeating-linear-gradient(135deg, transparent, transparent 3px, currentColor 3px, currentColor 4px)",
} as const;

interface DayCell {
  day: number;
  inMonth: boolean;
  bills: Bill[];
}

/**
 * 紧凑月历（Bills 风格细节版）：整周补齐相邻月日子（斜纹底、同样显示到期
 * 服务图标）；格内日期 + 右上角周期色点 + 底部服务图标（多笔 +N）；
 * 下方常显五色周期图例与 活跃/已暂停/已取消、已续订/即将续订 统计。
 */
export function BillMonthGrid({
  bills,
  now,
  selectedDay,
  onSelectDay,
}: {
  bills: Bill[];
  now: number;
  selectedDay: number;
  onSelectDay: (day: number) => void;
}) {
  const t = useT();
  const [monthOffset, setMonthOffset] = useState(0);
  const today = startOfBillDay(now);
  const base = new Date(now);
  const monthFirst = new Date(base.getFullYear(), base.getMonth() + monthOffset, 1);

  const { cells, renewed, upcoming } = useMemo(() => {
    const y = monthFirst.getFullYear();
    const m = monthFirst.getMonth();
    const monthStart = new Date(y, m, 1).getTime();
    const monthEnd = new Date(y, m + 1, 1).getTime();
    // 周一起始整周补齐：前导取上月尾、末尾补下月头（参考稿的斜纹占位格）
    const lead = (new Date(monthStart).getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const rows = Math.ceil((lead + daysInMonth) / 7);
    const gridStart = new Date(y, m, 1 - lead).getTime();
    const gridDays = rows * 7;
    const gridEnd = new Date(y, m, 1 - lead + gridDays).getTime();

    const byDay = new Map<number, Bill[]>();
    for (const bill of bills) {
      for (const day of billOccurrencesInRange(bill, gridStart, gridEnd)) {
        const list = byDay.get(day) ?? [];
        list.push(bill);
        byDay.set(day, list);
      }
    }
    const cells: DayCell[] = Array.from({ length: gridDays }, (_, i) => {
      const day = new Date(y, m, 1 - lead + i).getTime();
      return {
        day,
        inMonth: day >= monthStart && day < monthEnd,
        bills: byDay.get(day) ?? [],
      };
    });

    // 已续订 = 本月已落账的记账事件数；即将续订 = 本月剩余（今天起）的到期次数。
    // 只数订阅：信用卡是「还款」不是「续订」，混进来口径失真（用户 2026-08-16 指定）
    let renewed = 0;
    let upcoming = 0;
    for (const bill of bills) {
      if (bill.kind !== "subscription") continue;
      for (const ev of bill.history) {
        if (ev.periodDueAt >= monthStart && ev.periodDueAt < monthEnd) renewed += 1;
      }
      if (bill.status !== "active") continue;
      let due = bill.nextDueAt;
      let guard = 0;
      while (due < monthEnd && guard < 8) {
        if (due >= monthStart && due >= today) upcoming += 1;
        due = advanceCycle(due, bill.cycle);
        guard += 1;
      }
    }
    return { cells, renewed, upcoming };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bills, monthOffset, now]);

  // 状态统计同样只数订阅（月历格子本身仍显示信用卡到期，不受影响）
  const statusCount = useMemo(() => {
    const subs = bills.filter((b) => b.kind === "subscription");
    return {
      active: subs.filter((b) => b.status === "active").length,
      paused: subs.filter((b) => b.status === "paused").length,
      canceled: subs.filter((b) => b.status === "canceled").length,
    };
  }, [bills]);

  return (
    <div className="surface-inset rounded-xl p-2">
      <div className="mb-1 flex items-center gap-1">
        <p className="flex-1 pl-1 text-label font-semibold tabular-nums">
          {monthYearLabel(monthFirst)}
        </p>
        {monthOffset !== 0 && (
          <button
            onClick={() => setMonthOffset(0)}
            className="rounded-md px-1.5 py-0.5 text-micro text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
          >
            {t("今天")}
          </button>
        )}
        <IconButton label={t("上个月")} size="2xs" onClick={() => setMonthOffset((v) => v - 1)}>
          <ChevronLeft />
        </IconButton>
        <IconButton label={t("下个月")} size="2xs" onClick={() => setMonthOffset((v) => v + 1)}>
          <ChevronRight />
        </IconButton>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {WEEK_HEADER.map((w) => (
          <span key={w} className="py-0.5 text-center text-micro text-muted-foreground">
            {weekdayChar(w, "short")}
          </span>
        ))}
        {cells.map(({ day, inMonth, bills: dueBills }) => {
          const selected = day === selectedDay;
          const cycles: BillCycle[] = [];
          for (const b of dueBills) if (!cycles.includes(b.cycle)) cycles.push(b.cycle);
          return (
            <button
              key={day}
              onClick={() => onSelectDay(day)}
              aria-label={`${monthDayLabel(new Date(day))}${
                dueBills.length ? t("，{n} 笔到期", { n: dueBills.length }) : ""
              }`}
              className={cn(
                "relative flex h-11 flex-col items-center justify-start rounded-lg pt-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "bg-primary text-primary-foreground"
                  : inMonth
                    ? "bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
                    : "bg-black/[0.03] text-muted-foreground/70 hover:bg-black/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
              )}
            >
              {/* 相邻月斜纹底：铺满整格、不遮内容 */}
              {!inMonth && !selected && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-lg text-border/60"
                  style={HATCH_STYLE}
                />
              )}
              {/* 周期色点：右上角，最多两色 */}
              <span className="absolute right-1 top-1 flex gap-0.5">
                {cycles.slice(0, 2).map((cycle) => (
                  <span
                    key={cycle}
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: CYCLE_COLORS[cycle] }}
                    aria-hidden
                  />
                ))}
              </span>
              <span
                className={cn(
                  "relative text-label tabular-nums",
                  day === today && !selected && "font-semibold text-primary"
                )}
              >
                {new Date(day).getDate()}
              </span>
              {/* 底部服务图标：首笔头像 + 多笔 +N 角标（参考稿的 +1 泡） */}
              {dueBills.length > 0 && (
                <span className="relative mt-px flex items-center">
                  <BillAvatar bill={dueBills[0]} size="sm" />
                  {dueBills.length > 1 && (
                    <span
                      className={cn(
                        "-ml-1 -mt-2 rounded-full px-0.5 text-micro font-semibold tabular-nums",
                        selected
                          ? "bg-primary-foreground/90 text-primary"
                          : "bg-amber-500 text-white"
                      )}
                    >
                      +{dueBills.length - 1}
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* 图例与统计：五色周期常显 + 状态/本月续订统计（参考稿样式） */}
      <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 px-1">
        {(Object.keys(CYCLE_LABEL) as BillCycle[]).map((cycle) => (
          <span
            key={cycle}
            className="flex items-center gap-1 text-micro text-muted-foreground"
          >
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: CYCLE_COLORS[cycle] }}
              aria-hidden
            />
            {t(CYCLE_LABEL[cycle])}
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 px-1 text-micro text-muted-foreground">
        <span>
          <b className="font-semibold text-primary tabular-nums">{statusCount.active}</b> {t("活跃")}
        </span>
        <span>
          <b className="font-semibold text-amber-500 tabular-nums">{statusCount.paused}</b> {t("已暂停")}
        </span>
        <span>
          <b className="font-semibold text-destructive tabular-nums">{statusCount.canceled}</b> {t("已取消")}
        </span>
        <span>
          <b className="font-semibold text-success tabular-nums">{renewed}</b> {t("已续订")}
        </span>
        <span>
          <b className="font-semibold text-amber-500 tabular-nums">{upcoming}</b> {t("即将续订")}
        </span>
      </div>
    </div>
  );
}
