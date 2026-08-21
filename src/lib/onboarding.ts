import type { DeliveryDraft } from "@/lib/delivery/types";

export const ONBOARDING_VERSION = 3;
export const SAFE_REHEARSAL_ACTIVATION_MS = 60_000;
export const SAFE_REHEARSAL_TEXT =
  "请把这段内容概括成一句话。示例邮箱 demo.user@example.com。";

export type OnboardingStep =
  | "permissions"
  | "capture"
  | "target"
  | "firewall"
  | "delivery"
  | "complete";

export type RehearsalStatus =
  | "notStarted"
  | "active"
  | "paused"
  | "skipped"
  | "completed";

export interface OnboardingState {
  /** v1 三步引导兼容字段；旧调用仍只更新这三个布尔值。 */
  captured: boolean;
  sent: boolean;
  done: boolean;
  onboardingVersion: number;
  rehearsalStatus: RehearsalStatus;
  rehearsalStep: OnboardingStep;
  rehearsalActive: boolean;
  rehearsalNoteId: string | null;
  rehearsalStartedAtMs: number | null;
  rehearsalPausedAtMs: number | null;
  rehearsalCompletedAtMs: number | null;
  rehearsalSkippedAtMs: number | null;
  /** v2 的 defer 兼容字段；新状态只写 rehearsalSkippedAtMs。 */
  rehearsalDeferredAtMs: number | null;
  /** Raycast 式入门任务：权限检查作为独立成就保留，重跑演练不清空。 */
  permissionsCompletedAtMs: number | null;
  /** 可逆占位符本地恢复教学已完成；不保存任何真实映射或正文。 */
  recoveryTutorialCompletedAtMs: number | null;
  /** 从权限就绪后的首个示例动作起算；不包含系统设置停留时间。 */
  activationStartedAtMs: number | null;
  /** 仅作本机内部激活信号；UI 不展示倒计时或失败结论。 */
  activationWithin60s: boolean | null;
}

export type OnboardingEvent =
  | { type: "start" }
  | { type: "resume" }
  | { type: "pause" }
  | { type: "permissionsReady" }
  | { type: "samplePrepared" }
  | { type: "sampleCaptured"; noteId: string }
  | { type: "targetConfirmed" }
  | { type: "preflightOpened" }
  | { type: "deliverySent" }
  | { type: "recoveryTutorialCompleted" }
  | { type: "skip" };

export type PermissionRehearsalStatus =
  | "accessibilityDenied"
  | "tapUnavailable"
  | "waitingForEvents"
  | "inputMonitoringBlocked"
  | "ready";

export type SafeRehearsalLaunchMode = "start" | "resume";

const STEPS = new Set<OnboardingStep>([
  "permissions",
  "capture",
  "target",
  "firewall",
  "delivery",
  "complete",
]);
const REHEARSAL_STATUSES = new Set<RehearsalStatus>([
  "notStarted",
  "active",
  "paused",
  "skipped",
  "completed",
]);

function finiteTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function defaultOnboardingState(): OnboardingState {
  return {
    captured: false,
    sent: false,
    done: false,
    onboardingVersion: ONBOARDING_VERSION,
    rehearsalStatus: "notStarted",
    rehearsalStep: "permissions",
    rehearsalActive: false,
    rehearsalNoteId: null,
    rehearsalStartedAtMs: null,
    rehearsalPausedAtMs: null,
    rehearsalCompletedAtMs: null,
    rehearsalSkippedAtMs: null,
    rehearsalDeferredAtMs: null,
    permissionsCompletedAtMs: null,
    recoveryTutorialCompletedAtMs: null,
    activationStartedAtMs: null,
    activationWithin60s: null,
  };
}

