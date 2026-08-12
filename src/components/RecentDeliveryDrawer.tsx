import { ask } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  MessageSquareReply,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Unlink,
  VenetianMask,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
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
  activeAliasOccurrences,
  restoreAliases,
} from "@/lib/delivery/aliasEntities";
import { openNoteBatchDetail, openNoteDetail, undoableTip } from "@/lib/actions";
import { timeAgo } from "@/lib/media";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { useNotesStore, type Note, type Task } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

const STATUS_LABEL: Record<DeliveryEvent["status"], string> = {
  prepared: "准备中",
  opened: "预检未完成",
  started: "发送中",
  sent: "已发送",
  blocked: "已拦截",
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

/** 回合视角的行徽章：等待回复 / 已收到回复 / 问题态沿用状态词。 */
function roundtripBadge(
  record: DeliveryActivityRecord,
  hasReply: boolean
): { label: string; tone: "success" | "warning" | "muted" } {
  if (record.status === "failed" || record.status === "blocked") {
    return { label: STATUS_LABEL[record.status], tone: "warning" };
  }
  if (record.status !== "sent") {
    return { label: STATUS_LABEL[record.status], tone: "muted" };
  }
  return hasReply
    ? { label: "已收到回复", tone: "success" }
    : { label: "等待回复", tone: "muted" };
}

/** 卡脚/明细里的文字链操作（低视觉重量，替代原 Button 组）。 */
const FOOT_LINK =
  "rounded-sm text-micro text-muted-foreground underline decoration-dotted underline-offset-2 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-40";

/** 状态药丸：软染色底 + 图标；等待态用琥珀呼吸点替代静态时钟。 */
function StatusPill({
  record,
  hasReply,
}: {
  record: DeliveryActivityRecord;
  hasReply: boolean;
}) {
  const badge = roundtripBadge(record, hasReply);
  const waiting = record.status === "sent" && !hasReply;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-micro font-medium",
        badge.tone === "warning"
          ? "bg-destructive/10 text-destructive"
          : badge.tone === "success"
            ? "bg-success/10 text-success"
            : waiting
              ? "bg-warning/10 text-warning"
              : "bg-muted text-muted-foreground"
      )}
    >
      {badge.tone === "warning" ? (
        <AlertTriangle className="size-2.5" aria-hidden />
      ) : badge.tone === "success" ? (
        <CheckCircle2 className="size-2.5" aria-hidden />
      ) : waiting ? (
        <span className="relative flex size-1.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-1.5 rounded-full bg-warning" />
        </span>
      ) : (
        <Clock3 className="size-2.5" aria-hidden />
      )}
      {badge.label}
    </span>
  );
}

/** 分区组头：状态标签 + 计数 + 发丝线；等待区右端挂一条全局划词引导。 */
function SectionHead({
  label,
  count,
  hint,
}: {
  label: string;
  count: number;
  hint?: boolean;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2 px-0.5 pt-3 first:pt-0.5">
      <span className="shrink-0 text-micro font-medium text-muted-foreground/70">
        {label} · {count}
      </span>
      <span className="h-px min-w-4 flex-1 bg-border/60" aria-hidden />
      {hint && (
        <span
          className="flex shrink-0 items-center gap-1 text-micro text-muted-foreground/70"
          title="在 AI 应用双击 ⇧ 划选回复内容，会自动带回并对应到该次发送"
        >
          划词 <Kbd>⇧⇧</Kbd> 自动带回
        </span>
      )}
    </div>
  );
}

