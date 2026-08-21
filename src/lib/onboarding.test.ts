import { describe, expect, it } from "vitest";

import type { DeliveryDraft } from "@/lib/delivery/types";
import {
  ONBOARDING_VERSION,
  SAFE_REHEARSAL_TEXT,
  onboardingAfter,
  onboardingStateFromPersisted,
  permissionRehearsalStatus,
  safeRehearsalLaunchEvent,
  secureRehearsalDraft,
} from "./onboarding";

describe("安全发送演练状态机", () => {
  it("旧版已完成用户迁移后保持完成且不强制重跑", () => {
    expect(
      onboardingStateFromPersisted({ captured: true, sent: true, done: true })
    ).toMatchObject({
      onboardingVersion: ONBOARDING_VERSION,
      rehearsalStatus: "completed",
      rehearsalStep: "complete",
      rehearsalActive: false,
      captured: true,
      sent: true,
      done: true,
    });
  });

  it("新用户默认不启动示例，只有主动开始才激活", () => {
    const initial = onboardingStateFromPersisted(undefined);
    expect(initial).toMatchObject({
      done: false,
      rehearsalStatus: "notStarted",
      rehearsalActive: false,
    });
    expect(onboardingAfter(initial, { type: "start" }, 500)).toMatchObject({
      done: false,
      rehearsalStatus: "active",
      rehearsalActive: true,
      rehearsalStartedAtMs: 500,
    });
  });

  it("把 v2 defer 的错误完成态迁移为已跳过", () => {
    expect(onboardingStateFromPersisted({
      onboardingVersion: 2,
      captured: false,
      sent: false,
      done: true,
      rehearsalStep: "complete",
      rehearsalActive: false,
      rehearsalDeferredAtMs: 9_000,
      rehearsalCompletedAtMs: null,
    })).toMatchObject({
      onboardingVersion: ONBOARDING_VERSION,
      done: false,
      rehearsalStatus: "skipped",
      rehearsalStep: "permissions",
      rehearsalActive: false,
      rehearsalSkippedAtMs: 9_000,
      rehearsalCompletedAtMs: null,
    });

    expect(onboardingStateFromPersisted({
      onboardingVersion: 2,
      captured: false,
      sent: false,
      done: false,
      rehearsalStep: "target",
      rehearsalActive: false,
      rehearsalStartedAtMs: 1_000,
      rehearsalNoteId: "sample-note",
    })).toMatchObject({
      rehearsalStatus: "paused",
      rehearsalStep: "target",
      rehearsalNoteId: "sample-note",
    });
  });

  it("新用户可暂停并从原步骤恢复，不重置示例卡片", () => {
    const initial = onboardingAfter(
      onboardingStateFromPersisted(undefined),
      { type: "start" },
      500
    );
    const ready = onboardingAfter(initial, { type: "permissionsReady" }, 1_000);
    const captured = onboardingAfter(
      ready,
      { type: "sampleCaptured", noteId: "sample-note" },
      2_000
    );
    const paused = onboardingAfter(captured, { type: "pause" }, 3_000);
    const resumed = onboardingAfter(paused, { type: "resume" }, 9_000);

    expect(paused).toMatchObject({
      rehearsalStep: "target",
      rehearsalStatus: "paused",
      rehearsalActive: false,
      rehearsalNoteId: "sample-note",
      rehearsalPausedAtMs: 3_000,
    });
    expect(resumed).toMatchObject({
      rehearsalStep: "target",
      rehearsalStatus: "active",
      rehearsalActive: true,
      rehearsalNoteId: "sample-note",
      rehearsalPausedAtMs: null,
    });
  });

  it("权限拒绝、tap 未安装、观察期、事件流拦截和就绪互不混淆", () => {
    expect(permissionRehearsalStatus(false, false, false, false)).toBe(
      "accessibilityDenied"
    );
    expect(permissionRehearsalStatus(true, false, false, false)).toBe(
      "tapUnavailable"
    );
    expect(permissionRehearsalStatus(true, true, false, false)).toBe(
      "waitingForEvents"
    );
    expect(permissionRehearsalStatus(true, true, false, true)).toBe(
      "inputMonitoringBlocked"
    );
    expect(permissionRehearsalStatus(true, true, true, false)).toBe("ready");
  });

  it("60 秒只记录权限后的安全发送激活，不展示或把稍后演练判失败", () => {
    const active = onboardingAfter(
      onboardingStateFromPersisted(undefined),
      { type: "start" },
      500
    );
    const start = onboardingAfter(
      active,
      { type: "permissionsReady" },
      1_000
    );
    const prepared = onboardingAfter(start, { type: "samplePrepared" }, 10_000);
    const captured = onboardingAfter(
      prepared,
      { type: "sampleCaptured", noteId: "sample-note" },
      11_000
    );
    const targeted = onboardingAfter(captured, { type: "targetConfirmed" }, 12_000);
    const preflight = onboardingAfter(targeted, { type: "preflightOpened" }, 13_000);
    const delivered = onboardingAfter(
      preflight,
      { type: "deliverySent" },
      69_999
    );
    expect(delivered).toMatchObject({
      done: true,
      rehearsalStatus: "completed",
      rehearsalActive: false,
      rehearsalStep: "complete",
      activationWithin60s: true,
      recoveryTutorialCompletedAtMs: null,
    });

    const skipped = onboardingAfter(start, { type: "skip" }, 999_000);
    expect(skipped).toMatchObject({
      done: false,
      rehearsalStatus: "skipped",
      rehearsalActive: false,
      rehearsalSkippedAtMs: 999_000,
      rehearsalCompletedAtMs: null,
      activationWithin60s: null,
    });
  });

  it("安全发送与本地恢复教学分开完成，重跑不清空任务成就", () => {
    const initial = onboardingAfter(
      onboardingStateFromPersisted(undefined),
      { type: "start" },
      500
    );
    const ready = onboardingAfter(initial, { type: "permissionsReady" }, 1_000);
    const captured = onboardingAfter(
      ready,
      { type: "sampleCaptured", noteId: "sample-note" },
      1_100
    );
    const targeted = onboardingAfter(captured, { type: "targetConfirmed" }, 1_200);
    const preflight = onboardingAfter(targeted, { type: "preflightOpened" }, 1_300);
    const delivered = onboardingAfter(preflight, { type: "deliverySent" }, 2_000);
    const recovered = onboardingAfter(
      delivered,
      { type: "recoveryTutorialCompleted" },
      3_000
    );
    const restarted = onboardingAfter(recovered, { type: "start" }, 4_000);

    expect(ready.permissionsCompletedAtMs).toBe(1_000);
    expect(delivered.recoveryTutorialCompletedAtMs).toBeNull();
    expect(recovered.recoveryTutorialCompletedAtMs).toBe(3_000);
    expect(restarted).toMatchObject({
      done: true,
      rehearsalStatus: "active",
      rehearsalStep: "permissions",
      rehearsalCompletedAtMs: 2_000,
      permissionsCompletedAtMs: 1_000,
      recoveryTutorialCompletedAtMs: 3_000,
    });
  });

  it("继续保留未完成步骤，完成后再次进入则重开演练", () => {
    const initial = onboardingAfter(
      onboardingStateFromPersisted(undefined),
      { type: "start" },
      500
    );
    const ready = onboardingAfter(initial, { type: "permissionsReady" }, 750);
    const captured = onboardingAfter(
      ready,
      { type: "sampleCaptured", noteId: "sample-note" },
      1_000
    );
    const targeted = onboardingAfter(captured, { type: "targetConfirmed" }, 1_200);
    const preflight = onboardingAfter(targeted, { type: "preflightOpened" }, 1_400);
    const complete = onboardingAfter(preflight, { type: "deliverySent" }, 2_000);

    expect(safeRehearsalLaunchEvent(captured, "resume")).toEqual({
      type: "resume",
    });
    expect(safeRehearsalLaunchEvent(complete, "resume")).toEqual({
      type: "start",
    });
    expect(safeRehearsalLaunchEvent(captured, "start")).toEqual({
      type: "start",
    });
  });

  it("未启动或步骤不匹配时，演练事件不会改写进度", () => {
    const initial = onboardingStateFromPersisted(undefined);
    expect(onboardingAfter(initial, { type: "permissionsReady" }, 1_000))
      .toEqual(initial);
    expect(onboardingAfter(initial, {
      type: "sampleCaptured",
      noteId: "unexpected",
    }, 1_000)).toEqual(initial);
    expect(onboardingAfter(initial, { type: "deliverySent" }, 1_000))
      .toEqual(initial);
    expect(onboardingAfter(initial, { type: "skip" }, 1_000)).toEqual(initial);

    const active = onboardingAfter(initial, { type: "start" }, 2_000);
    expect(onboardingAfter(active, { type: "targetConfirmed" }, 3_000))
      .toEqual(active);
  });

  it("演练 Draft 在任何发送方案下都锁定不按回车并保留面板", () => {
    const secured = secureRehearsalDraft({
      enterPolicy: "allow",
      enterDecisionConfirmed: false,
      pressEnter: true,
      keepPanel: false,
    } as DeliveryDraft);

    expect(secured).toMatchObject({
      safeRehearsal: true,
      privacyPolicy: "requireRedaction",
      firewallEnabled: true,
      firewallDisabledWarnCategories: [],
      firewallStatus: "idle",
      enterDecisionConfirmed: true,
      pressEnter: false,
      keepPanel: true,
    });
    expect(SAFE_REHEARSAL_TEXT).toContain("demo.user@example.com");
  });
});
