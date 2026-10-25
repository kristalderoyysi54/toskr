import { useEffect, useMemo, useState } from "react";
import { ChartColumn, CreditCard, Plus } from "lucide-react";

import { AddBillFlow } from "@/components/subscriptions/AddBillFlow";
import { BillAnalytics } from "@/components/subscriptions/BillAnalytics";
import { BillList, BillRow } from "@/components/subscriptions/BillList";
import { BillMonthGrid } from "@/components/subscriptions/BillMonthGrid";
import { BillTrendChart } from "@/components/subscriptions/BillTrendChart";
import { BillWeekStrip } from "@/components/subscriptions/BillWeekStrip";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Segmented } from "@/components/ui/segmented";
import {
  billOccurrencesInRange,
  billsDueWithinDays,
  distinctCurrencies,
  formatBillAmount,
  formatCurrencyTotals,
  monthlySpendTotal,
  monthlySpendTotalsByCurrency,
  startOfBillDay,
} from "@/lib/bills";
import { cachedFx, ensureFx, makeConverter, type FxCache } from "@/lib/currency";
import { t as translate, useT } from "@/lib/i18n";
import { monthDayLabel } from "@/lib/taskRecurrence";
import { useNotesStore, type Bill } from "@/store/notesStore";

const DAY_MS = 86_400_000;
const CAL_VIEW_KEY = "toskr-bill-cal-view";

/**
 * 「提醒 → 订阅」子视图：摘要条 + 周/月视图 + 当日账单 + 列表 + 迷你趋势。
 * 单屏克制：周条为默认视图，月历/趋势都是轻量块，不引入二级页面。
 */
