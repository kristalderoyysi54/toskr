import type { TransformRecipeId } from "@/lib/aiTransform";
import type { DeliveryEvent } from "@/lib/deliveryActivityCore";

export type OutcomeRange = "7d" | "30d" | "all";
export type OutcomeRetentionDays = 7 | 30 | 90;
export type OutcomeQuality =
  | "directUse"
  | "minorEdit"
  | "majorEdit"
  | "discarded";
export type OutcomeBaselineScope = "profile" | "recipe";

export interface OutcomeBaseline {
  scope: OutcomeBaselineScope;
  scopeId: string;
  minutes: number;
}

export interface OutcomeQualityFeedback {
  deliveryId: string;
  resultNoteId: string;
  quality: OutcomeQuality;
  updatedAtMs: number;
}

export interface OutcomeProblemSession {
  id: string;
  startedAtMs: number;
  deliveryId: string | null;
  resultNoteId: string | null;
  linkedAtMs: number | null;
  solvedAtMs: number | null;
  cancelledAtMs: number | null;
}

export interface OutcomeFilters {
  range: OutcomeRange;
  nowMs: number;
  timeZone: string;
  profileId: string | null;
  recipeId: TransformRecipeId | null;
  /** 清除指标只推进本地代次，不删除“最近发送”的恢复事件。 */
  metricsEpoch?: number;
}

export interface OutcomeDailyPoint {
  day: string;
  attempts: number;
  sent: number;
}

export interface OutcomeMetrics {
  deliveryAttempts: number;
  sentCount: number;
  successRate: number | null;
  blockedReasons: Record<string, number>;
  failedReasons: Record<string, number>;
  targetInvalidationBlocks: number;
  firewallFindingCount: number;
  redactionCount: number;
  clipboardOutcomes: Record<string, number>;
  draftToSendMedianMs: number | null;
  sendToResultMedianMs: number | null;
  actualWorkflowMedianMs: number | null;
  retryCount: number;
  verificationStatuses: Record<"pass" | "needsReview" | "blocked", number>;
  qualityFeedback: Record<OutcomeQuality, number>;
  problemResolutionMedianMs: number | null;
  estimatedTimeSavedMs: number | null;
  estimatedSampleSize: number;
  sampleSize: number;
  insufficientSample: boolean;
  dailyTrend: OutcomeDailyPoint[];
  trendConclusion: "up" | "down" | "flat" | null;
}

type MetricEvent = DeliveryEvent & {
  metricsEligible?: boolean;
  metricsEpoch?: number;
  transformRecipeId?: TransformRecipeId | null;
};

const QUALITY_VALUES = new Set<OutcomeQuality>([
  "directUse",
  "minorEdit",
  "majorEdit",
  "discarded",
]);
const RECIPE_VALUES = new Set<TransformRecipeId>([
  "summarize",
  "extract-actions",
  "improve-prompt",
  "structure-requirements",
]);

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

export function outcomeDayKey(timestampMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestampMs);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function rangeDayKeys(filters: OutcomeFilters): Set<string> | null {
  const days = filters.range === "7d" ? 7 : filters.range === "30d" ? 30 : null;
  if (!days) return null;
  const today = outcomeDayKey(filters.nowMs, filters.timeZone);
  const [year, month, day] = today.split("-").map(Number);
  const keys = new Set<string>();
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(Date.UTC(year, month - 1, day - offset));
    keys.add([
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ].join("-"));
  }
  return keys;
}

function isMetricEvent(value: unknown): value is MetricEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<MetricEvent>;
  return typeof event.eventId === "string" && !!event.eventId &&
    typeof event.deliveryId === "string" && !!event.deliveryId &&
    typeof event.eventType === "string" && validTime(event.timestampMs) &&
    typeof event.profileId === "string";
}

function eventEligible(event: MetricEvent, filters: OutcomeFilters): boolean {
  if (event.metricsEligible === false || event.timestampMs > filters.nowMs ||
    (filters.metricsEpoch !== undefined &&
      (event.metricsEpoch ?? 0) !== filters.metricsEpoch)) {
    return false;
  }
  return true;
}

