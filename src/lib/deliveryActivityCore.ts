import {
  beginDataGenerationLease,
  currentDataGeneration,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import {
  api,
  type ClipboardOutcome,
  type SendDeliveryResult,
} from "@/lib/tauri";
import type { FindingCategory } from "@/lib/tauri";
import type { TransformRecipeId } from "@/lib/aiTransform";
import type { DeliveryDraft, DeliverySourceKind } from "@/lib/delivery/types";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import { useNotesStore, type Note, type Task } from "@/store/notesStore";

export const DELIVERY_ACTIVITY_RETENTION_DAYS = 30;
export const DELIVERY_ACTIVITY_RETENTION_OPTIONS = [7, 30, 90] as const;
export type DeliveryActivityRetentionDays =
  (typeof DELIVERY_ACTIVITY_RETENTION_OPTIONS)[number];
export const DELIVERY_ACTIVITY_MAX_EVENTS = 500;
export const DELIVERY_ACTIVITY_CLEARED_EVENT = "toskr://delivery-activity-cleared";

export type DeliveryEventType =
  | "draftCreated"
  | "preflightOpened"
  | "firewallBlocked"
  | "sendStarted"
  | "sendSent"
  | "sendBlocked"
  | "sendFailed"
  | "clipboardRestored"
  | "clipboardSkipped"
  | "resultCaptured"
  | "resultVerified";

export type DeliveryActivityStatus =
  | "prepared"
  | "opened"
  | "started"
  | "sent"
  | "blocked"
  | "failed"
  | "restored"
  | "skipped"
  | "captured"
  | "verified";

export type VerificationActivityStatus = "pass" | "needsReview" | "blocked";

export type FirewallCounts = Record<FindingCategory, number>;

/** 持久化白名单。禁止扩成 DeliveryDraft 子集，避免正文随字段蔓延落盘。 */
export interface DeliveryEvent {
  eventId: string;
  deliveryId: string;
  eventType: DeliveryEventType;
  timestampMs: number;
  sourceKind: DeliverySourceKind;
  sourceItemIds: string[];
  targetBundleId: string | null;
  targetAppName: string | null;
  profileId: string;
  status: DeliveryActivityStatus;
  reasonCode: string | null;
  durationMs: number | null;
  textCharCount: number;
  imageCount: number;
  firewallCounts: FirewallCounts;
  redactionCount: number;
  clipboardOutcome: ClipboardOutcome | null;
  resultNoteId: string | null;
  /** false 时仅供最近发送恢复，不进入成效聚合；旧行缺省视为 true。 */
  metricsEligible?: boolean;
  /** 成效清除代次；旧行缺省为 0，清除不删除恢复账本。 */
  metricsEpoch?: number;
  /** 最后实际应用到本次正文的配方；未应用或手工改写后为 null。 */
  transformRecipeId?: TransformRecipeId | null;
  /** v13+；旧 JSONL 行允许缺失，只有 resultVerified 必须非空。 */
  verificationStatus?: VerificationActivityStatus | null;
  verificationCheckCount?: number | null;
  verificationIssueCount?: number | null;
}

/**
 * 最近发送的只读聚合视图。`timestampMs` 始终表示发送生命周期的最终时间；
 * 关联和检查时间单列，避免后续动作把旧发送伪装成刚刚发生。
 */
export interface DeliveryActivityRecord extends DeliveryEvent {
  lastActivityAtMs: number;
  resultLinkedAtMs: number | null;
  verificationAtMs: number | null;
}

export type DeliveryEventOverrides = {
  eventId?: string;
  timestampMs?: number;
  status: DeliveryActivityStatus;
  reasonCode?: string | null;
  durationMs?: number | null;
  clipboardOutcome?: ClipboardOutcome | null;
  targetBundleId?: string | null;
  targetAppName?: string | null;
};

const FINDING_CATEGORIES = [
  "privateKey",
  "authorization",
  "apiKey",
  "databaseUrl",
  "email",
  "phone",
  "nationalId",
  "bankCard",
  "ipAddress",
  "cookie",
  "session",
] as const satisfies readonly FindingCategory[];

function emptyFirewallCounts(): FirewallCounts {
  return Object.fromEntries(
    FINDING_CATEGORIES.map((category) => [category, 0])
  ) as FirewallCounts;
}

function nextEventId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `activity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function deliveryEventFromDraft(
  draft: DeliveryDraft,
  eventType: DeliveryEventType,
  overrides: DeliveryEventOverrides
): DeliveryEvent {
  const firewallCounts = emptyFirewallCounts();
  for (const finding of draft.findings) {
    firewallCounts[finding.category] += 1;
  }
  for (const image of draft.imageFirewall) {
    for (const finding of image.findings) {
      firewallCounts[finding.category] += 1;
    }
  }
  return {
    eventId: overrides.eventId ?? nextEventId(),
    deliveryId: draft.id,
    eventType,
    timestampMs: overrides.timestampMs ?? Date.now(),
    sourceKind: draft.sourceKind,
    sourceItemIds: [...draft.sourceItemIds],
    targetBundleId:
      overrides.targetBundleId ?? draft.targetSnapshot?.bundleId ?? null,
    targetAppName:
      overrides.targetAppName ?? draft.targetSnapshot?.appName ?? null,
    profileId: draft.targetProfileId,
    status: overrides.status,
    reasonCode: overrides.reasonCode ?? null,
    durationMs: overrides.durationMs ?? null,
    textCharCount: draft.finalText.length,
    imageCount: draft.imageFiles.length,
    firewallCounts,
    redactionCount:
      draft.privacyDecision.replacedCount +
      draft.imageFirewall.reduce(
        (count, image) => count + image.redactedFindingIds.length,
        0
      ),
    clipboardOutcome: overrides.clipboardOutcome ?? null,
    resultNoteId: null,
    metricsEligible: true,
    metricsEpoch: 0,
    transformRecipeId: draft.transformRecipeId,
    verificationStatus: null,
    verificationCheckCount: null,
    verificationIssueCount: null,
  };
}

export function deliveryEventsFromResult(
  draft: DeliveryDraft,
  result: SendDeliveryResult
): [DeliveryEvent, DeliveryEvent] {
  const eventType = result.status === "sent"
    ? "sendSent"
    : result.status === "blocked"
      ? "sendBlocked"
      : "sendFailed";
  const target = result.target ?? draft.targetSnapshot;
  const shared = {
    timestampMs: result.finishedAtMs,
    reasonCode: result.reasonCode,
    durationMs: Math.max(0, result.finishedAtMs - result.startedAtMs),
    clipboardOutcome: result.clipboardOutcome,
    targetBundleId: target?.bundleId ?? null,
    targetAppName: target?.appName ?? null,
  };
  const delivery = deliveryEventFromDraft(draft, eventType, {
    ...shared,
    status: result.status,
  });
  const restored = result.clipboardOutcome === "restored" ||
    result.clipboardOutcome === "restoredPartial";
  const clipboard = deliveryEventFromDraft(
    draft,
    restored ? "clipboardRestored" : "clipboardSkipped",
    {
      ...shared,
      status: restored ? "restored" : "skipped",
    }
  );
  return [delivery, clipboard];
}

export function deliveryActivityRecords(
  events: readonly DeliveryEvent[]
): DeliveryActivityRecord[] {
  const grouped = new Map<
    string,
    {
      latestAt: number;
      latest: DeliveryEvent;
      final: DeliveryEvent | null;
      clipboardOutcome: ClipboardOutcome | null;
      resultNoteId: string | null;
      resultAt: number;
      resultLinkedAt: number;
      verificationStatus: VerificationActivityStatus | null;
      verificationCheckCount: number | null;
      verificationIssueCount: number | null;
      verificationAt: number;
    }
  >();
  for (const event of events) {
    const current = grouped.get(event.deliveryId);
    const isClipboard = event.eventType === "clipboardRestored" ||
      event.eventType === "clipboardSkipped";
    const isFinal = event.eventType === "firewallBlocked" ||
      event.eventType === "sendSent" ||
      event.eventType === "sendBlocked" ||
      event.eventType === "sendFailed";
    const isResult = event.eventType === "resultCaptured" ||
      event.eventType === "resultVerified";
    const isResultLink = event.eventType === "resultCaptured";
    const isVerification = event.eventType === "resultVerified";
    if (!current) {
      grouped.set(event.deliveryId, {
        latestAt: event.timestampMs,
        latest: event,
        final: isFinal ? event : null,
        clipboardOutcome: isClipboard ? event.clipboardOutcome : null,
        resultNoteId: isResult ? event.resultNoteId : null,
        resultAt: isResult ? event.timestampMs : -1,
        resultLinkedAt: isResultLink ? event.timestampMs : -1,
        verificationStatus: isVerification ? event.verificationStatus ?? null : null,
        verificationCheckCount:
          isVerification ? event.verificationCheckCount ?? null : null,
        verificationIssueCount:
          isVerification ? event.verificationIssueCount ?? null : null,
        verificationAt: isVerification ? event.timestampMs : -1,
      });
      continue;
    }
    if (event.timestampMs > current.latestAt) {
      current.latestAt = event.timestampMs;
      current.latest = event;
    }
    if (isFinal && (!current.final || event.timestampMs > current.final.timestampMs)) {
      current.final = event;
    }
    if (isClipboard && event.clipboardOutcome) {
      current.clipboardOutcome = event.clipboardOutcome;
    }
    if (isResult && event.resultNoteId && event.timestampMs >= current.resultAt) {
      current.resultAt = event.timestampMs;
      current.resultNoteId = event.resultNoteId;
    }
    if (isResultLink && event.timestampMs >= current.resultLinkedAt) {
      current.resultLinkedAt = event.timestampMs;
    }
    if (isVerification && event.timestampMs >= current.verificationAt) {
      current.verificationAt = event.timestampMs;
      current.verificationStatus = event.verificationStatus ?? null;
      current.verificationCheckCount = event.verificationCheckCount ?? null;
      current.verificationIssueCount = event.verificationIssueCount ?? null;
    }
  }
  return [...grouped.values()]
    .map((group) => ({
      ...(group.final ?? group.latest),
      timestampMs: (group.final ?? group.latest).timestampMs,
      lastActivityAtMs: group.latestAt,
      resultLinkedAtMs: group.resultLinkedAt >= 0 ? group.resultLinkedAt : null,
      verificationAtMs: group.verificationAt >= 0 ? group.verificationAt : null,
      clipboardOutcome:
        group.clipboardOutcome ?? (group.final ?? group.latest).clipboardOutcome,
      resultNoteId: group.resultNoteId,
      verificationStatus: group.verificationStatus,
      verificationCheckCount: group.verificationCheckCount,
      verificationIssueCount: group.verificationIssueCount,
    }))
    .sort((left, right) => right.timestampMs - left.timestampMs);
}

export type DeliverySourceAvailability = "available" | "partial" | "missing";

/** 按发送记录中的顺序解析当前仍存在的来源。 */
export function deliverySourceItems(
  event: DeliveryEvent,
  notes: readonly Note[],
  tasks: readonly Task[]
): { notes: Note[]; tasks: Task[] } {
  const sourceIds = new Set(event.sourceItemIds);
  const notesById = new Map(
    notes.filter((item) => sourceIds.has(item.id)).map((item) => [item.id, item])
  );
  const tasksById = new Map(
    tasks.filter((item) => sourceIds.has(item.id)).map((item) => [item.id, item])
  );
  return {
    notes: event.sourceKind === "task"
      ? []
      : event.sourceItemIds.flatMap((id) => {
          const note = notesById.get(id);
          return note ? [note] : [];
        }),
    tasks: event.sourceKind === "task"
      ? event.sourceItemIds.flatMap((id) => {
          const task = tasksById.get(id);
          return task ? [task] : [];
        })
      : [],
  };
}

export function deliveryEventSourceAvailability(
  event: DeliveryEvent,
  notes: readonly Note[],
  tasks: readonly Task[]
): DeliverySourceAvailability {
  const existing = new Set(
    event.sourceKind === "task"
      ? tasks.map((item) => item.id)
      : notes.map((item) => item.id)
  );
  const count = event.sourceItemIds.filter((id) => existing.has(id)).length;
  if (count === event.sourceItemIds.length && count > 0) return "available";
  return count > 0 ? "partial" : "missing";
}

export function recordDeliveryResult(
  draft: DeliveryDraft,
  result: SendDeliveryResult
): void {
  for (const event of deliveryEventsFromResult(draft, result)) {
    void recordDeliveryEvent(event);
  }
}

let activityQueue: Promise<unknown> = Promise.resolve();
let activityReadCache: {
  generation: number;
  retentionDays: DeliveryActivityRetentionDays;
  cachedAtMs: number;
  events: DeliveryEvent[];
} | null = null;
let activityCacheRevision = 0;

export function invalidateDeliveryActivityCache(): void {
  activityCacheRevision += 1;
  activityReadCache = null;
}

function enqueueActivity<T>(work: () => Promise<T>): Promise<T> {
  const lease = beginDataGenerationLease();
  const generation = lease.generation;
  const operation = activityQueue
    .catch(() => undefined)
    .then(async () => {
      if (isDataOperationLocked() || !matchesDataGeneration(generation)) {
        throw new Error("数据上下文已变化");
      }
      return work();
    })
    .finally(lease.release);
  activityQueue = operation.catch(() => undefined);
  return operation;
}

/** 账本失败不得改变发送结果；调用方可选择 await，但只消费布尔结果。 */
export function recordDeliveryEvent(event: DeliveryEvent): Promise<boolean> {
  const settings = useNotesStore.getState().settings;
  const storedEvent = {
    ...event,
    metricsEligible: settings.outcomeMetricsEnabled,
    metricsEpoch: settings.outcomeMetricsEpoch,
  };
  invalidateDeliveryActivityCache();
  return enqueueActivity(() => api.appendDeliveryEvent(
    storedEvent,
    settings.outcomeRetentionDays
  ))
    .then(() => true)
    .catch(() => false);
}

export function getRecentDeliveryEvents(
  limit = 100,
  explicitRetentionDays?: DeliveryActivityRetentionDays
): Promise<DeliveryEvent[]> {
  const retentionDays = explicitRetentionDays ??
    useNotesStore.getState().settings.outcomeRetentionDays;
  return enqueueActivity(() => api.getRecentDeliveryEvents(limit, retentionDays));
}

/** 捕获 HUD 的短 TTL 只读缓存；避免连拍捕获反复解析/压实 1 MiB JSONL。 */
export async function getRecentDeliveryEventsCached(
  limit = 100,
  maxAgeMs = 2_000
): Promise<DeliveryEvent[]> {
  const generation = currentDataGeneration();
  const retentionDays = useNotesStore.getState().settings.outcomeRetentionDays;
  if (
    activityReadCache?.generation === generation &&
    activityReadCache.retentionDays === retentionDays &&
    Date.now() - activityReadCache.cachedAtMs <= maxAgeMs
  ) return activityReadCache.events.slice(0, limit);
  const revision = activityCacheRevision;
  const events = await getRecentDeliveryEvents(Math.max(limit, 100));
  if (matchesDataGeneration(generation) && revision === activityCacheRevision) {
    activityReadCache = {
      generation,
      retentionDays,
      cachedAtMs: Date.now(),
      events,
    };
  }
  return events.slice(0, limit);
}

export function clearDeliveryEvents(): Promise<void> {
  invalidateDeliveryActivityCache();
  return enqueueActivity(() => api.clearDeliveryEvents());
}

/** 供退出/测试等待已排队元数据写入；不暴露队列内容。 */
export async function flushDeliveryActivityWrites(): Promise<void> {
  await activityQueue.catch(() => undefined);
}
