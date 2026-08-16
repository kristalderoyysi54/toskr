import { useEffect, useMemo, useState } from "react";

import { distinctCurrencies, formatBillAmount, sixMonthTrend } from "@/lib/bills";
import { cachedFx, ensureFx, makeConverter, type FxCache } from "@/lib/currency";
import { cn } from "@/lib/utils";
import type { Bill } from "@/store/notesStore";

/**
 * 近 6 个月消费迷你柱状图：纯 CSS（div 高度百分比），零图表依赖。
 * 数据源是记账事件流；当月是进行中的部分值。
 * 币种规则（与摘要条一致）：单一币种用原币符号原值；多币种按当日汇率
 * 折算主货币（金额带 ≈）；汇率未就绪则主符号混计。
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
  const [fx, setFx] = useState<FxCache | null>(() => cachedFx());
  useEffect(() => {
    void ensureFx().then((next) => {
      if (next) setFx(next);
    });
  }, []);

  const { trend, symbol, approx } = useMemo(() => {
    const distinct = distinctCurrencies(bills, currency);
    const convert = makeConverter(currency, fx);
    const useConversion = distinct.length > 1 && convert !== null;
    return {
      trend: sixMonthTrend(bills, now, useConversion ? convert : undefined),
      symbol: useConversion ? currency : (distinct[0] ?? currency),
      approx: useConversion,
    };
  }, [bills, now, currency, fx]);
  const max = Math.max(...trend.map((m) => m.total));
  if (max <= 0) return null;
  const amountText = (total: number) =>
    `${approx ? "≈ " : ""}${symbol}${formatBillAmount(Math.round(total * 100) / 100)}`;
  return (
    <div className="surface-inset rounded-xl p-2">
      <p className="pl-1 text-micro text-muted-foreground">近 6 个月消费</p>
      <div className="mt-1 flex items-end gap-1.5 px-1">
        {trend.map((m, i) => {
          const current = i === trend.length - 1;
          return (
            <div
              key={`${m.year}-${m.month}`}
              className="group/bar flex min-w-0 flex-1 flex-col items-center gap-0.5"
              title={`${m.year} 年 ${m.label} ${amountText(m.total)}`}
            >
              {/* 悬停亮出金额（title 原生提示慢，柱顶直给） */}
              <span className="h-3 whitespace-nowrap text-micro tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/bar:opacity-100">
                {m.total > 0 ? amountText(m.total) : ""}
              </span>
              {/* 柱容器定高：百分比柱高必须挂在确定高度上（auto 链解析为 0） */}
              <div className="flex h-10 w-full items-end">
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