function eventInRange(
  event: MetricEvent,
  filters: OutcomeFilters,
  dayKeys: Set<string> | null
): boolean {
  return !dayKeys || dayKeys.has(outcomeDayKey(event.timestampMs, filters.timeZone));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function increment(target: Record<string, number>, key: string | null): void {
  const normalized = key || "unknown";
  target[normalized] = (target[normalized] ?? 0) + 1;
}

function findingTotal(event: MetricEvent): number {
  const counts = event.firewallCounts;
  if (!counts || typeof counts !== "object") return 0;
  return Object.values(counts).reduce(
    (sum, value) => sum + (validTime(value) ? value : 0),
    0
  );
}

function isTargetBlock(reason: string | null): boolean {
  if (!reason) return false;
  return reason.includes("target") || reason === "draft-target-changed" ||
    reason === "target_exited" || reason === "target-not-ready";
}

function baselineFor(
  profileId: string,
  recipeId: TransformRecipeId | null,
  baselines: readonly OutcomeBaseline[]
): OutcomeBaseline | null {
  if (recipeId) {
    const recipe = baselines.find(
      (item) => item.scope === "recipe" && item.scopeId === recipeId
    );
    if (recipe) return recipe;
  }
  return baselines.find(
    (item) => item.scope === "profile" && item.scopeId === profileId
  ) ?? null;
}

export function aggregateOutcomeMetrics(
  inputEvents: readonly DeliveryEvent[],
  qualityInput: readonly OutcomeQualityFeedback[],
  sessionsInput: readonly OutcomeProblemSession[],
  baselineInput: readonly OutcomeBaseline[],
  filters: OutcomeFilters
): OutcomeMetrics {
  const dayKeys = rangeDayKeys(filters);
  const eligibleEvents = inputEvents
    .filter(isMetricEvent)
    .filter((event) => eventEligible(event, filters))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const finals = eligibleEvents.filter((event) =>
    (event.eventType === "firewallBlocked" || event.eventType === "sendSent" ||
      event.eventType === "sendBlocked" || event.eventType === "sendFailed") &&
    eventInRange(event, filters, dayKeys) &&
    (!filters.profileId || event.profileId === filters.profileId) &&
    (!filters.recipeId ||
      event.transformRecipeId === filters.recipeId)
  );
  const includedDeliveries = new Set(finals.map((event) => event.deliveryId));
  const events = eligibleEvents.filter((event) => includedDeliveries.has(event.deliveryId));
  const sentByDelivery = new Map<string, MetricEvent>();
  for (const event of finals) {
    if (event.eventType === "sendSent") sentByDelivery.set(event.deliveryId, event);
  }
  const byDelivery = new Map<string, MetricEvent[]>();
  for (const event of events) {
    const group = byDelivery.get(event.deliveryId) ?? [];
    group.push(event);
    byDelivery.set(event.deliveryId, group);
  }

  const sentCount = finals.filter((event) => event.eventType === "sendSent").length;
  const blockedReasons: Record<string, number> = {};
  const failedReasons: Record<string, number> = {};
  const clipboardOutcomes: Record<string, number> = {};
  let targetInvalidationBlocks = 0;
  let firewallFindingCount = 0;
  let redactionCount = 0;
  for (const event of finals) {
    if (event.eventType === "firewallBlocked" || event.eventType === "sendBlocked") {
      increment(blockedReasons, event.reasonCode);
      if (isTargetBlock(event.reasonCode)) targetInvalidationBlocks += 1;
    }
    if (event.eventType === "sendFailed") increment(failedReasons, event.reasonCode);
    firewallFindingCount += findingTotal(event);
    redactionCount += validTime(event.redactionCount) ? event.redactionCount : 0;
  }
  for (const event of events) {
    if (
      eventInRange(event, filters, dayKeys) &&
      (event.eventType === "clipboardRestored" || event.eventType === "clipboardSkipped") &&
      typeof event.clipboardOutcome === "string"
    ) increment(clipboardOutcomes, event.clipboardOutcome);
  }

  const draftToSend: number[] = [];
  const sendToResult: number[] = [];
  const actualWorkflows: number[] = [];
  const estimatedSavings: number[] = [];
  const baselines = normalizeOutcomeBaselines(baselineInput);
  let retryCount = 0;
  for (const group of byDelivery.values()) {
    const sent = sentByDelivery.get(group[0].deliveryId);
    const draft = sent
      ? [...group].reverse().find((event) =>
          event.eventType === "draftCreated" && event.timestampMs <= sent.timestampMs
        )
      : group.find((event) => event.eventType === "draftCreated");
    const starts = group.filter((event) => event.eventType === "sendStarted");
    const result = group.find(
      (event) => event.eventType === "resultCaptured" &&
        (!sent || event.timestampMs >= sent.timestampMs)
    );
    if (draft && sent && sent.timestampMs >= draft.timestampMs) {
      draftToSend.push(sent.timestampMs - draft.timestampMs);
    }
    retryCount += Math.max(0, starts.length - 1);
    retryCount += group.filter((event) =>
      event.eventType === "draftCreated" && event.reasonCode === "retry-prepared"
    ).length;
    if (sent && result && result.timestampMs >= sent.timestampMs) {
      sendToResult.push(result.timestampMs - sent.timestampMs);
    }
    if (draft && result && result.timestampMs >= draft.timestampMs) {
      const actual = result.timestampMs - draft.timestampMs;
      actualWorkflows.push(actual);
      const baseline = baselineFor(
        sent?.profileId ?? group[0].profileId,
        sent?.transformRecipeId ?? null,
        baselines
      );
      if (baseline) estimatedSavings.push(baseline.minutes * 60_000 - actual);
    }
  }

  const verificationStatuses = { pass: 0, needsReview: 0, blocked: 0 };
  for (const group of byDelivery.values()) {
    const latest = [...group]
      .reverse()
      .find((event) => event.eventType === "resultVerified");
    if (latest?.verificationStatus) verificationStatuses[latest.verificationStatus] += 1;
  }

  const qualityFeedback = {
    directUse: 0,
    minorEdit: 0,
    majorEdit: 0,
    discarded: 0,
  };
  const resultNoteByDelivery = new Map<string, string>();
  for (const event of events) {
    if ((event.eventType === "resultCaptured" || event.eventType === "resultVerified") &&
      event.resultNoteId) {
      resultNoteByDelivery.set(event.deliveryId, event.resultNoteId);
    }
  }
  const latestQuality = new Map<string, OutcomeQualityFeedback>();
  for (const item of qualityInput) {
    if (!validQualityFeedback(item) || !includedDeliveries.has(item.deliveryId) ||
      resultNoteByDelivery.get(item.deliveryId) !== item.resultNoteId) continue;
    const current = latestQuality.get(item.deliveryId);
    if (!current || item.updatedAtMs >= current.updatedAtMs) {
      latestQuality.set(item.deliveryId, item);
    }
  }
  for (const item of latestQuality.values()) qualityFeedback[item.quality] += 1;

  const problemDurations = normalizeProblemSessions(sessionsInput)
    .filter((session) => session.startedAtMs <= filters.nowMs)
    .filter(validProblemSession)
    .filter((session) => {
      if (!dayKeys?.has(outcomeDayKey(session.startedAtMs, filters.timeZone)) && dayKeys) return false;
      if (filters.profileId || filters.recipeId) {
        return !!session.deliveryId && includedDeliveries.has(session.deliveryId);
      }
      return true;
    })
    .filter((session) => session.solvedAtMs !== null)
    .map((session) => session.solvedAtMs! - session.startedAtMs)
    .filter((duration) => duration >= 0);

  const daily = new Map<string, OutcomeDailyPoint>();
  for (const final of finals) {
    const day = outcomeDayKey(final.timestampMs, filters.timeZone);
    const point = daily.get(day) ?? { day, attempts: 0, sent: 0 };
    point.attempts += 1;
    if (final.eventType === "sendSent") point.sent += 1;
    daily.set(day, point);
  }
  const dailyTrend = [...daily.values()].sort((a, b) => a.day.localeCompare(b.day));
  const sampleSize = finals.length;
  let trendConclusion: OutcomeMetrics["trendConclusion"] = null;
  if (sampleSize >= 5 && dailyTrend.length >= 2) {
    const half = Math.floor(dailyTrend.length / 2);
    const first = dailyTrend.slice(0, half).reduce((sum, item) => sum + item.sent, 0);
    const second = dailyTrend.slice(-half).reduce((sum, item) => sum + item.sent, 0);
    trendConclusion = second === first ? "flat" : second > first ? "up" : "down";
  }

  return {
    deliveryAttempts: finals.length,
    sentCount,
    successRate: finals.length ? sentCount / finals.length : null,
    blockedReasons,
    failedReasons,
    targetInvalidationBlocks,
    firewallFindingCount,
    redactionCount,
    clipboardOutcomes,
    draftToSendMedianMs: median(draftToSend),
    sendToResultMedianMs: median(sendToResult),
    actualWorkflowMedianMs: median(actualWorkflows),
    retryCount,
    verificationStatuses,
    qualityFeedback,
    problemResolutionMedianMs: median(problemDurations),
    estimatedTimeSavedMs: estimatedSavings.length
      ? estimatedSavings.reduce((sum, value) => sum + value, 0)
      : null,
    estimatedSampleSize: estimatedSavings.length,
    sampleSize,
    insufficientSample: sampleSize < 5,
    dailyTrend,
    trendConclusion,
  };
}

export function normalizeOutcomeBaselines(
  input: readonly OutcomeBaseline[] | undefined
): OutcomeBaseline[] {
  const byScope = new Map<string, OutcomeBaseline>();
  for (const item of input ?? []) {
    if (!item || (item.scope !== "profile" && item.scope !== "recipe")) continue;
    if (typeof item.scopeId !== "string" || !item.scopeId || item.scopeId.length > 160) continue;
    if (item.scope === "recipe" && !RECIPE_VALUES.has(item.scopeId as TransformRecipeId)) continue;
    if (!Number.isFinite(item.minutes) || item.minutes <= 0 || item.minutes > 10_080) continue;
    const key = `${item.scope}:${item.scopeId}`;
    // Map 更新不会移动插入顺序；先删再写，确保上限保留最后输入。
    byScope.delete(key);
    byScope.set(key, {
      ...item,
      scope: item.scope,
      scopeId: item.scopeId,
      minutes: item.minutes,
    });
  }
  return [...byScope.values()].slice(-64);
}

function validQualityFeedback(value: unknown): value is OutcomeQualityFeedback {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<OutcomeQualityFeedback>;
  return typeof item.deliveryId === "string" && !!item.deliveryId &&
    item.deliveryId.length <= 160 && typeof item.resultNoteId === "string" &&
    !!item.resultNoteId && item.resultNoteId.length <= 160 &&
    QUALITY_VALUES.has(item.quality as OutcomeQuality) && validTime(item.updatedAtMs);
}

export function normalizeQualityFeedback(
  input: readonly OutcomeQualityFeedback[] | undefined
): OutcomeQualityFeedback[] {
  const byDelivery = new Map<string, OutcomeQualityFeedback>();
  for (const item of input ?? []) {
    if (!validQualityFeedback(item)) continue;
    const current = byDelivery.get(item.deliveryId);
    if (!current || item.updatedAtMs >= current.updatedAtMs) byDelivery.set(item.deliveryId, { ...item });
  }
  return [...byDelivery.values()]
    .sort((left, right) => left.updatedAtMs - right.updatedAtMs)
    .slice(-500);
}

export function upsertQualityFeedback(
  input: readonly OutcomeQualityFeedback[],
  feedback: OutcomeQualityFeedback
): OutcomeQualityFeedback[] {
  return normalizeQualityFeedback([...input, feedback]);
}

function validProblemSession(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<OutcomeProblemSession>;
  const nullableTime = (candidate: unknown) => candidate === null || validTime(candidate);
  return typeof item.id === "string" && !!item.id && item.id.length <= 160 &&
    validTime(item.startedAtMs) &&
    (item.deliveryId === null || (typeof item.deliveryId === "string" && !!item.deliveryId && item.deliveryId.length <= 160)) &&
    (item.resultNoteId === undefined || item.resultNoteId === null ||
      (typeof item.resultNoteId === "string" && !!item.resultNoteId && item.resultNoteId.length <= 160)) &&
    nullableTime(item.linkedAtMs) && nullableTime(item.solvedAtMs) &&
    nullableTime(item.cancelledAtMs) && !(item.solvedAtMs !== null && item.cancelledAtMs !== null) &&
    (item.deliveryId === null) === (item.linkedAtMs === null) &&
    (item.deliveryId !== null || item.resultNoteId === undefined || item.resultNoteId === null) &&
    (item.linkedAtMs === null || item.linkedAtMs >= item.startedAtMs) &&
    (item.solvedAtMs === null || item.solvedAtMs >= item.startedAtMs) &&
    (item.cancelledAtMs === null || item.cancelledAtMs >= item.startedAtMs);
}

export function normalizeProblemSessions(
  input: readonly OutcomeProblemSession[] | undefined
): OutcomeProblemSession[] {
  const byId = new Map<string, OutcomeProblemSession>();
  for (const item of input ?? []) {
    if (!validProblemSession(item)) continue;
    byId.set(item.id, { ...item, resultNoteId: item.resultNoteId ?? null });
  }
  return [...byId.values()]
    .sort((left, right) => left.startedAtMs - right.startedAtMs)
    .slice(-100);
}

export function startProblemSession(
  input: readonly OutcomeProblemSession[],
  start: { id: string; startedAtMs: number }
): OutcomeProblemSession[] {
  const sessions = normalizeProblemSessions(input);
  if (!start.id || !validTime(start.startedAtMs) ||
    sessions.some((item) => item.id === start.id ||
      (item.solvedAtMs === null && item.cancelledAtMs === null))) {
    return sessions;
  }
  return normalizeProblemSessions([...sessions, {
    id: start.id,
    startedAtMs: start.startedAtMs,
    deliveryId: null,
    resultNoteId: null,
    linkedAtMs: null,
    solvedAtMs: null,
    cancelledAtMs: null,
  }]);
}

export function linkProblemSession(
  input: readonly OutcomeProblemSession[],
  sessionId: string,
  deliveryId: string,
  linkedAtMs: number,
  resultNoteId: string | null = null
): OutcomeProblemSession[] {
  if (!deliveryId || !validTime(linkedAtMs) ||
    (resultNoteId !== null && (!resultNoteId || resultNoteId.length > 160))) {
    return normalizeProblemSessions(input);
  }
  return normalizeProblemSessions(input.map((item) =>
    item.id === sessionId && item.solvedAtMs === null && item.cancelledAtMs === null &&
      linkedAtMs >= item.startedAtMs
      ? { ...item, deliveryId, resultNoteId, linkedAtMs }
      : item
  ));
}

export function solveProblemSession(
  input: readonly OutcomeProblemSession[],
  sessionId: string,
  solvedAtMs: number
): OutcomeProblemSession[] {
  if (!validTime(solvedAtMs)) return normalizeProblemSessions(input);
  return normalizeProblemSessions(input.map((item) =>
    item.id === sessionId && item.solvedAtMs === null && item.cancelledAtMs === null &&
      solvedAtMs >= item.startedAtMs
      ? { ...item, solvedAtMs }
      : item
  ));
}

export function cancelProblemSession(
  input: readonly OutcomeProblemSession[],
  sessionId: string,
  cancelledAtMs: number
): OutcomeProblemSession[] {
  if (!validTime(cancelledAtMs)) return normalizeProblemSessions(input);
  return normalizeProblemSessions(input.map((item) =>
    item.id === sessionId && item.solvedAtMs === null && item.cancelledAtMs === null &&
      cancelledAtMs >= item.startedAtMs
      ? { ...item, cancelledAtMs }
      : item
  ));
}
