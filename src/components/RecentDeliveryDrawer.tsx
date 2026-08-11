import { ask } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileText,
  Link2,
  MessageSquareReply,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Unlink,
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
  deliverySourceItems,
  getRecentDeliveryEvents,
  reprepareDeliveryEvent,
  type DeliveryActivityRecord,
  type DeliveryEvent,
} from "@/lib/deliveryActivity";
import {
  RESULT_LINK_CHANGED_EVENT,
  requestResultLinkForDelivery,
  requestResultUnlink,
  resultAssociationState,
} from "@/lib/resultReturn";
import { requestResultVerification } from "@/lib/resultVerification";
import {
  upsertQualityFeedback,
  type OutcomeQuality,
  type OutcomeQualityFeedback,
} from "@/lib/outcomeIntelligence";
import { openNoteBatchDetail, openNoteDetail } from "@/lib/actions";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { useNotesStore, type Note, type Task } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

const STATUS_LABEL: Record<DeliveryEvent["status"], string> = {
  prepared: "准备中",
  opened: "等待确认",
  started: "发送中",
  sent: "已发送",
  blocked: "未发送",
  failed: "发送失败",
  restored: "剪贴板已恢复",
  skipped: "剪贴板未覆盖",
  captured: "回复已保存",
  verified: "回复已检查",
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
  dataChanged: "数据目录已变化，请重新打开最近发送",
  targetUnavailable: "当前没有可用发送目标",
} as const;

const QUALITY_LABEL: Record<OutcomeQuality, string> = {
  directUse: "直接使用",
  minorEdit: "小改",
  majorEdit: "大改",
  discarded: "未采用",
};

function localTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString("zh-CN", { hour12: false });
}

function payloadLabel(record: DeliveryEvent): string {
  const parts: string[] = [];
  if (record.textCharCount) parts.push(`${record.textCharCount} 字文字`);
  if (record.imageCount) parts.push(`${record.imageCount} 张图片`);
  return parts.length ? parts.join(" + ") : "无正文内容";
}

function sourceLabel(
  record: DeliveryEvent,
  availability: ReturnType<typeof deliveryEventSourceAvailability>
): string {
  if (availability === "missing") return "原内容已删除";
  if (availability === "partial") return "部分原内容已删除";
  const unit = record.sourceKind === "task" ? "个任务" : "张卡片";
  return `${record.sourceItemIds.length} ${unit}可查看`;
}

function verificationLabel(record: DeliveryEvent): string {
  if (record.verificationStatus === "pass") return "检查完成，未发现问题";
  if (record.verificationStatus === "blocked") return "暂时无法完成检查";
  if (record.verificationStatus === "needsReview") {
    return `检查发现 ${record.verificationIssueCount ?? 0} 个问题`;
  }
  return "可查看或检查";
}

type RelationshipProps = {
  record: DeliveryActivityRecord;
  availability: ReturnType<typeof deliveryEventSourceAvailability>;
  association: ReturnType<typeof resultAssociationState>;
  result: Note | null;
  onOpenSource?: (event: DeliveryEvent) => void;
  onOpenResult?: (note: Note) => void;
  onAssociate?: (event: DeliveryEvent) => void;
};