/** 同版本缺字段与 v1 旧对象都走这里；未知字段保留，避免前向数据被静默抹掉。 */
export function onboardingStateFromPersisted(value: unknown): OnboardingState {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const legacyDone = raw.done === true;
  const legacyCaptured = raw.captured === true;
  const legacySent = raw.sent === true;
  const step = STEPS.has(raw.rehearsalStep as OnboardingStep)
    ? raw.rehearsalStep as OnboardingStep
    : legacyDone
      ? "complete"
      : "permissions";
  const completedAt = finiteTime(raw.rehearsalCompletedAtMs);
  const skippedAt = finiteTime(raw.rehearsalSkippedAtMs);
  const deferredAt = finiteTime(raw.rehearsalDeferredAtMs);
  const pausedAt = finiteTime(raw.rehearsalPausedAtMs);
  const startedAt = finiteTime(raw.rehearsalStartedAtMs);
  const sourceVersion = Number.isInteger(raw.onboardingVersion)
    ? raw.onboardingVersion as number
    : null;
  const noteId =
    typeof raw.rehearsalNoteId === "string" && raw.rehearsalNoteId
      ? raw.rehearsalNoteId
      : null;
  const hasSessionProgress =
    startedAt !== null ||
    pausedAt !== null ||
    noteId !== null ||
    finiteTime(raw.permissionsCompletedAtMs) !== null ||
    finiteTime(raw.activationStartedAtMs) !== null ||
    step !== "permissions";
  // v2 的“稍后”曾被写成 done=true/step=complete。没有真实完成时间时，
  // 这些记录只能说明用户退出了演练，不能宣称已经完成。
  const v2FalseCompletion =
    sourceVersion === 2 &&
    completedAt === null &&
    (deferredAt !== null || legacyDone || step === "complete");
  const explicitStatus = REHEARSAL_STATUSES.has(
    raw.rehearsalStatus as RehearsalStatus
  )
    ? raw.rehearsalStatus as RehearsalStatus
    : null;
  let rehearsalStatus: RehearsalStatus = "notStarted";
  if (sourceVersion === ONBOARDING_VERSION && explicitStatus) {
    rehearsalStatus = explicitStatus;
  } else if (completedAt !== null || (sourceVersion !== 2 && legacyDone)) {
    rehearsalStatus = "completed";
  } else if (v2FalseCompletion) {
    rehearsalStatus = "skipped";
  } else if (hasSessionProgress) {
    rehearsalStatus = raw.rehearsalActive === true ? "active" : "paused";
  }
  const completed =
    rehearsalStatus === "completed" ||
    completedAt !== null ||
    (sourceVersion === ONBOARDING_VERSION && legacyDone);
  return {
    ...raw,
    ...defaultOnboardingState(),
    captured: legacyCaptured,
    sent: legacySent,
    done: completed,
    onboardingVersion: ONBOARDING_VERSION,
    rehearsalStatus,
    rehearsalStep:
      rehearsalStatus === "completed"
        ? "complete"
        : v2FalseCompletion
          ? "permissions"
          : step,
    rehearsalActive: rehearsalStatus === "active",
    rehearsalNoteId: noteId,
    rehearsalStartedAtMs: startedAt,
    rehearsalPausedAtMs: pausedAt,
    rehearsalCompletedAtMs: completedAt,
    rehearsalSkippedAtMs:
      skippedAt ?? (v2FalseCompletion ? deferredAt : null),
    rehearsalDeferredAtMs: deferredAt,
    permissionsCompletedAtMs: finiteTime(raw.permissionsCompletedAtMs),
    recoveryTutorialCompletedAtMs: finiteTime(
      raw.recoveryTutorialCompletedAtMs
    ),
    activationStartedAtMs: finiteTime(raw.activationStartedAtMs),
    activationWithin60s:
      typeof raw.activationWithin60s === "boolean"
        ? raw.activationWithin60s
        : null,
  } as OnboardingState;
}

