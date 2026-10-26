import { Fragment, useMemo, useState } from "react";
import { CalendarCheck } from "lucide-react";

import { CalendarEventRow } from "@/components/CalendarEventRow";
import { BillRow } from "@/components/subscriptions/BillList";
import { OverdueRescheduleMenu } from "@/components/TaskPage";
import { TaskRow } from "@/components/TaskRow";
import { EmptyState } from "@/components/ui/empty-state";
import { PillInput } from "@/components/ui/pill-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { nextDayStart, sortEvents, useAppleCalendarEvents } from "@/lib/appleCalendar";
import { billOccurrencesInRange, startOfBillDay } from "@/lib/bills";
import { todayAgenda, todayDefaultDue } from "@/lib/tasks";
import { useT } from "@/lib/i18n";
import { clockLabel } from "@/lib/taskRecurrence";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

const DAY_MS = 86_400_000;
/** 统计格列数（Tailwind 需要完整类名才能生成）。 */
const STAT_COLS: Record<number, string> = { 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" };
const pad2 = (n: number) => String(n).padStart(2, "0");
const hm = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * 「提醒 → 今天」：今天要做的事按时刻排成一条轴（红线标当前时刻），
 * 往日积压单列在上方并可一键顺延，今天的扣款列在轴后。
 * 只读视图：数据源仍是任务与账单，行内操作与任务子视图完全一致。
 * 开启苹果日历叠加时，日程以灰色块按开始时刻插进同一条轴（全天日程排在轴首）。
 */
export function TodayPage({ now }: { now: number }) {
  const t = useT();
  const tasks = useNotesStore((s) => s.tasks);
  const bills = useNotesStore((s) => s.bills);
  const billsEnabled = useNotesStore((s) => s.settings.subscriptionsEnabled);
  const calendarEnabled = useNotesStore((s) => s.settings.appleCalendarEnabled);
  const agenda = useMemo(() => todayAgenda(tasks, now), [tasks, now]);
  const today = startOfBillDay(now);
  const todayBills = useMemo(
    () =>
      billsEnabled
        ? bills.filter((b) => billOccurrencesInRange(b, today, today + DAY_MS).length > 0)
        : [],
    [bills, billsEnabled, today]
  );
  const events = useAppleCalendarEvents(today, nextDayStart(today));
  const allDayEvents = useMemo(() => sortEvents(events.filter((e) => e.allDay)), [events]);
  // 任务按到期、日程按开始时刻（昨天开始的按今天 0 点）排进同一条轴；同刻日程在前
  const timeline = useMemo(
    () =>
      [
        ...events
          .filter((e) => !e.allDay)
          .map((event) => ({ kind: "event" as const, at: Math.max(event.startMs, today), event })),
        ...agenda.timeline.map((task) => ({ kind: "task" as const, at: task.dueAt!, task })),
      ].sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "event" ? -1 : 1)),
    [events, agenda.timeline, today]
  );
  const pending = agenda.timeline.filter((t) => t.status !== "done").length;
  // 红线插在第一个「时刻晚于现在」的条目前；全部已过则落在最后
  const nowIndex = timeline.findIndex((entry) => entry.at > now);
  const empty =
    !agenda.earlier.length && !timeline.length && !allDayEvents.length && !todayBills.length;

  return (
    <>
      <TodayQuickAdd />
      <ScrollArea className="min-h-0 flex-1 px-2.5" viewportClassName="px-1">
        <div className="flex flex-col gap-3 pb-2 pt-1">
          <div
            className={cn(
              "grid gap-1.5",
              STAT_COLS[3 + Number(billsEnabled) + Number(calendarEnabled)]
            )}
          >
            <Stat value={pending} label={t("待办")} />
            <Stat value={agenda.doneToday} label={t("已完成")} />
            <Stat value={agenda.overdue} label={t("已逾期")} tone={agenda.overdue ? "red" : undefined} />
            {billsEnabled && <Stat value={todayBills.length} label={t("扣款")} />}
            {calendarEnabled && <Stat value={events.length} label={t("日程")} />}
          </div>

          {empty ? (
            <EmptyState
              icon={<CalendarCheck />}
              title={t("今天没有安排")}
              hint={t("在上方记下今天要做的事，或在任务的到期弹层里把它排到今天。")}
            />
          ) : (
            <>
              {agenda.earlier.length > 0 && (
                <section className="flex flex-col gap-1">
                  <div className="flex items-center gap-1 pl-0.5 pr-1">
                    <h3 className="flex-1 text-label font-semibold uppercase tracking-[0.08em] text-destructive">
                      {t("往日未完成")}
                      <span className="ml-1 rounded-sm bg-destructive/10 px-1 py-px text-micro tabular-nums">
                        {agenda.earlier.length}
                      </span>
                    </h3>
                    <OverdueRescheduleMenu tasks={agenda.earlier} />
                  </div>
                  {agenda.earlier.map((t) => (
                    <TaskRow key={t.id} task={t} now={now} />
                  ))}
                </section>
              )}

              {(timeline.length > 0 || allDayEvents.length > 0) && (
                // token-exception: 时间列定宽 2.75rem 容下「23:59」，与 NowLine 的 w-11 对齐
                <section aria-label={t("今天时间轴")} className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-1.5 gap-y-1">
                  {allDayEvents.map((event) => (
                    <Fragment key={event.id}>
                      <span className="pt-2 text-right text-micro text-muted-foreground">{t("全天")}</span>
                      <CalendarEventRow event={event} />
                    </Fragment>
                  ))}
                  {timeline.map((entry, i) => (
                    <Fragment key={entry.kind === "task" ? entry.task.id : entry.event.id}>
                      {i === nowIndex && <NowLine now={now} />}
                      <span
                        className={cn(
                          "pt-2 text-right text-micro tabular-nums",
                          entry.kind === "task" && entry.task.status !== "done" && entry.at <= now
                            ? "text-destructive"
                            : "text-muted-foreground"
                        )}
                      >
                        {hm(entry.at)}
                      </span>
                      {entry.kind === "task" ? (
                        <TaskRow task={entry.task} now={now} />
                      ) : (
                        <CalendarEventRow event={entry.event} />
                      )}
                    </Fragment>
                  ))}
                  {timeline.length > 0 && nowIndex === -1 && <NowLine now={now} />}
                </section>
              )}

              {todayBills.length > 0 && (
                <section className="flex flex-col gap-0.5">
                  <h3 className="pl-0.5 text-label font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {t("今天扣款")}
                  </h3>
                  {todayBills.map((bill) => (
                    <BillRow
                      key={bill.id}
                      bill={bill}
                      now={now}
                      onEdit={() => useUIStore.getState().setRemindersSubview("subscriptions")}
                    />
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: "red" }) {
  return (
    <div className="surface-inset flex flex-col rounded-lg px-2 py-1">
      <span
        className={cn(
          "text-title font-semibold tabular-nums",
          tone === "red" && "text-destructive"
        )}
      >
        {value}
      </span>
      <span className="text-micro text-muted-foreground">{label}</span>
    </div>
  );
}

/** 当前时刻红线（横跨时间列与内容列）。
 *  token-exception: 7px 圆点 / -3px 偏移为红线端点几何，非间距 token。 */
function NowLine({ now }: { now: number }) {
  const t = useT();
  return (
    <div aria-label={t("现在 {time}", { time: hm(now) })} className="col-span-2 flex items-center gap-1.5">
      <span className="w-11 text-right text-micro font-semibold tabular-nums text-destructive">
        {hm(now)}
      </span>
      <span className="relative h-px flex-1 bg-destructive">
        <span className="absolute -left-0.5 -top-[3px] size-[7px] rounded-full bg-destructive" />
      </span>
    </div>
  );
}

/** 今天速记：回车即建一条今天到期的任务（默认 20:00，已过则下一个整点）。 */
function TodayQuickAdd() {
  const t = useT();
  const [value, setValue] = useState("");
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    const store = useNotesStore.getState();
    const { result, id } = store.addTask(text);
    if (result !== "added" || !id) return;
    const dueAt = todayDefaultDue(Date.now());
    store.setTaskDue(id, dueAt);
    const d = new Date(dueAt);
    tip("added", t("已加到今天 {time}", { time: clockLabel(d.getHours(), d.getMinutes()) }));
    setValue("");
  };
  return (
    <div className="mx-3 mb-1.5">
      <PillInput
        value={value}
        onChange={setValue}
        onSubmit={submit}
        placeholder={(() => {
          const due = new Date(todayDefaultDue(Date.now()));
          return t("添加今天的任务，回车保存（{time} 到期）…", { time: clockLabel(due.getHours(), due.getMinutes()) });
        })()}
      />
    </div>
  );
}