function DeliveryRelationship({
  record,
  availability,
  association,
  result,
  onOpenSource,
  onOpenResult,
  onAssociate,
}: RelationshipProps) {
  const sent = record.status === "sent";
  const sourceAvailable = availability !== "missing" && !!onOpenSource;
  const replyAvailable = !!result && !!onOpenResult;
  const canChooseReply = sent && !result && !!onAssociate;
  const replyTitle = result
    ? "回复已保存"
    : association === "missing"
      ? "回复卡已删除"
      : sent
        ? "尚未保存回复"
        : "发送未完成";
  const replyDetail = result
    ? verificationLabel(record)
    : association === "unlinked"
      ? "曾保存，现已更换"
      : association === "missing"
        ? "点击重新选择回复"
        : sent
          ? "点击选择真正的回复"
          : "发送成功后才能保存";

  return (
    <div
      aria-label="发送内容与回复的关系"
      className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-1 max-[330px]:grid-cols-1"
    >
      <button
        type="button"
        disabled={!sourceAvailable}
        onClick={() => onOpenSource?.(record)}
        className="min-w-0 rounded-lg border border-foreground/10 bg-background/55 p-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-default disabled:opacity-60"
      >
        <span className="mb-1 flex items-center gap-1 text-label font-medium">
          <span className="flex size-5 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <FileText className="size-3" aria-hidden />
          </span>
          发送内容
        </span>
        <span className="block truncate text-micro text-muted-foreground">
          {sourceLabel(record, availability)}
        </span>
      </button>

      <span className="flex w-4 items-center justify-center text-muted-foreground/60 max-[330px]:h-3 max-[330px]:w-full" aria-hidden>
        <ArrowRight className="size-3.5 max-[330px]:rotate-90" />
      </span>

      <button
        type="button"
        disabled={!replyAvailable && !canChooseReply}
        onClick={() => {
          if (result) onOpenResult?.(result);
          else onAssociate?.(record);
        }}
        className={cn(
          "min-w-0 rounded-lg border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-default",
          result
            ? "border-success/25 bg-success/5 hover:bg-success/10"
            : "border-dashed border-foreground/15 bg-muted/25 hover:bg-muted/55",
          !replyAvailable && !canChooseReply && "opacity-60"
        )}
      >
        <span className="mb-1 flex items-center gap-1 text-label font-medium">
          <span className={cn(
            "flex size-5 items-center justify-center rounded-md",
            result ? "bg-success/12 text-success" : "bg-muted text-muted-foreground"
          )}>
            {result
              ? <CheckCircle2 className="size-3" aria-hidden />
              : <MessageSquareReply className="size-3" aria-hidden />}
          </span>
          <span className="truncate max-[330px]:overflow-visible max-[330px]:whitespace-normal">{replyTitle}</span>
        </span>
        <span className="block truncate text-micro text-muted-foreground">{replyDetail}</span>
      </button>
    </div>
  );
}

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
  onUnlink,
  qualityFeedback = [],
  qualityMetricsEpoch,
  onQuality,
}: {
  records: readonly DeliveryActivityRecord[];
  notes: readonly Note[];
  tasks: readonly Task[];
  busyEventId: string | null;
  onReprepare: (event: DeliveryEvent) => void;
  onOpenSource?: (event: DeliveryEvent) => void;
  onOpenResult?: (note: Note) => void;
  onVerify?: (note: Note) => void;
  onAssociate?: (event: DeliveryEvent) => void;
  onUnlink?: (note: Note) => void;
  qualityFeedback?: readonly OutcomeQualityFeedback[];
  qualityMetricsEpoch?: number;
  onQuality?: (
    event: DeliveryEvent,
    resultNoteId: string,
    quality: OutcomeQuality
  ) => void;
}) {
  const qualityByResult = useMemo(
    () => new Map(
      qualityFeedback.map((item) => [
        `${item.deliveryId}:${item.resultNoteId}`,
        item.quality,
      ] as const)
    ),
    [qualityFeedback]
  );
  if (!records.length) {
    return (
      <div className="flex min-h-36 flex-col items-center justify-center text-center text-body text-muted-foreground">
        <Clock3 className="mb-2 size-5 opacity-50" aria-hidden />
        暂无发送记录
      </div>
    );
  }
  return (
    <ol className="space-y-2" aria-label="最近发送记录">
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
        const linkedResult = linkedResults[0] ?? null;
        const selectedQuality = linkedResult
          ? qualityByResult.get(`${record.deliveryId}:${linkedResult.id}`) ?? null
          : null;
        const qualityEligible = qualityMetricsEpoch !== undefined &&
          record.metricsEligible !== false &&
          (record.metricsEpoch ?? 0) === qualityMetricsEpoch;
        return (
          <li
            key={record.deliveryId}
            className="rounded-xl border border-foreground/10 bg-muted/30 p-2.5"
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
                      "ml-auto shrink-0 text-micro font-medium",
                      statusProblem
                        ? "text-warning"
                        : "text-success"
                    )}
                  >
                    {STATUS_LABEL[record.status]}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-micro text-muted-foreground">
                  <time dateTime={new Date(record.timestampMs).toISOString()} className="tabular-nums">
                    {record.status === "sent" ? "发送于 " : "记录于 "}{localTime(record.timestampMs)}
                  </time>
                  <span aria-hidden> · </span>{payloadLabel(record)}
                </p>
              </div>
            </div>

            <DeliveryRelationship
              record={record}
              availability={availability}
              association={association}
              result={linkedResult}
              onOpenSource={onOpenSource}
              onOpenResult={onOpenResult}
              onAssociate={onAssociate}
            />

            <details className="group mt-2 border-t border-border/50 pt-1.5">
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-1 py-1 text-micro text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 [&::-webkit-details-marker]:hidden">
                更多信息
                <ChevronDown className="ml-auto size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
              </summary>
              <div className="px-1 pb-1 pt-1.5">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-micro">
                  <dt className="text-muted-foreground">原内容</dt>
                  <dd className="truncate text-right">{sourceLabel(record, availability)}</dd>
                  <dt className="text-muted-foreground">隐私保护</dt>
                  <dd className="text-right">
                    {record.redactionCount
                      ? `发送前隐藏了 ${record.redactionCount} 项敏感内容`
                      : "发送前未替换敏感内容"}
                  </dd>
                  {record.clipboardOutcome && (
                    <>
                      <dt className="text-muted-foreground">剪贴板</dt>
                      <dd className="text-right">{CLIPBOARD_LABEL[record.clipboardOutcome]}</dd>
                    </>
                  )}
                  {record.resultLinkedAtMs && (
                    <>
                      <dt className="text-muted-foreground">
                        {association === "linked" ? "保存回复" : "曾保存回复"}
                      </dt>
                      <dd className="text-right tabular-nums">{localTime(record.resultLinkedAtMs)}</dd>
                    </>
                  )}
                  {record.verificationAtMs && (
                    <>
                      <dt className="text-muted-foreground">检查回复</dt>
                      <dd className="text-right tabular-nums">{localTime(record.verificationAtMs)}</dd>
                    </>
                  )}
                  {!linkedResult && association === "unlinked" && (
                    <>
                      <dt className="text-muted-foreground">历史回复</dt>
                      <dd className="text-right">曾保存，现已取消或更换</dd>
                    </>
                  )}
                  {!linkedResult && association === "missing" && (
                    <>
                      <dt className="text-muted-foreground">历史回复</dt>
                      <dd className="text-right text-warning">回复卡已删除</dd>
                    </>
                  )}
                </dl>

                {linkedResult && (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {onVerify && (
                      <Button type="button" size="xs" variant="secondary" onClick={() => onVerify(linkedResult)}>
                        <ShieldCheck className="size-3" /> 检查回复
                      </Button>
                    )}
                    {onAssociate && (
                      <Button type="button" size="xs" variant="ghost" onClick={() => onAssociate(record)}>
                        <Link2 className="size-3" /> 更换回复
                      </Button>
                    )}
                    {onUnlink && (
                      <Button type="button" size="xs" variant="ghost" onClick={() => onUnlink(linkedResult)}>
                        <Unlink className="size-3" /> 这不是对应回复
                      </Button>
                    )}
                  </div>
                )}

                {linkedResult && onQuality && qualityEligible && (
                  <fieldset className="mt-2 border-t border-border/50 pt-2">
                    <legend className="text-micro text-muted-foreground">这条回复后来怎么用？（可选）</legend>
                    <div className="mt-1 flex flex-wrap gap-1" aria-label="回复使用情况">
                      {(Object.keys(QUALITY_LABEL) as OutcomeQuality[]).map((quality) => (
                        <button
                          key={quality}
                          type="button"
                          aria-pressed={selectedQuality === quality}
                          onClick={() => onQuality(record, linkedResult.id, quality)}
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
              </div>
            </details>

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
      setError("最近发送读取失败，请稍后重试");
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
    const confirmed = await ask("仅清除本数据目录中的发送元数据记录，不影响卡片、任务和附件。确认继续吗？", {
      title: "清除最近发送",
      kind: "warning",
    });
    if (!confirmed) return;
    try {
      await clearDeliveryEvents();
      setEvents([]);
      tip("ok", "最近发送已清除");
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
    const sources = deliverySourceItems(event, state.notes, state.tasks);
    if (sources.notes.length) {
      onOpenChange(false);
      openNoteBatchDetail(
        sources.notes.map((note) => note.id),
        event.sourceItemIds.length
      );
      return;
    }
    const sourceTask = sources.tasks[0];
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
                最近发送
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-micro leading-relaxed text-muted-foreground">
                查看发送是否成功，并把收到的回复放回对应记录。
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton label="关闭最近发送" size="sm"><X /></IconButton>
            </DialogPrimitive.Close>
          </header>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span
              className="inline-flex items-center gap-1 text-micro text-muted-foreground"
              title={`仅保存时间、状态与数量，不保存正文；最多 ${DELIVERY_ACTIVITY_MAX_EVENTS} 条或 ${retentionDays} 天`}
            >
              <ShieldCheck className="size-3 text-success" aria-hidden /> 本机保存 · 不含正文
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
                onUnlink={(note) => {
                  requestResultUnlink(
                    note.id,
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
