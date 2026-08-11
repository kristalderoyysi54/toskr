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
      rehearsalStep: "complete",
      rehearsalActive: false,
      captured: true,
      sent: true,
      done: true,
    });
  });

  it("新用户可暂停并从原步骤恢复，不重置示例卡片", () => {
    const initial = onboardingStateFromPersisted(undefined);
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
      rehearsalActive: false,
      rehearsalNoteId: "sample-note",
      rehearsalPausedAtMs: 3_000,
    });
    expect(resumed).toMatchObject({
      rehearsalStep: "target",
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
    const start = onboardingAfter(
      onboardingStateFromPersisted(undefined),
      { type: "permissionsReady" },
      1_000
    );
    const prepared = onboardingAfter(start, { type: "samplePrepared" }, 10_000);
    const delivered = onboardingAfter(prepared, { type: "deliverySent" }, 69_999);
    expect(delivered).toMatchObject({
      done: true,
      rehearsalActive: false,
      rehearsalStep: "complete",
      activationWithin60s: true,
      recoveryTutorialCompletedAtMs: null,
    });

    const deferred = onboardingAfter(start, { type: "defer" }, 999_000);
    expect(deferred.activationWithin60s).toBeNull();
    expect(deferred.rehearsalDeferredAtMs).toBe(999_000);
  });

  it("安全发送与本地恢复教学分开完成，重跑不清空任务成就", () => {
    const initial = onboardingStateFromPersisted(undefined);
    const ready = onboardingAfter(initial, { type: "permissionsReady" }, 1_000);
    const delivered = onboardingAfter(ready, { type: "deliverySent" }, 2_000);
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
      rehearsalStep: "permissions",
      permissionsCompletedAtMs: 1_000,
      recoveryTutorialCompletedAtMs: 3_000,
    });
  });

  it("继续保留未完成步骤，完成后再次进入则重开演练", () => {
    const initial = onboardingStateFromPersisted(undefined);
    const captured = onboardingAfter(
      initial,
      { type: "sampleCaptured", noteId: "sample-note" },
      1_000
    );
    const complete = onboardingAfter(captured, { type: "deliverySent" }, 2_000);

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
