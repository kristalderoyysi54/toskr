import { Fragment, useMemo, useState } from "react";
import { CalendarCheck } from "lucide-react";

import { BillRow } from "@/components/subscriptions/BillList";
import { OverdueRescheduleMenu } from "@/components/TaskPage";
import { TaskRow } from "@/components/TaskRow";
import { EmptyState } from "@/components/ui/empty-state";
import { PillInput } from "@/components/ui/pill-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { billOccurrencesInRange, startOfBillDay } from "@/lib/bills";
import { todayAgenda, todayDefaultDue } from "@/lib/tasks";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");
const hm = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * 「提醒 → 今天」：今天要做的事按时刻排成一条轴（红线标当前时刻），
 * 往日积压单列在上方并可一键顺延，今天的扣款列在轴后。
 * 只读视图：数据源仍是任务与账单，行内操作与任务子视图完全一致。
 */
export function TodayPage({ now }: { now: number }) {
  const tasks = useNotesStore((s) => s.tasks);
  const bills = useNotesStore((s) => s.bills);
  const billsEnabled = useNotesStore((s) => s.settings.subscriptionsEnabled);
  const agenda = useMemo(() => todayAgenda(tasks, now), [tasks, now]);
  const today = startOfBillDay(now);
  const todayBills = useMemo(
    () =>
      billsEnabled
        ? bills.filter((b) => billOccurrencesInRange(b, today, today + DAY_MS).length > 0)
        : [],
    [bills, billsEnabled, today]
  );
  const pending = agenda.timeline.filter((t) => t.status !== "done").length;
  // 红线插在第一个「到期时刻晚于现在」的条目前；全部已过则落在最后
  const nowIndex = agenda.timeline.findIndex((t) => t.dueAt! > now);
  const empty = !agenda.earlier.length && !agenda.timeline.length && !todayBills.length;

  return (
    <>
      <TodayQuickAdd />
      <ScrollArea className="min-h-0 flex-1 px-2.5" viewportClassName="px-1">
        <div className="flex flex-col gap-3 pb-2 pt-1">
          <div className={cn("grid gap-1.5", billsEnabled ? "grid-cols-4" : "grid-cols-3")}>
            <Stat value={pending} label="待办" />
            <Stat value={agenda.doneToday} label="已完成" />
            <Stat value={agenda.overdue} label="已逾期" tone={agenda.overdue ? "red" : undefined} />
            {billsEnabled && <Stat value={todayBills.length} label="扣款" />}
          </div>

          {empty ? (
            <EmptyState
              icon={<CalendarCheck />}
              title="今天没有安排"
              hint="在上方记下今天要做的事，或在任务的到期弹层里把它排到今天。"
            />
          ) : (
            <>
              {agenda.earlier.length > 0 && (
                <section className="flex flex-col gap-1">
                  <div className="flex items-center gap-1 pl-0.5 pr-1">
                    <h3 className="flex-1 text-label font-semibold uppercase tracking-[0.08em] text-destructive">
                      往日未完成
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

              {agenda.timeline.length > 0 && (
                // token-exception: 时间列定宽 2.75rem 容下「23:59」，与 NowLine 的 w-11 对齐
                <section aria-label="今天时间轴" className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-1.5 gap-y-1">
                  {agenda.timeline.map((t, i) => (
                    <Fragment key={t.id}>
                      {i === nowIndex && <NowLine now={now} />}
                      <span
                        className={cn(
                          "pt-2 text-right text-micro tabular-nums",
                          t.status !== "done" && t.dueAt! <= now
                            ? "text-destructive"
                            : "text-muted-foreground"
                        )}
                      >
                        {hm(t.dueAt!)}
                      </span>
                      <TaskRow task={t} now={now} />
                    </Fragment>
                  ))}
                  {nowIndex === -1 && <NowLine now={now} />}
                </section>
              )}

              {todayBills.length > 0 && (
                <section className="flex flex-col gap-0.5">
                  <h3 className="pl-0.5 text-label font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    今天扣款
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
  return (
    <div aria-label={`现在 ${hm(now)}`} className="col-span-2 flex items-center gap-1.5">
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
  const [value, setValue] = useState("");
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    const store = useNotesStore.getState();
    const { result, id } = store.addTask(text);
    if (result !== "added" || !id) return;
    const dueAt = todayDefaultDue(Date.now());
    store.setTaskDue(id, dueAt);
    tip("added", `已加到今天 ${hm(dueAt)}`);
    setValue("");
  };
  return (
    <div className="mx-3 mb-1.5">
      <PillInput
        value={value}
        onChange={setValue}
        onSubmit={submit}
        placeholder={`添加今天的任务，回车保存（${hm(todayDefaultDue(Date.now()))} 到期）…`}
      />
    </div>
  );
}