export function onboardingAfter(
  current: OnboardingState,
  event: OnboardingEvent,
  now = Date.now()
): OnboardingState {
  const state = onboardingStateFromPersisted(current);
  const active = state.rehearsalStatus === "active";
  switch (event.type) {
    case "start":
      return {
        ...state,
        rehearsalStatus: "active",
        rehearsalStep: "permissions",
        rehearsalActive: true,
        rehearsalNoteId: null,
        rehearsalStartedAtMs: now,
        rehearsalPausedAtMs: null,
        rehearsalSkippedAtMs: null,
        rehearsalDeferredAtMs: null,
        activationStartedAtMs: null,
        activationWithin60s: null,
      };
    case "resume":
      return state.rehearsalStatus === "paused" || active
        ? {
            ...state,
            rehearsalStatus: "active",
            rehearsalActive: true,
            rehearsalStartedAtMs: state.rehearsalStartedAtMs ?? now,
            rehearsalPausedAtMs: null,
          }
        : state;
    case "pause":
      return active
        ? {
            ...state,
            rehearsalStatus: "paused",
            rehearsalActive: false,
            rehearsalPausedAtMs: now,
          }
        : state;
    case "permissionsReady":
      return active && state.rehearsalStep === "permissions"
        ? {
            ...state,
            rehearsalStep: "capture",
            permissionsCompletedAtMs: state.permissionsCompletedAtMs ?? now,
          }
        : state;
    case "samplePrepared":
      return active && state.rehearsalStep === "capture"
        ? {
            ...state,
            activationStartedAtMs: state.activationStartedAtMs ?? now,
          }
        : state;
    case "sampleCaptured":
      return active && state.rehearsalStep === "capture" && event.noteId
        ? {
            ...state,
            captured: true,
            rehearsalStep: "target",
            rehearsalNoteId: event.noteId,
            activationStartedAtMs: state.activationStartedAtMs ?? now,
          }
        : state;
    case "targetConfirmed":
      return active && state.rehearsalStep === "target" && state.rehearsalNoteId
        ? { ...state, rehearsalStep: "firewall" }
        : state;
    case "preflightOpened":
      return active &&
        ["firewall", "delivery"].includes(state.rehearsalStep) &&
        state.rehearsalNoteId
        ? { ...state, rehearsalStep: "delivery" }
        : state;
    case "deliverySent": {
      if (
        !active ||
        state.rehearsalStep !== "delivery" ||
        !state.rehearsalNoteId
      ) return state;
      const startedAt = state.activationStartedAtMs;
      return {
        ...state,
        sent: true,
        done: true,
        rehearsalStatus: "completed",
        rehearsalStep: "complete",
        rehearsalActive: false,
        rehearsalCompletedAtMs: now,
        rehearsalPausedAtMs: null,
        activationWithin60s:
          startedAt === null
            ? null
            : now - startedAt <= SAFE_REHEARSAL_ACTIVATION_MS,
      };
    }
    case "recoveryTutorialCompleted":
      return {
        ...state,
        recoveryTutorialCompletedAtMs:
          state.recoveryTutorialCompletedAtMs ?? now,
      };
    case "skip":
      return active || state.rehearsalStatus === "paused"
        ? {
            ...state,
            rehearsalStatus: "skipped",
            rehearsalActive: false,
            rehearsalSkippedAtMs: now,
            rehearsalPausedAtMs: null,
            activationWithin60s: null,
          }
        : state;
  }
}

/** “继续”只恢复未完成步骤；已完成或显式重跑都从权限检查重新开始。 */
export function safeRehearsalLaunchEvent(
  current: OnboardingState,
  mode: SafeRehearsalLaunchMode
): OnboardingEvent {
  const state = onboardingStateFromPersisted(current);
  return mode === "resume" &&
    (state.rehearsalStatus === "paused" || state.rehearsalStatus === "active")
    ? { type: "resume" }
    : { type: "start" };
}

export function permissionRehearsalStatus(
  accessibility: boolean,
  installed: boolean,
  receiving: boolean,
  stuck: boolean
): PermissionRehearsalStatus {
  if (!accessibility) return "accessibilityDenied";
  if (!installed) return "tapUnavailable";
  if (receiving) return "ready";
  return stuck ? "inputMonitoringBlocked" : "waitingForEvents";
}

export function isSafeRehearsalText(value: string): boolean {
  return value.trim() === SAFE_REHEARSAL_TEXT;
}

/** 安全锁由 Draft、store 与执行器重复执行，UI 不能把回车重新打开。 */
export function secureRehearsalDraft(draft: DeliveryDraft): DeliveryDraft {
  return {
    ...draft,
    safeRehearsal: true,
    privacyPolicy: "requireRedaction",
    firewallEnabled: true,
    firewallDisabledWarnCategories: [],
    firewallStatus: "idle",
    findings: [],
    enterDecisionConfirmed: true,
    pressEnter: false,
    keepPanel: true,
  };
}