export function SubscriptionsPage({ bills, now }: { bills: Bill[]; now: number }) {
  const t = useT();
  const currency = useNotesStore((s) => s.settings.currencySymbol);
  // 周/月视图记忆（用户指定 2026-08-16）：轻量 UI 偏好走 localStorage，不进数据文件
  const [view, setViewState] = useState<"week" | "month">(() =>
    localStorage.getItem(CAL_VIEW_KEY) === "month" ? "month" : "week"
  );
  const setView = (v: "week" | "month") => {
    setViewState(v);
    localStorage.setItem(CAL_VIEW_KEY, v);
  };
  const [filter, setFilter] = useState<"upcoming" | "all">("upcoming");
  const [selectedDay, setSelectedDay] = useState(() => startOfBillDay(now));
  const [flow, setFlow] = useState<{ open: boolean; edit?: Bill }>({ open: false });
  const [analyticsOpen, setAnalyticsOpen] = useState(false);

  const upcoming = useMemo(() => billsDueWithinDays(bills, now, 7), [bills, now]);
  // 有当日汇率则折算主货币统一显示（多币种加 ≈，tooltip 给分列）；无汇率回退分列
  const [fx, setFx] = useState<FxCache | null>(() => cachedFx());
  useEffect(() => {
    void ensureFx().then((next) => {
      if (next) setFx(next);
    });
  }, []);
  const monthTotal = useMemo(() => {
    const parts = formatCurrencyTotals(
      monthlySpendTotalsByCurrency(bills, now, currency),
      currency
    );
    const convert = makeConverter(currency, fx);
    const multi = distinctCurrencies(bills, currency).length > 1;
    if (!convert || !multi) return { text: parts, title: parts };
    const combined = monthlySpendTotal(bills, now, convert);
    return {
      text: `≈ ${currency}${formatBillAmount(Math.round(combined * 100) / 100)}`,
      title: parts,
    };
  }, [bills, now, currency, fx]);
  const dayBills = useMemo(
    () =>
      bills.filter(
        (b) => billOccurrencesInRange(b, selectedDay, selectedDay + DAY_MS).length > 0
      ),
    [bills, selectedDay]
  );
  const openEdit = (bill: Bill) => setFlow({ open: true, edit: bill });

  if (!bills.length) {
    return (
      <>
        <EmptyState
          icon={<CreditCard />}
          title={t("还没有订阅账单")}
          hint={
            <>
              {t("记下订阅服务与信用卡还款日，")}
              <br />
              {t("到期前自动弹提醒，不再错过续费与还款。")}
            </>
          }
        />
        <div className="flex justify-center pb-4">
          <Button size="sm" onClick={() => setFlow({ open: true })}>
            <Plus /> {t("添加订阅")}
          </Button>
        </div>
        <AddBillFlow
          open={flow.open}
          edit={flow.edit}
          onOpenChange={(open) => setFlow((f) => ({ ...f, open }))}
        />
      </>
    );
  }

  return (
    <>
      {/* 摘要条：本月消费 + 未来 7 天到期数 + 添加入口 */}
      <div className="flex items-center gap-2 px-3.5 pb-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-title font-semibold tabular-nums" title={t("本月 {amount}", { amount: monthTotal.title })}>
            {t("本月 {amount}", { amount: monthTotal.text })}
          </p>
          <p className="text-micro text-muted-foreground">
            {upcoming.length
              ? t("未来 7 天有 {n} 笔到期", { n: upcoming.length })
              : t("未来 7 天没有到期账单")}
          </p>
        </div>
        <Segmented
          size="xs"
          ariaLabel={t("日历视图")}
          value={view}
          options={[
            { value: "week", label: t("周") },
            { value: "month", label: t("月") },
          ]}
          onChange={setView}
        />
        <IconButton label={t("消费分析")} size="sm" onClick={() => setAnalyticsOpen(true)}>
          <ChartColumn />
        </IconButton>
        <IconButton label={t("添加订阅")} size="sm" onClick={() => setFlow({ open: true })}>
          <Plus />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2.5" viewportClassName="px-1">
        <div className="flex flex-col gap-2 pb-2 pt-1">
          {view === "week" ? (
            <BillWeekStrip
              bills={bills}
              now={now}
              selectedDay={selectedDay}
              onSelectDay={setSelectedDay}
            />
          ) : (
            <BillMonthGrid
              bills={bills}
              now={now}
              selectedDay={selectedDay}
              onSelectDay={setSelectedDay}
            />
          )}
          {/* 选中日的账单（默认今天）；无则一行轻提示 */}
          <div>
            <p className="px-1 pb-0.5 text-micro text-muted-foreground">
              {dayLabel(selectedDay, now)}
            </p>
            {dayBills.length ? (
              <div className="flex flex-col gap-0.5">
                {dayBills.map((bill) => (
                  <BillRow key={bill.id} bill={bill} now={now} onEdit={openEdit} />
                ))}
              </div>
            ) : (
              <EmptyState variant="inline" title={t("当日没有到期账单")} />
            )}
          </div>
          <div>
            <div className="flex items-center justify-between px-1 pb-1">
              <Segmented
                size="xs"
                ariaLabel={t("账单列表筛选")}
                value={filter}
                options={[
                  { value: "upcoming", label: t("即将到期") },
                  { value: "all", label: t("全部") },
                ]}
                onChange={setFilter}
              />
            </div>
            <BillList bills={bills} now={now} filter={filter} onEdit={openEdit} />
          </div>
          {/* 迷你趋势即分析入口：点击展开完整消费分析 */}
          <button
            onClick={() => setAnalyticsOpen(true)}
            aria-label={t("打开消费分析")}
            className="rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BillTrendChart bills={bills} now={now} currency={currency} />
          </button>
        </div>
      </ScrollArea>
      <AddBillFlow
        open={flow.open}
        edit={flow.edit}
        onOpenChange={(open) => setFlow((f) => ({ open, edit: open ? f.edit : undefined }))}
      />
      <BillAnalytics
        bills={bills}
        now={now}
        open={analyticsOpen}
        onOpenChange={setAnalyticsOpen}
      />
    </>
  );
}

function dayLabel(day: number, now: number): string {
  const diff = Math.round((day - startOfBillDay(now)) / DAY_MS);
  const d = new Date(day);
  const date = monthDayLabel(d);
  if (diff === 0) return translate("今天 · {date}", { date });
  if (diff === 1) return translate("明天 · {date}", { date });
  return date;
}
