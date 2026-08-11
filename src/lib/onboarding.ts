import type { DeliveryDraft } from "@/lib/delivery/types";

export const ONBOARDING_VERSION = 2;
export const SAFE_REHEARSAL_ACTIVATION_MS = 60_000;
export const SAFE_REHEARSAL_TEXT =
  "安全演练：请把下面内容概括成一句话，并保留演练邮箱 demo.user@example.com。";

export type OnboardingStep =
  | "permissions"
  | "capture"
  | "target"
  | "firewall"
  | "delivery"
  | "complete";

export interface OnboardingState {
  /** v1 三步引导兼容字段；旧调用仍只更新这三个布尔值。 */
  captured: boolean;
  sent: boolean;
  done: boolean;
  onboardingVersion: number;
  rehearsalStep: OnboardingStep;
  rehearsalActive: boolean;
  rehearsalNoteId: string | null;
  rehearsalStartedAtMs: number | null;
  rehearsalPausedAtMs: number | null;
  rehearsalCompletedAtMs: number | null;
  rehearsalDeferredAtMs: number | null;
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
  | { type: "defer" };

export type PermissionRehearsalStatus =
  | "accessibilityDenied"
  | "tapUnavailable"
  | "waitingForEvents"
  | "inputMonitoringBlocked"
  | "ready";

const STEPS = new Set<OnboardingStep>([
  "permissions",
  "capture",
  "target",
  "firewall",
  "delivery",
  "complete",
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
    rehearsalStep: "permissions",
    rehearsalActive: true,
    rehearsalNoteId: null,
    rehearsalStartedAtMs: null,
    rehearsalPausedAtMs: null,
    rehearsalCompletedAtMs: null,
    rehearsalDeferredAtMs: null,
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
  const current = raw.onboardingVersion === ONBOARDING_VERSION;

  if (!current) {
    return {
      ...raw,
      ...defaultOnboardingState(),
      captured: legacyCaptured,
      sent: legacySent,
      done: legacyDone,
      rehearsalStep: legacyDone ? "complete" : "permissions",
      rehearsalActive: !legacyDone,
    } as OnboardingState;
  }

  const step = STEPS.has(raw.rehearsalStep as OnboardingStep)
    ? raw.rehearsalStep as OnboardingStep
    : legacyDone
      ? "complete"
      : "permissions";
  return {
    ...raw,
    ...defaultOnboardingState(),
    captured: legacyCaptured,
    sent: legacySent,
    done: legacyDone,
    onboardingVersion: ONBOARDING_VERSION,
    rehearsalStep: step,
    rehearsalActive:
      typeof raw.rehearsalActive === "boolean"
        ? raw.rehearsalActive
        : !legacyDone,
    rehearsalNoteId:
      typeof raw.rehearsalNoteId === "string" && raw.rehearsalNoteId
        ? raw.rehearsalNoteId
        : null,
    rehearsalStartedAtMs: finiteTime(raw.rehearsalStartedAtMs),
    rehearsalPausedAtMs: finiteTime(raw.rehearsalPausedAtMs),
    rehearsalCompletedAtMs: finiteTime(raw.rehearsalCompletedAtMs),
    rehearsalDeferredAtMs: finiteTime(raw.rehearsalDeferredAtMs),
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
  switch (event.type) {
    case "start":
      return {
        ...state,
        rehearsalStep: "permissions",
        rehearsalActive: true,
        rehearsalNoteId: null,
        rehearsalStartedAtMs: now,
        rehearsalPausedAtMs: null,
        rehearsalCompletedAtMs: null,
        rehearsalDeferredAtMs: null,
        activationStartedAtMs: null,
        activationWithin60s: null,
      };
    case "resume":
      return {
        ...state,
        rehearsalActive: true,
        rehearsalStartedAtMs: state.rehearsalStartedAtMs ?? now,
        rehearsalPausedAtMs: null,
      };
    case "pause":
      return {
        ...state,
        rehearsalActive: false,
        rehearsalPausedAtMs: now,
      };
    case "permissionsReady":
      return state.rehearsalStep === "permissions"
        ? { ...state, rehearsalStep: "capture" }
        : state;
    case "samplePrepared":
      return {
        ...state,
        activationStartedAtMs: state.activationStartedAtMs ?? now,
      };
    case "sampleCaptured":
      return {
        ...state,
        captured: true,
        rehearsalStep: "target",
        rehearsalNoteId: event.noteId,
        activationStartedAtMs: state.activationStartedAtMs ?? now,
      };
    case "targetConfirmed":
      return state.rehearsalNoteId
        ? { ...state, rehearsalStep: "firewall" }
        : state;
    case "preflightOpened":
      return state.rehearsalNoteId
        ? { ...state, rehearsalStep: "delivery" }
        : state;
    case "deliverySent": {
      const startedAt = state.activationStartedAtMs;
      return {
        ...state,
        sent: true,
        done: true,
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
    case "defer":
      return {
        ...state,
        done: true,
        rehearsalStep: "complete",
        rehearsalActive: false,
        rehearsalDeferredAtMs: now,
        rehearsalPausedAtMs: null,
        activationWithin60s: null,
      };
  }
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
