import { ask } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Link2,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import {
  clearDeliveryEvents,
  DELIVERY_ACTIVITY_MAX_EVENTS,
  deliveryActivityRecords,
  deliveryEventSourceAvailability,
  getRecentDeliveryEvents,
  reprepareDeliveryEvent,
  type DeliveryEvent,
} from "@/lib/deliveryActivity";
import {
  RESULT_LINK_CHANGED_EVENT,
  requestResultLinkForDelivery,
  resultAssociationState,
} from "@/lib/resultReturn";
import { requestResultVerification } from "@/lib/resultVerification";
import {
  upsertQualityFeedback,
  type OutcomeQuality,
  type OutcomeQualityFeedback,
} from "@/lib/outcomeIntelligence";
import { openNoteDetail } from "@/lib/actions";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { useNotesStore, type Note, type Task } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

const STATUS_LABEL: Record<DeliveryEvent["status"], string> = {
  prepared: "草稿已准备",
  opened: "等待预检",
  started: "正在投递",
  sent: "发送成功",
  blocked: "发送已阻止",
  failed: "发送失败",
  restored: "剪贴板已恢复",
  skipped: "剪贴板未覆盖",
  captured: "已收到结果",
  verified: "结果已核验",
};

const CLIPBOARD_LABEL: Record<NonNullable<DeliveryEvent["clipboardOutcome"]>, string> = {
  restored: "已恢复",
  restoredPartial: "部分恢复",
  skippedUserChanged: "保留新复制内容",
  nothingToRestore: "无需恢复",
  restoreFailed: "恢复失败",
  notOwned: "所有权已变化",
};

const RECOVERY_ERROR = {
  unsupported: "这条记录不支持重新准备",
  sourceMissing: "来源已不存在，无法重新准备",
  busy: "请先完成当前发送或预检",
  dataChanged: "数据目录已变化，请重新打开最近投递",
  targetUnavailable: "当前没有可用投递目标",
} as const;

const QUALITY_LABEL: Record<OutcomeQuality, string> = {
  directUse: "直接使用",
  minorEdit: "小改",
  majorEdit: "大改",
  discarded: "未采用",
};

