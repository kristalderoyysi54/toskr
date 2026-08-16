import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { billOccurrencesInRange, CYCLE_COLORS, CYCLE_LABEL, startOfBillDay } from "@/lib/bills";
import { cn } from "@/lib/utils";
import type { Bill, BillCycle } from "@/store/notesStore";

const WEEK_HEADER = ["一", "二", "三", "四", "五", "六", "日"];

/**
 * 紧凑月历：日期格 + 周期色点（最多 3 个），点选某天看当日账单。
 * 周一起始（对齐参考稿）；月份可前后翻，「今天」一键回当月。
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
  const [monthOffset, setMonthOffset] = useState(0);
  const today = startOfBillDay(now);
  const base = new Date(now);
  const year = new Date(base.getFullYear(), base.getMonth() + monthOffset, 1);

  const { cells, dotsByDay } = useMemo(() => {
    const monthStart = new Date(year.getFullYear(), year.getMonth(), 1);
    const monthEnd = new Date(year.getFullYear(), year.getMonth() + 1, 1);
    // 周一起始：getDay() 周日=0 → 周一列偏移 (day+6)%7
    const lead = (monthStart.getDay() + 6) % 7;
    const daysInMonth = new Date(year.getFullYear(), year.getMonth() + 1, 0).getDate();
    const cells: (number | null)[] = [
      ...Array.from({ length: lead }, () => null),
      ...Array.from({ length: daysInMonth }, (_, i) =>
        new Date(year.getFullYear(), year.getMonth(), i + 1).getTime()
      ),
    ];
    const dotsByDay = new Map<number, BillCycle[]>();
    for (const bill of bills) {
      for (const day of billOccurrencesInRange(
        bill,
        monthStart.getTime(),
        monthEnd.getTime()
      )) {
        const dots = dotsByDay.get(day) ?? [];
        if (!dots.includes(bill.cycle)) dots.push(bill.cycle);
        dotsByDay.set(day, dots);
      }
    }
    return { cells, dotsByDay };
    // year 由 monthOffset 派生，依赖它即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bills, monthOffset, now]);

  const usedCycles = useMemo(() => {
    const set = new Set<BillCycle>();
    for (const dots of dotsByDay.values()) dots.forEach((c) => set.add(c));
    return (Object.keys(CYCLE_LABEL) as BillCycle[]).filter((c) => set.has(c));
  }, [dotsByDay]);

  return (
    <div className="surface-inset rounded-xl p-2">
      <div className="mb-1 flex items-center gap-1">
        <p className="flex-1 pl-1 text-label font-semibold tabular-nums">
          {year.getFullYear()} 年 {year.getMonth() + 1} 月
        </p>
        {monthOffset !== 0 && (
          <button
            onClick={() => setMonthOffset(0)}
            className="rounded-md px-1.5 py-0.5 text-micro text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
          >
            今天
          </button>
        )}
        <IconButton label="上个月" size="2xs" onClick={() => setMonthOffset((v) => v - 1)}>
          <ChevronLeft />
        </IconButton>
        <IconButton label="下个月" size="2xs" onClick={() => setMonthOffset((v) => v + 1)}>
          <ChevronRight />
        </IconButton>
      </div>
      <div className="grid grid-cols-7 gap-px">
        {WEEK_HEADER.map((w) => (
          <span key={w} className="py-0.5 text-center text-micro text-muted-foreground">
            {w}
          </span>
        ))}
        {cells.map((day, i) =>
          day === null ? (
            <span key={`lead-${i}`} />
          ) : (
            <button
              key={day}
              onClick={() => onSelectDay(day)}
              aria-label={`${new Date(day).getMonth() + 1}月${new Date(day).getDate()}日`}
              className={cn(
                "flex flex-col items-center rounded-md py-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                day === selectedDay
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-black/5 dark:hover:bg-white/10",
                day === today && day !== selectedDay && "font-semibold text-primary"
              )}
            >
              <span className="text-label tabular-nums">{new Date(day).getDate()}</span>
              <span className="flex h-1.5 items-center gap-0.5">
                {(dotsByDay.get(day) ?? []).slice(0, 3).map((cycle) => (
                  <span
                    key={cycle}
                    className="size-1 rounded-full"
                    style={{ backgroundColor: CYCLE_COLORS[cycle] }}
                    aria-hidden
                  />
                ))}
              </span>
            </button>
          )
        )}
      </div>
      {usedCycles.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 px-1">
          {usedCycles.map((cycle) => (
            <span
              key={cycle}
              className="flex items-center gap-1 text-micro text-muted-foreground"
            >
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: CYCLE_COLORS[cycle] }}
                aria-hidden
              />
              {CYCLE_LABEL[cycle]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
