import { useMemo } from "react";

import { formatBillAmount, sixMonthTrend } from "@/lib/bills";
import { cn } from "@/lib/utils";
import type { Bill } from "@/store/notesStore";

/**
 * 近 6 个月消费迷你柱状图：纯 CSS（div 高度百分比），零图表依赖。
 * 数据源是记账事件流；当月是进行中的部分值。
 */
export function BillTrendChart({
  bills,
  now,
  currency,
}: {
  bills: Bill[];
  now: number;
  currency: string;
}) {
  const trend = useMemo(() => sixMonthTrend(bills, now), [bills, now]);
  const max = Math.max(...trend.map((m) => m.total));
  if (max <= 0) return null;
  return (
    <div className="surface-inset rounded-xl p-2">
      <p className="pl-1 text-micro text-muted-foreground">近 6 个月消费</p>
      <div className="mt-1 flex h-14 items-end gap-1.5 px-1">
        {trend.map((m, i) => {
          const current = i === trend.length - 1;
          return (
            <div
              key={`${m.year}-${m.month}`}
              className="flex min-w-0 flex-1 flex-col items-center gap-0.5"
              title={`${m.year} 年 ${m.label} ${currency}${formatBillAmount(m.total)}`}
            >
              <div className="flex w-full flex-1 items-end">
                <div
                  className={cn(
                    "w-full rounded-sm",
                    current ? "bg-muted-foreground/70" : "bg-muted-foreground/30"
                  )}
                  style={{ height: `${Math.max((m.total / max) * 100, m.total > 0 ? 6 : 2)}%` }}
                />
              </div>
              <span
                className={cn(
                  "text-micro tabular-nums",
                  current ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {m.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