export function RecentDeliveryList({
  records,
  notes,
  tasks,
  busyEventId,
  onReprepare,
  onOpenSource,
  onOpenResult,
  onVerify,
  onAssociate,
  qualityFeedback = [],
  qualityMetricsEpoch,
  onQuality,
}: {
  records: readonly DeliveryEvent[];
  notes: readonly Note[];
  tasks: readonly Task[];
  busyEventId: string | null;
  onReprepare: (event: DeliveryEvent) => void;
  onOpenSource?: (event: DeliveryEvent) => void;
  onOpenResult?: (note: Note) => void;
  onVerify?: (note: Note) => void;
  onAssociate?: (event: DeliveryEvent) => void;
  qualityFeedback?: readonly OutcomeQualityFeedback[];
  qualityMetricsEpoch?: number;
  onQuality?: (
    event: DeliveryEvent,
    resultNoteId: string,
    quality: OutcomeQuality
  ) => void;
}) {
  const qualityByResult = new Map(
    qualityFeedback.map((item) => [
      `${item.deliveryId}:${item.resultNoteId}`,
      item.quality,
    ] as const)
  );
  if (!records.length) {
    return (
      <div className="flex min-h-36 flex-col items-center justify-center text-center text-body text-muted-foreground">
        <Clock3 className="mb-2 size-5 opacity-50" aria-hidden />
        暂无投递记录
      </div>
    );
  }
  return (
    <ol className="space-y-2" aria-label="最近投递记录">
      {records.map((record) => {
        const availability = deliveryEventSourceAvailability(record, notes, tasks);
        const recoverable = record.status === "failed" || record.status === "blocked";
        const statusProblem = recoverable;
        // 报告/问题 Note 也保留 delivery provenance；抽屉的“结果”必须只认
        // 活动事件明确记录的 resultNoteId，不能把派生笔记误当成原结果。
        const linkedResults = record.resultNoteId
          ? notes.filter((note) =>
              note.id === record.resultNoteId &&
              note.provenance?.deliveryId === record.deliveryId
            )
          : [];
        const association = resultAssociationState(record, notes);
        const selectedQuality = linkedResults[0]
          ? qualityByResult.get(`${record.deliveryId}:${linkedResults[0].id}`) ?? null
          : null;
        const qualityEligible = qualityMetricsEpoch !== undefined &&
          record.metricsEligible !== false &&
          (record.metricsEpoch ?? 0) === qualityMetricsEpoch;
        return (
          <li
            key={record.deliveryId}
            className="rounded-xl border border-foreground/10 bg-muted/35 p-2.5"
          >
            <div className="flex min-w-0 items-start gap-2">
              {statusProblem ? (
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              ) : (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-body font-medium" title={record.targetAppName ?? undefined}>
                    {record.targetAppName || record.targetBundleId || "未识别目标"}
                  </span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-micro font-medium",
                      statusProblem
                        ? "bg-warning/10 text-warning"
                        : "bg-success/10 text-success"
                    )}
                  >
                    {STATUS_LABEL[record.status]}
                  </span>
                </div>
                <time
                  dateTime={new Date(record.timestampMs).toISOString()}
                  className="mt-0.5 block text-micro tabular-nums text-muted-foreground"
                >
                  {new Date(record.timestampMs).toLocaleString("zh-CN", { hour12: false })}
                </time>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1 text-micro text-muted-foreground">
              <span className="rounded-sm bg-muted px-1.5 py-0.5">
                {availability === "available"
                  ? `来源存在 · ${record.sourceItemIds.length} 项`
                  : availability === "partial"
                    ? "部分来源已不存在"
                    : "来源已不存在"}
              </span>
              <span className="rounded-sm bg-muted px-1.5 py-0.5">
                已脱敏 {record.redactionCount} 项
              </span>
              {record.clipboardOutcome && (
                <span className="rounded-sm bg-muted px-1.5 py-0.5">
                  剪贴板：{CLIPBOARD_LABEL[record.clipboardOutcome]}
                </span>
              )}
              <span className="rounded-sm bg-muted px-1.5 py-0.5">
                {record.textCharCount} 字符{record.imageCount ? ` · ${record.imageCount} 图` : ""}
              </span>
              {record.verificationStatus && (
                <span className={cn(
                  "rounded-sm px-1.5 py-0.5",
                  record.verificationStatus === "pass"
                    ? "bg-success/10 text-success"
                    : record.verificationStatus === "blocked"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-warning/10 text-warning"
                )}>
                  核验 {record.verificationCheckCount ?? 0} 项 · 问题 {record.verificationIssueCount ?? 0}
                </span>
              )}
            </div>
            {!linkedResults.length && association === "missing" && (
              <p className="mt-1.5 text-micro text-warning">已关联的结果卡已不存在</p>
            )}
            {!linkedResults.length && association === "unlinked" && (
              <p className="mt-1.5 text-micro text-muted-foreground">原结果关联已解除或改绑</p>
            )}
            <div className="mt-2 flex flex-wrap items-center justify-end gap-1">
              {availability !== "missing" && onOpenSource && (
                <Button type="button" size="xs" variant="ghost" onClick={() => onOpenSource(record)}>
                  <ExternalLink className="size-3" /> 打开来源
                </Button>
              )}
              {!!linkedResults.length && onOpenResult && (
                <Button type="button" size="xs" variant="ghost" onClick={() => onOpenResult(linkedResults[0])}>
                  <ExternalLink className="size-3" />
                  打开结果{linkedResults.length > 1 ? ` ×${linkedResults.length}` : ""}
                </Button>
              )}
              {!!linkedResults.length && onVerify && (
                <Button type="button" size="xs" variant="secondary" onClick={() => onVerify(linkedResults[0])}>
                  <ShieldCheck className="size-3" /> 核验结果
                </Button>
              )}
              {record.status === "sent" && onAssociate && (
                <Button type="button" size="xs" variant="secondary" onClick={() => onAssociate(record)}>
                  <Link2 className="size-3" /> 关联现有卡片
                </Button>
              )}
            </div>
            {!!linkedResults.length && onQuality && qualityEligible && (
              <fieldset className="mt-2 border-t border-border/50 pt-2">
                <legend className="sr-only">结果使用质量</legend>
                <div className="flex flex-wrap items-center gap-1" aria-label="结果使用质量">
                  <span className="mr-auto text-micro text-muted-foreground">结果质量（可选）</span>
                  {(Object.keys(QUALITY_LABEL) as OutcomeQuality[]).map((quality) => (
                    <button
                      key={quality}
                      type="button"
                      aria-pressed={selectedQuality === quality}
                      onClick={() => onQuality(record, linkedResults[0].id, quality)}
                      className={cn(
                        "rounded-md px-1.5 py-1 text-micro outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                        selectedQuality === quality
                          ? "bg-primary/15 font-medium text-primary"
                          : "bg-muted text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {QUALITY_LABEL[quality]}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            {recoverable && (
              <div className="mt-2 flex items-center justify-end">
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  disabled={availability !== "available" || busyEventId !== null}
                  onClick={() => onReprepare(record)}
                >
                  <RotateCcw className={cn("size-3", busyEventId === record.eventId && "animate-spin motion-reduce:animate-none")} />
                  重新准备
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function RecentDeliveryDrawer({
  open,
  onOpenChange,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement>;
}) {
  const notes = useNotesStore((state) => state.notes);
  const tasks = useNotesStore((state) => state.tasks);
  const qualityFeedback = useNotesStore(
    (state) => state.settings.outcomeQualityFeedback
  );
  const metricsEnabled = useNotesStore(
    (state) => state.settings.outcomeMetricsEnabled
  );
  const retentionDays = useNotesStore(
    (state) => state.settings.outcomeRetentionDays
  );
  const metricsEpoch = useNotesStore(
    (state) => state.settings.outcomeMetricsEpoch
  );
  const [events, setEvents] = useState<DeliveryEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const records = useMemo(() => deliveryActivityRecords(events), [events]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEvents(await getRecentDeliveryEvents(DELIVERY_ACTIVITY_MAX_EVENTS));
    } catch {
      setError("最近投递读取失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  useEffect(() => {
    const refresh = () => open && void load();
    window.addEventListener(RESULT_LINK_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(RESULT_LINK_CHANGED_EVENT, refresh);
  }, [load, open]);

  const clear = async () => {
    const confirmed = await ask("仅清除本数据目录中的投递元数据记录，不影响卡片、任务和附件。确认继续吗？", {
      title: "清除最近投递",
      kind: "warning",
    });
    if (!confirmed) return;
    try {
      await clearDeliveryEvents();
      setEvents([]);
      tip("ok", "最近投递已清除");
    } catch {
      setError("清除失败，数据目录可能正在切换");
    }
  };

  const reprepare = async (event: DeliveryEvent) => {
    setBusyEventId(event.eventId);
    setError(null);
    const result = await reprepareDeliveryEvent(event);
    setBusyEventId(null);
    if (result.ok) {
      onOpenChange(false);
      tip("info", "已按当前来源重新准备，请在预检中确认后发送");
      return;
    }
    setError(RECOVERY_ERROR[result.reason]);
  };

  const openSource = (event: DeliveryEvent) => {
    const state = useNotesStore.getState();
    const sourceNote = event.sourceKind === "task"
      ? undefined
      : state.notes.find((item) => event.sourceItemIds.includes(item.id));
    if (sourceNote) {
      onOpenChange(false);
      openNoteDetail(sourceNote.id);
      return;
    }
    const sourceTask = event.sourceKind === "task"
      ? state.tasks.find((item) => event.sourceItemIds.includes(item.id))
      : undefined;
    if (sourceTask) {
      onOpenChange(false);
      const ui = useUIStore.getState();
      ui.setPage("tasks");
      ui.setFocusedId(sourceTask.id);
      tip("info", "已定位原始任务");
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/55 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 duration-100 motion-reduce:!animate-none" />
        <DialogPrimitive.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
          className={cn(
            "fixed inset-y-2 right-2 z-50 flex w-[min(23rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl p-3 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-right-2 motion-reduce:!animate-none",
            floatingSurface(3)
          )}
        >
          <header className="flex items-start gap-2 border-b border-border/70 pb-2">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-title font-semibold">
                最近投递
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-micro leading-relaxed text-muted-foreground">
                仅保存目标、状态与计数等元数据；不保存正文或 Prompt。保留最近 {DELIVERY_ACTIVITY_MAX_EVENTS} 条或 {retentionDays} 天。
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton label="关闭最近投递" size="sm"><X /></IconButton>
            </DialogPrimitive.Close>
          </header>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-micro text-muted-foreground">
              <ShieldCheck className="size-3 text-success" aria-hidden /> 本机当前数据目录
            </span>
            <button
              type="button"
              onClick={() => void clear()}
              disabled={loading || busyEventId !== null || !events.length}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-micro text-muted-foreground outline-none hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-40"
            >
              <Trash2 className="size-3" aria-hidden /> 清除记录
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-body text-destructive">
              {error}
            </p>
          )}
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-0.5">
            {loading ? (
              <p role="status" className="py-8 text-center text-body text-muted-foreground">读取中…</p>
            ) : (
              <RecentDeliveryList
                records={records}
                notes={notes}
                tasks={tasks}
                busyEventId={busyEventId}
                onReprepare={(event) => void reprepare(event)}
                onOpenSource={openSource}
                onOpenResult={(note) => {
                  onOpenChange(false);
                  openNoteDetail(note.id);
                }}
                onVerify={(note) => {
                  onOpenChange(false);
                  window.setTimeout(() => {
                    requestResultVerification(note.id, returnFocusRef.current);
                  }, 0);
                }}
                onAssociate={(record) => {
                  const sent = events.find(
                    (event) => event.deliveryId === record.deliveryId &&
                      event.eventType === "sendSent"
                  );
                  requestResultLinkForDelivery(
                    sent ?? record,
                    document.activeElement instanceof HTMLElement
                      ? document.activeElement
                      : null
                  );
                }}
                qualityFeedback={qualityFeedback}
                qualityMetricsEpoch={metricsEnabled ? metricsEpoch : undefined}
                onQuality={metricsEnabled ? ((record, resultNoteId, quality) => {
                  const state = useNotesStore.getState();
                  state.setSettings({
                    outcomeQualityFeedback: upsertQualityFeedback(
                      state.settings.outcomeQualityFeedback,
                      {
                        deliveryId: record.deliveryId,
                        resultNoteId,
                        quality,
                        updatedAtMs: Date.now(),
                      }
                    ),
                  });
                  tip("ok", "结果质量已记录（仅保存在本机）");
                }) : undefined}
              />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
