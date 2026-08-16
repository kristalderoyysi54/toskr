import { useEffect, useMemo, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";

import {
  CATALOG_CATEGORY_LABEL,
  type CatalogCategory,
} from "@/components/subscriptions/billCatalog";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { Segmented } from "@/components/ui/segmented";
import {
  categoryBreakdown,
  distinctCurrencies,
  formatBillAmount,
  formatCurrencyTotals,
  monthlyFixedSpend,
  monthlyFixedSpendByCurrency,
  monthlySpendTotal,
  monthlySpendTrend,
  monthlySpendTotalsByCurrency,
  prevMonthSpendTotal,
  yearlySpendTrend,
  yearSpendTotal,
  yearSpendTotalsByCurrency,
} from "@/lib/bills";
import { cachedFx, ensureFx, makeConverter, type FxCache } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { useNotesStore, type Bill } from "@/store/notesStore";

/** 类别配色（数据调色板，与目录七类一一对应；未分类灰）。 */
// token-exception: 数据调色板，非样式 token
const CATEGORY_COLORS: Record<string, string> = {
  entertainment: "#ef4444",
  music: "#ec4899",
  productivity: "#22c55e",
  dev: "#3b82f6",
  ai: "#8b5cf6",
  cloud: "#14b8a6",
  other: "#94a3b8",
};

function categoryLabel(category: string): string {
  if (category === "other") return "其他";
  return CATALOG_CATEGORY_LABEL[category as CatalogCategory] ?? "其他";
}

/**
 * 消费分析全屏覆盖层：指标卡（本月/月固定/年度/活跃）+ 月/年趋势柱状 +
 * 类别环形（conic-gradient，零图表库）。
 * 口径：趋势 = 真实记账（含信用卡已还）；月固定支出与类别构成 = 活跃订阅
 * 的月折算（信用卡还款波动大，刻意排除，见 lib/bills 注释）。
 */
export function BillAnalytics({
  bills,
  now,
  open,
  onOpenChange,
}: {
  bills: Bill[];
  now: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const currency = useNotesStore((s) => s.settings.currencySymbol);
  const [range, setRange] = useState<"month" | "year">("month");
  // 打开时确保当日汇率（24h 缓存；失败回退过期缓存 → 再退分列显示）
  const [fx, setFx] = useState<FxCache | null>(() => cachedFx());
  useEffect(() => {
    if (!open) return;
    void ensureFx().then((next) => {
      if (next) setFx(next);
    });
  }, [open]);
  const convert = useMemo(() => makeConverter(currency, fx), [currency, fx]);

  const stats = useMemo(() => {
    const multiCurrency = distinctCurrencies(bills, currency).length > 1;
    const monthParts = formatCurrencyTotals(
      monthlySpendTotalsByCurrency(bills, now, currency),
      currency
    );
    const fixedParts = formatCurrencyTotals(
      monthlyFixedSpendByCurrency(bills, currency),
      currency
    );
    const yearParts = formatCurrencyTotals(
      yearSpendTotalsByCurrency(bills, now, currency),
      currency
    );
    // 有汇率：统一折算主货币（多币种加 ≈），原币种分列进小字；无汇率：分列为主
    const approx = multiCurrency && convert ? "≈ " : "";
    const conv = convert ?? undefined;
    const monthTotal = monthlySpendTotal(bills, now, conv);
    const prev = prevMonthSpendTotal(bills, now, conv);
    const canCompare = prev > 0 && (convert !== null || !multiCurrency);
    return {
      monthText: convert
        ? `${approx}${currency}${formatBillAmount(Math.round(monthTotal * 100) / 100)}`
        : monthParts,
      monthParts,
      momPct: canCompare ? ((monthTotal - prev) / prev) * 100 : null,
      fixedText: convert
        ? `${approx}${currency}${formatBillAmount(Math.round(monthlyFixedSpend(bills, conv) * 100) / 100)}`
        : fixedParts,
      fixedParts,
      yearText: convert
        ? `${approx}${currency}${formatBillAmount(Math.round(yearSpendTotal(bills, now, conv) * 100) / 100)}`
        : yearParts,
      yearParts,
      active: bills.filter((b) => b.status === "active").length,
      multiCurrency,
      converted: convert !== null,
    };
  }, [bills, now, currency, convert]);

  const trend = useMemo(
    () =>
      range === "month"
        ? monthlySpendTrend(bills, now, 12, convert ?? undefined).map((m) => ({
            ...m,
            key: `${m.year}-${m.month}`,
          }))
        : yearlySpendTrend(bills, now, 4, convert ?? undefined).map((y) => ({
            ...y,
            key: String(y.year),
          })),
    [bills, now, range, convert]
  );
  const trendMax = Math.max(...trend.map((t) => t.total), 0);

  const categories = useMemo(
    () => categoryBreakdown(bills, convert ?? undefined),
    [bills, convert]
  );
  const categoryTotal = categories.reduce((sum, c) => sum + c.total, 0);
  const donutGradient = useMemo(() => {
    if (!categoryTotal) return "";
    let acc = 0;
    const stops = categories.map((c) => {
      const from = (acc / categoryTotal) * 360;
      acc += c.total;
      const to = (acc / categoryTotal) * 360;
      return `${CATEGORY_COLORS[c.category] ?? CATEGORY_COLORS.other} ${from}deg ${to}deg`;
    });
    return `conic-gradient(${stops.join(", ")})`;
  }, [categories, categoryTotal]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/55 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 duration-100 motion-reduce:!animate-none" />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-2 z-50 flex flex-col overflow-hidden rounded-2xl p-3 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-2 motion-reduce:!animate-none",
            floatingSurface(3)
          )}
        >
          <header className="flex items-center gap-1 border-b border-border/70 pb-2">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-title font-semibold">
              消费分析
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              基于订阅记账数据的消费统计：指标、趋势与类别构成。
            </DialogPrimitive.Description>
            <DialogPrimitive.Close asChild>
              <IconButton label="关闭消费分析" size="sm">
                <X />
              </IconButton>
            </DialogPrimitive.Close>
          </header>

          <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-0.5 pb-0.5">
            <div className="flex flex-col gap-2">
              {/* 指标卡 2×2 */}
              <div className="grid grid-cols-2 gap-1.5">
                <StatCard
                  label="本月消费"
                  value={stats.monthText}
                  sub={
                    stats.momPct !== null
                      ? `${stats.momPct >= 0 ? "↑" : "↓"} 较上月 ${Math.abs(stats.momPct).toFixed(0)}%`
                      : stats.multiCurrency && stats.converted
                        ? stats.monthParts
                        : stats.multiCurrency
                          ? "汇率未就绪，按币种分列"
                          : "上月无记账"
                  }
                  subTone={
                    stats.momPct === null ? "muted" : stats.momPct > 0 ? "up" : "down"
                  }
                />
                <StatCard
                  label="月固定支出"
                  value={stats.fixedText}
                  sub={
                    stats.multiCurrency && stats.converted
                      ? stats.fixedParts
                      : "活跃订阅按周期折算"
                  }
                />
                <StatCard
                  label="年度累计"
                  value={stats.yearText}
                  sub={
                    stats.multiCurrency && stats.converted
                      ? stats.yearParts
                      : `${new Date(now).getFullYear()} 年已记账`
                  }
                />
                <StatCard
                  label="活跃账单"
                  value={String(stats.active)}
                  sub={`共 ${bills.length} 笔`}
                />
              </div>

              {/* 消费趋势：月（近12月）/ 年（近4年）；数据源=真实记账 */}
              <section className="surface-inset rounded-xl p-2">
                <div className="mb-1 flex items-center justify-between pl-1">
                  <p className="text-label font-semibold">
                    消费趋势
                    {stats.multiCurrency && (
                      <span className="ml-1 font-normal text-micro text-muted-foreground">
                        {stats.converted ? `已折算 ${currency}` : "多币种混计"}
                      </span>
                    )}
                  </p>
                  <Segmented
                    size="xs"
                    ariaLabel="趋势范围"
                    value={range}
                    options={[
                      { value: "month", label: "月度" },
                      { value: "year", label: "年度" },
                    ]}
                    onChange={setRange}
                  />
                </div>
                {trendMax <= 0 ? (
                  <p className="py-6 text-center text-label text-muted-foreground">
                    还没有记账数据；订阅到期滚动或信用卡标记已还后自动积累
                  </p>
                ) : (
                  <div className="flex items-end gap-1 px-1">
                    {trend.map((t, i) => {
                      const current = i === trend.length - 1;
                      // 12 根柱标签挤：从当前月往回隔月显示完整标签，不截断
                      const showLabel =
                        range === "year" || (trend.length - 1 - i) % 2 === 0;
                      return (
                        <div
                          key={t.key}
                          className="group/bar flex min-w-0 flex-1 flex-col items-center gap-0.5"
                          title={`${t.label} ${currency}${formatBillAmount(t.total)}`}
                        >
                          {/* 悬停亮出金额（12 根柱窄，金额允许溢出列宽不截断） */}
                          <span className="h-3 whitespace-nowrap text-micro tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/bar:opacity-100">
                            {t.total > 0 ? `${currency}${formatBillAmount(t.total)}` : ""}
                          </span>
                          {/* 柱容器定高：百分比柱高必须挂在确定高度上 */}
                          <div className="flex h-20 w-full items-end">
                            <div
                              className={cn(
                                "w-full rounded-sm",
                                current
                                  ? "bg-muted-foreground/70"
                                  : "bg-muted-foreground/30"
                              )}
                              style={{
                                height: `${Math.max((t.total / trendMax) * 100, t.total > 0 ? 5 : 2)}%`,
                              }}
                            />
                          </div>
                          <span
                            className={cn(
                              "w-full whitespace-nowrap text-center text-micro tabular-nums",
                              current ? "text-foreground" : "text-muted-foreground"
                            )}
                          >
                            {showLabel ? t.label : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* 类别构成：活跃订阅月折算（环形 conic-gradient + 图例） */}
              <section className="surface-inset rounded-xl p-2">
                <p className="mb-1.5 pl-1 text-label font-semibold">
                  按类别{" "}
                  <span className="font-normal text-muted-foreground">
                    · 月固定支出构成
                    {stats.multiCurrency &&
                      (stats.converted ? `（已折算 ${currency}）` : "（多币种混计）")}
                  </span>
                </p>
                {categoryTotal <= 0 ? (
                  <p className="py-6 text-center text-label text-muted-foreground">
                    还没有活跃订阅
                  </p>
                ) : (
                  <div className="flex items-center gap-3 px-1 pb-1">
                    <div
                      className="relative size-24 shrink-0 rounded-full"
                      style={{ background: donutGradient }}
                      role="img"
                      aria-label="类别构成环形图"
                    >
                      {/* 中孔：挖洞成环 + 中心合计 */}
                      <div className="absolute inset-3 flex flex-col items-center justify-center rounded-full bg-popover">
                        <span className="text-label font-semibold tabular-nums">
                          {currency}
                          {formatBillAmount(Math.round(categoryTotal))}
                        </span>
                        <span className="text-micro text-muted-foreground">/月</span>
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {categories.map((c) => (
                        <div key={c.category} className="flex items-center gap-1.5">
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{
                              backgroundColor:
                                CATEGORY_COLORS[c.category] ?? CATEGORY_COLORS.other,
                            }}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1 truncate text-label">
                            {categoryLabel(c.category)}
                          </span>
                          <span className="text-label tabular-nums text-muted-foreground">
                            {currency}
                            {formatBillAmount(Math.round(c.total))}
                            <span className="ml-1 text-micro">
                              {Math.round((c.total / categoryTotal) * 100)}%
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
              {stats.converted && stats.multiCurrency && fx && (
                <p className="px-1 text-micro text-muted-foreground">
                  汇率更新于{" "}
                  {new Date(fx.fetchedAt).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  · open.er-api.com · 每日缓存，折算仅供参考
                </p>
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function StatCard({
  label,
  value,
  sub,
  subTone = "muted",
}: {
  label: string;
  value: string;
  sub?: string;
  subTone?: "muted" | "up" | "down";
}) {
  return (
    <div className="surface-inset rounded-xl px-2.5 py-2">
      <p className="text-micro text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-title font-semibold tabular-nums" title={value}>
        {value}
      </p>
      {sub && (
        <p
          className={cn(
            "mt-0.5 truncate text-micro",
            subTone === "muted" && "text-muted-foreground",
            subTone === "up" && "text-destructive",
            subTone === "down" && "text-success"
          )}
        >
          {sub}
        </p>
      )}
    </div>
  );
}
