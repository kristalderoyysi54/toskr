import { useMemo } from "react";

import { BillAvatar } from "@/components/subscriptions/BillList";
import { SlidingTabIndicator } from "@/components/ui/sliding-tab-indicator";
import { billOccurrencesInRange, startOfBillDay } from "@/lib/bills";
import { cn } from "@/lib/utils";
import type { Bill } from "@/store/notesStore";

const WEEKDAY = "日一二三四五六";
const DAY_MS = 86_400_000;

/** 未来 7 天各天的到期账单（含今天；仅 active）。 */
export function weekDayBills(bills: Bill[], now: number): { day: number; bills: Bill[] }[] {
  const from = startOfBillDay(now);
  const base = new Date(from);
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + i).getTime()
  );
  const end = days[6] + DAY_MS;
  const byDay = new Map<number, Bill[]>(days.map((d) => [d, []]));
  for (const bill of bills) {
    for (const day of billOccurrencesInRange(bill, from, end)) {
      byDay.get(day)?.push(bill);
    }
  }
  return days.map((day) => ({ day, bills: byDay.get(day) ?? [] }));
}

/**
 * 7 天周条（Bills 风格）：日期胶囊 + 到期服务图标点，点选某天看当日账单。
 */
export function BillWeekStrip({
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
  const days = useMemo(() => weekDayBills(bills, now), [bills, now]);
  return (
    <div
      role="tablist"
      aria-label="未来 7 天到期"
      className="surface-inset grid grid-cols-7 gap-1 rounded-xl p-1"
    >
      {days.map(({ day, bills: dueBills }) => {
        const d = new Date(day);
        const selected = day === selectedDay;
        return (
          <button
            key={day}
            role="tab"
            aria-selected={selected}
            onClick={() => onSelectDay(day)}
            className={cn(
              "relative flex flex-col items-center gap-1 rounded-lg px-0.5 py-1.5 outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "text-primary-foreground"
                : "hover:bg-black/5 dark:hover:bg-white/10"
            )}
          >
            {selected && (
              <SlidingTabIndicator layoutId="bill-week-thumb" variant="primary" />
            )}
            <span
              className={cn(
                "relative z-10 text-micro",
                selected ? "text-primary-foreground/80" : "text-muted-foreground"
              )}
            >
              {WEEKDAY[d.getDay()]}
            </span>
            <span className="relative z-10 text-body font-semibold tabular-nums">
              {d.getDate()}
            </span>
            {/* 到期点位：无到期给虚线空位（对齐参考稿的占位圆） */}
            <span className="relative z-10 flex h-3.5 items-center gap-0.5">
              {dueBills.length ? (
                <>
                  <BillAvatar bill={dueBills[0]} size="sm" />
                  {dueBills.length > 1 && (
                    <span
                      className={cn(
                        "text-micro tabular-nums",
                        selected ? "text-primary-foreground/80" : "text-muted-foreground"
                      )}
                    >
                      +{dueBills.length - 1}
                    </span>
                  )}
                </>
              ) : (
                <span
                  className={cn(
                    "size-2 rounded-full border border-dashed",
                    selected ? "border-primary-foreground/40" : "border-border"
                  )}
                  aria-hidden
                />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