/** 出站摘要：从当前仍存活的来源卡实时重建首行（账本不存正文）；来源删除时返回 null。 */
function outboundSummary(
  record: DeliveryEvent,
  notes: readonly Note[],
  tasks: readonly Task[]
): string | null {
  const sources = deliverySourceItems(record, notes, tasks);
  const text =
    sources.notes
      .map((note) => (note.kind === "image" ? "" : note.text))
      .find(Boolean) ?? sources.tasks[0]?.text;
  const firstLine = text?.split("\n", 1)[0]?.trim();
  return firstLine || null;
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
}) {
  const aliasEntitiesEnabled = useNotesStore(
    (state) => state.settings.aliasEntitiesEnabled
  );
  const aliasEntities = useNotesStore((state) => state.settings.aliasEntities);
  const restoreReplyAliases = (note: Note) => {
    const { text, restoredCount } = restoreAliases(note.text, aliasEntities);
    if (text === note.text) return;
    useNotesStore.getState().snapshot("恢复化名");
    useNotesStore.getState().updateNoteText(note.id, text);
    undoableTip(`已恢复 ${restoredCount} 处化名`);
  };
  // 回合视角：进行中的半次发送（准备中/预检未完成/发送中）不进主列表，收进底部折叠组
  const mainRecords = records.filter(
    (record) =>
      record.status !== "prepared" &&
      record.status !== "opened" &&
      record.status !== "started"
  );
  const unfinishedRecords = records.filter(
    (record) => !mainRecords.includes(record)
  );
  if (!records.length) {
    return (
      <div className="flex min-h-36 flex-col items-center justify-center text-center text-body text-muted-foreground">
        <Clock3 className="mb-2 size-5 opacity-50" aria-hidden />
        暂无发送记录
        <p className="mt-1 text-label text-muted-foreground">
          勾选卡片后 ⌘⏎ 发送，这里会出现你和 AI 的一问一答
        </p>
      </div>
    );
  }
  // 状态分区（方案 B，2026-08-12 用户定稿）：需处理 → 等待回复 → 已完成，组内保持原时间序。
  // 分区自带答案，行内不再重复「下一步」教学（引导收进等待区组头）
  const recordHasReply = (record: DeliveryActivityRecord) =>
    !!record.resultNoteId &&
    notes.some(
      (note) =>
        note.id === record.resultNoteId &&
        note.provenance?.deliveryId === record.deliveryId
    );
  const attention = mainRecords.filter(
    (record) => record.status === "failed" || record.status === "blocked"
  );
  const waiting = mainRecords.filter(
    (record) => record.status === "sent" && !recordHasReply(record)
  );
  const settled = mainRecords.filter(
    (record) => !attention.includes(record) && !waiting.includes(record)
  );
  const sections = [
    { key: "attention", label: "需处理", records: attention, hint: false },
    { key: "waiting", label: "等待回复", records: waiting, hint: true },
    { key: "settled", label: "已完成", records: settled, hint: false },
  ].filter((section) => section.records.length > 0);
  const renderRound = (record: DeliveryActivityRecord) => {
        const availability = deliveryEventSourceAvailability(record, notes, tasks);
        const recoverable = record.status === "failed" || record.status === "blocked";
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
        const aliasRestorable =
          linkedResult && aliasEntitiesEnabled
            ? activeAliasOccurrences(linkedResult.text, aliasEntities)
            : [];
        const summary = outboundSummary(record, notes, tasks);
        const waitingReply = record.status === "sent" && !linkedResult;
        return (
          <li
            key={record.deliveryId}
            className="rounded-xl border border-foreground/10 bg-muted/30 p-2.5"
          >
            {/* 行头：应用名（署名位）＋ 时间紧贴状态药丸（不悬在行中间） */}
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-body font-medium" title={record.targetAppName ?? undefined}>
                {record.targetAppName || record.targetBundleId || "未识别目标"}
              </span>
              <time
                className="shrink-0 text-micro tabular-nums text-muted-foreground/60"
                dateTime={new Date(record.timestampMs).toISOString()}
                title={localTime(record.timestampMs)}
              >
                {timeAgo(record.timestampMs)}
              </time>
              <StatusPill record={record} hasReply={!!linkedResult} />
            </div>

            {/* 出站摘要（来源卡实时重建）——点击查看完整发送内容 */}
            <button
              type="button"
              disabled={availability === "missing" || !onOpenSource}
              onClick={() => onOpenSource?.(record)}
              title="查看发送内容"
              className="mt-1 block w-full min-w-0 truncate rounded-md px-1 py-0.5 text-left text-body text-foreground/90 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-default disabled:opacity-60"
            >
              {summary ? `“${summary}”` : sourceLabel(record, availability)}
            </button>

            {/* 回复引用条（问答感的「答」）：按隐私契约不渲染回复正文，只给入库标记与入口 */}
            {linkedResult && (
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-l-2 border-success/40 py-0.5 pl-2">
                <span className="flex items-center gap-1 text-micro text-muted-foreground">
                  <MessageSquareReply className="size-3 shrink-0 text-success" aria-hidden />
                  回复已入库
                </span>
                {onOpenResult && (
                  <button
                    type="button"
                    title="打开回复"
                    onClick={() => onOpenResult(linkedResult)}
                    className="rounded-md border border-border/60 px-1.5 py-px text-micro text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    打开
                  </button>
                )}
                {aliasRestorable.length > 0 && (
                  <button
                    type="button"
                    title="把词典占位符还原为原文（本机操作，可撤销）"
                    onClick={() => restoreReplyAliases(linkedResult)}
                    className="flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-px text-micro text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    <VenetianMask className="size-3" aria-hidden /> 恢复化名（{aliasRestorable.length} 处）
                  </button>
                )}
              </div>
            )}

            {/* 卡脚：高频操作走左侧文字链，右端「更多」展开完整明细；
                操作钮在 summary 内需 preventDefault 阻断 details 切换 */}
            <details className="group mt-2 border-t border-border/50 pt-1.5">
              <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-primary/50 [&::-webkit-details-marker]:hidden">
                {waitingReply && onAssociate && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onAssociate(record);
                    }}
                    className={FOOT_LINK}
                  >
                    手动选择回复
                  </button>
                )}
                {recoverable && (
                  <button
                    type="button"
                    disabled={availability !== "available" || busyEventId !== null}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onReprepare(record);
                    }}
                    className={cn("flex items-center gap-1", FOOT_LINK)}
                  >
                    <RotateCcw className={cn("size-3", busyEventId === record.eventId && "animate-spin motion-reduce:animate-none")} aria-hidden />
                    重新准备
                  </button>
                )}
                {linkedResult && onVerify && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onVerify(linkedResult);
                    }}
                    className={FOOT_LINK}
                  >
                    检查回复
                  </button>
                )}
                {linkedResult && onAssociate && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onAssociate(record);
                    }}
                    className={FOOT_LINK}
                  >
                    更换回复
                  </button>
                )}
                <span
                  className="ml-auto flex items-center gap-1 text-micro text-muted-foreground transition-colors hover:text-foreground"
                  title="更多信息"
                >
                  更多
                  <ChevronDown className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
                </span>
              </summary>
              <div className="px-1 pb-1 pt-1.5">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-micro">
                  <dt className="text-muted-foreground">
                    {record.status === "sent" ? "发送于" : "记录于"}
                  </dt>
                  <dd className="text-right tabular-nums">
                    <time dateTime={new Date(record.timestampMs).toISOString()}>
                      {localTime(record.timestampMs)}
                    </time>
                  </dd>
                  <dt className="text-muted-foreground">原内容</dt>
                  <dd className="truncate text-right">
                    {sourceLabel(record, availability)} · {payloadLabel(record)}
                  </dd>
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
                  {linkedResult && (
                    <>
                      <dt className="text-muted-foreground">核验</dt>
                      <dd className="text-right">{verificationLabel(record)}</dd>
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

                {/* 高频操作已上卡脚（检查/更换）；解绑是低频危险项，留在明细里 */}
                {linkedResult && onUnlink && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => onUnlink(linkedResult)}
                      className={cn("flex items-center gap-1", FOOT_LINK)}
                    >
                      <Unlink className="size-3" aria-hidden /> 这不是对应回复
                    </button>
                  </div>
                )}
              </div>
            </details>
          </li>
        );
  };
  return (
    <div>
    {sections.map((section) => (
      <Fragment key={section.key}>
        <SectionHead
          label={section.label}
          count={section.records.length}
          hint={section.hint}
        />
        <ol className="space-y-1.5" aria-label={`${section.label}记录`}>
          {section.records.map(renderRound)}
        </ol>
      </Fragment>
    ))}

    {unfinishedRecords.length > 0 && (
      <details className="group mt-3">
        <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-1 py-1 text-micro text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 [&::-webkit-details-marker]:hidden">
          未发出的记录 {unfinishedRecords.length} 条
          <ChevronDown className="ml-auto size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
        </summary>
        <ol className="mt-1.5 space-y-1.5" aria-label="未发出的记录">
          {unfinishedRecords.map((record) => {
            const availability = deliveryEventSourceAvailability(record, notes, tasks);
            const summary = outboundSummary(record, notes, tasks);
            return (
              <li key={record.deliveryId}>
                <button
                  type="button"
                  disabled={availability === "missing" || !onOpenSource}
                  onClick={() => onOpenSource?.(record)}
                  title="查看内容"
                  className="flex w-full min-w-0 items-center gap-1.5 rounded-lg border border-border/50 px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-default disabled:opacity-60"
                >
                  <Clock3 className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 truncate text-label">
                    {record.targetAppName || record.targetBundleId || "未识别目标"}
                    {summary ? ` · ${summary}` : ""}
                  </span>
                  <span className="ml-auto shrink-0 text-micro text-muted-foreground">
                    {STATUS_LABEL[record.status]}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </details>
    )}
    </div>
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
  const retentionDays = useNotesStore(
    (state) => state.settings.outcomeRetentionDays
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
      // 文本/代码/链接与合并预览都在独立窗口打开，抽屉保持打开；
      // 仅单张图片卡走面板内预览层（会被抽屉盖住），才需要先收起抽屉
      const single =
        sources.notes.length === 1 && event.sourceItemIds.length <= 1
          ? sources.notes[0]
          : null;
      if (single?.kind === "image") onOpenChange(false);
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
          {/* 头部瘦身：教学副标题只留给读屏（视觉引导由等待区组头承担），
              清除记录收进头部图标位 */}
          <header className="flex items-center gap-1 border-b border-border/70 pb-2">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-title font-semibold">
              最近发送
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              发出的内容和收到的回复，一问一答都在这里；划词捕获的回复会自动对应。
            </DialogPrimitive.Description>
            <IconButton
              label="清除记录"
              size="sm"
              tone="danger"
              onClick={() => void clear()}
              disabled={loading || busyEventId !== null || !events.length}
            >
              <Trash2 />
            </IconButton>
            <DialogPrimitive.Close asChild>
              <IconButton label="关闭最近发送" size="sm"><X /></IconButton>
            </DialogPrimitive.Close>
          </header>
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
                  // 文本回复在独立窗口打开，抽屉保持；图片回复走面板内预览层需先收起
                  if (note.kind === "image") onOpenChange(false);
                  openNoteDetail(note.id);
                }}
                onVerify={(note) => {
                  // 检查对话框是更高层的独立 Dialog（与「更换回复」同法），抽屉无需关闭
                  requestResultVerification(
                    note.id,
                    document.activeElement instanceof HTMLElement
                      ? document.activeElement
                      : returnFocusRef.current
                  );
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
              />
            )}
          </div>
          {/* 隐私说明沉底为尾注（常显、不与列表争视线） */}
          <p
            className="mt-2 flex items-center gap-1.5 border-t border-border/50 pt-2 text-micro text-muted-foreground/70"
            title={`仅保存时间、状态与数量，不保存正文；最多 ${DELIVERY_ACTIVITY_MAX_EVENTS} 条或 ${retentionDays} 天`}
          >
            <ShieldCheck className="size-3 shrink-0 text-success" aria-hidden />
            记录仅存状态与计数 · 摘要来自当前卡片
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
