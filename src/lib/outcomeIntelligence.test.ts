import { describe, expect, it } from "vitest";

import type { DeliveryEvent } from "./deliveryActivityCore";
import {
  aggregateOutcomeMetrics,
  cancelProblemSession,
  linkProblemSession,
  normalizeOutcomeBaselines,
  normalizeProblemSessions,
  solveProblemSession,
  startProblemSession,
  upsertQualityFeedback,
  type OutcomeBaseline,
  type OutcomeProblemSession,
} from "./outcomeIntelligence";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 7, 11, 4);

function event(
  eventType: DeliveryEvent["eventType"],
  timestampMs: number,
  overrides: Partial<DeliveryEvent> = {}
): DeliveryEvent {
  const status: Record<DeliveryEvent["eventType"], DeliveryEvent["status"]> = {
    draftCreated: "prepared",
    preflightOpened: "opened",
    firewallBlocked: "blocked",
    sendStarted: "started",
    sendSent: "sent",
    sendBlocked: "blocked",
    sendFailed: "failed",
    clipboardRestored: "restored",
    clipboardSkipped: "skipped",
    resultCaptured: "captured",
    resultVerified: "verified",
  };
  return {
    eventId: `${eventType}-${timestampMs}-${overrides.deliveryId ?? "d1"}`,
    deliveryId: "d1",
    eventType,
    timestampMs,
    sourceKind: "note",
    sourceItemIds: ["source-1"],
    targetBundleId: "com.example.target",
    targetAppName: "Target",
    profileId: "profile-a",
    status: status[eventType],
    reasonCode: null,
    durationMs: null,
    textCharCount: 12,
    imageCount: 0,
    firewallCounts: {
      privateKey: 0,
      authorization: 0,
      apiKey: 0,
      databaseUrl: 0,
      email: 0,
      phone: 0,
      nationalId: 0,
      bankCard: 0,
      ipAddress: 0,
      cookie: 0,
      session: 0,
    },
    redactionCount: 0,
    clipboardOutcome: null,
    resultNoteId: null,
    verificationStatus: null,
    verificationCheckCount: null,
    verificationIssueCount: null,
    metricsEligible: true,
    transformRecipeId: null,
    ...overrides,
  };
}

describe("Outcome Intelligence 聚合器", () => {
  it("准确计算成功率、中位耗时、原因、Firewall、剪贴板、重试与核验分布", () => {
    const events: DeliveryEvent[] = [
      event("draftCreated", NOW - 9_000),
      event("sendStarted", NOW - 8_000),
      event("sendStarted", NOW - 7_500),
      event("sendSent", NOW - 7_000, {
        firewallCounts: { ...event("sendSent", NOW).firewallCounts, email: 2 },
        redactionCount: 2,
      }),
      event("clipboardRestored", NOW - 6_900, { clipboardOutcome: "restored" }),
      event("resultCaptured", NOW - 2_000, { resultNoteId: "result-1" }),
      event("resultVerified", NOW - 1_000, {
        resultNoteId: "result-1",
        verificationStatus: "needsReview",
        verificationCheckCount: 4,
        verificationIssueCount: 1,
      }),
      event("draftCreated", NOW - 6_000, { deliveryId: "d2" }),
      event("sendStarted", NOW - 4_000, { deliveryId: "d2" }),
      event("sendBlocked", NOW - 3_000, {
        deliveryId: "d2",
        reasonCode: "target-not-ready",
      }),
      event("clipboardSkipped", NOW - 2_900, {
        deliveryId: "d2",
        clipboardOutcome: "skippedUserChanged",
      }),
      event("sendFailed", NOW - 500, {
        deliveryId: "d3",
        reasonCode: "paste_failed",
      }),
    ];

    const metrics = aggregateOutcomeMetrics(events, [], [], [], {
      range: "7d",
      nowMs: NOW,
      timeZone: "Asia/Shanghai",
      profileId: null,
      recipeId: null,
    });

    expect(metrics.deliveryAttempts).toBe(3);
    expect(metrics.sentCount).toBe(1);
    expect(metrics.successRate).toBeCloseTo(1 / 3);
    expect(metrics.blockedReasons).toEqual({ "target-not-ready": 1 });
    expect(metrics.failedReasons).toEqual({ paste_failed: 1 });
    expect(metrics.targetInvalidationBlocks).toBe(1);
    expect(metrics.firewallFindingCount).toBe(2);
    expect(metrics.redactionCount).toBe(2);
    expect(metrics.clipboardOutcomes).toMatchObject({
      restored: 1,
      skippedUserChanged: 1,
    });
    expect(metrics.draftToSendMedianMs).toBe(2_000);
    expect(metrics.sendToResultMedianMs).toBe(5_000);
    expect(metrics.retryCount).toBe(1);
    expect(metrics.verificationStatuses.needsReview).toBe(1);
    expect(metrics.sampleSize).toBe(3);
    expect(metrics.insufficientSample).toBe(true);
  });

  it("把图片 Firewall 阻止计入终态，并识别跨 deliveryId 的重新准备", () => {
    const events: DeliveryEvent[] = [
      event("draftCreated", NOW - 5_000, { deliveryId: "blocked-image" }),
      event("firewallBlocked", NOW - 4_000, {
        deliveryId: "blocked-image",
        reasonCode: "privacy_gate_blocked",
        firewallCounts: {
          ...event("firewallBlocked", NOW).firewallCounts,
          nationalId: 2,
        },
        redactionCount: 1,
      }),
      event("draftCreated", NOW - 3_000, {
        deliveryId: "retry-image",
        reasonCode: "retry-prepared",
      }),
      event("sendStarted", NOW - 2_000, { deliveryId: "retry-image" }),
      event("sendFailed", NOW - 1_000, {
        deliveryId: "retry-image",
        reasonCode: "paste_failed",
      }),
    ];

    const metrics = aggregateOutcomeMetrics(events, [], [], [], {
      range: "7d",
      nowMs: NOW,
      timeZone: "Asia/Shanghai",
      profileId: null,
      recipeId: null,
    });

    expect(metrics.deliveryAttempts).toBe(2);
    expect(metrics.blockedReasons).toEqual({ privacy_gate_blocked: 1 });
    expect(metrics.failedReasons).toEqual({ paste_failed: 1 });
    expect(metrics.firewallFindingCount).toBe(2);
    expect(metrics.redactionCount).toBe(1);
    expect(metrics.retryCount).toBe(1);
  });

  it("按本地日历范围、Profile 与已应用 recipe 过滤，关闭时事件不进入指标", () => {
    const insideShanghaiDay = Date.UTC(2026, 7, 4, 16, 30);
    const beforeShanghaiDay = Date.UTC(2026, 7, 4, 15, 59);
    const events = [
      event("sendSent", insideShanghaiDay, {
        deliveryId: "inside",
        profileId: "profile-a",
        transformRecipeId: "summarize",
      }),
      event("sendSent", beforeShanghaiDay, {
        deliveryId: "outside",
        profileId: "profile-a",
        transformRecipeId: "summarize",
      }),
      event("sendSent", NOW - DAY, {
        deliveryId: "other-profile",
        profileId: "profile-b",
        transformRecipeId: "summarize",
      }),
      event("sendSent", NOW - DAY, {
        deliveryId: "other-recipe",
        profileId: "profile-a",
        transformRecipeId: "extract-actions",
      }),
      event("sendSent", NOW - DAY, {
        deliveryId: "opted-out",
        profileId: "profile-a",
        transformRecipeId: "summarize",
        metricsEligible: false,
      }),
    ];

    const metrics = aggregateOutcomeMetrics(events, [], [], [], {
      range: "7d",
      nowMs: NOW,
      timeZone: "Asia/Shanghai",
      profileId: "profile-a",
      recipeId: "summarize",
    });
    expect(metrics.deliveryAttempts).toBe(1);
    expect(metrics.dailyTrend.map((day) => day.day)).toContain("2026-08-05");
  });

  it("清除时间边界忽略旧指标但不要求删除原始活动事件", () => {
    const events = [
      event("sendSent", NOW - 2_000, { deliveryId: "before-clear" }),
      event("sendSent", NOW - 500, { deliveryId: "after-clear", metricsEpoch: 1 }),
    ];

    const metrics = aggregateOutcomeMetrics(events, [], [], [], {
      range: "all",
      nowMs: NOW,
      timeZone: "UTC",
      profileId: null,
      recipeId: null,
      metricsEpoch: 1,
    });

    expect(events).toHaveLength(2);
    expect(metrics.deliveryAttempts).toBe(1);
    expect(metrics.sentCount).toBe(1);
  });

  it("零样本不制造百分比或趋势结论，损坏记录和正文 getter 不会让 dashboard 崩溃", () => {
    const safe = event("sendSent", NOW);
    Object.defineProperty(safe, "rawText", {
      get() {
        throw new Error("聚合器读取了正文");
      },
    });
    const metrics = aggregateOutcomeMetrics(
      [null, { eventType: "unknown" }, safe] as unknown as DeliveryEvent[],
      [],
      [],
      [],
      { range: "30d", nowMs: NOW, timeZone: "UTC", profileId: null, recipeId: null }
    );
    expect(metrics.deliveryAttempts).toBe(1);
    expect(metrics.successRate).toBe(1);

    const empty = aggregateOutcomeMetrics([], [], [], [], {
      range: "all",
      nowMs: NOW,
      timeZone: "UTC",
      profileId: null,
      recipeId: null,
    });
    expect(empty.successRate).toBeNull();
    expect(empty.dailyTrend).toEqual([]);
    expect(empty.trendConclusion).toBeNull();
  });

  it("偶数样本中位数取中间平均，recipe 只由最终发送正文归因", () => {
    const events = [
      event("draftCreated", NOW - 10_000, {
        deliveryId: "d1",
        profileId: "profile-before-rebase",
        transformRecipeId: null,
      }),
      event("sendStarted", NOW - 9_500, { deliveryId: "d1", transformRecipeId: "summarize" }),
      event("sendSent", NOW - 9_000, { deliveryId: "d1", transformRecipeId: "summarize" }),
      event("draftCreated", NOW - 8_000, { deliveryId: "d2", transformRecipeId: null }),
      event("sendSent", NOW - 5_000, { deliveryId: "d2", transformRecipeId: "summarize" }),
    ];

    const metrics = aggregateOutcomeMetrics(events, [], [], [], {
      range: "all",
      nowMs: NOW,
      timeZone: "UTC",
      profileId: "profile-a",
      recipeId: "summarize",
    });

    expect(metrics.deliveryAttempts).toBe(2);
    expect(metrics.draftToSendMedianMs).toBe(2_000);
  });

  it("无有效人工基线时不估算；recipe 基线优先且估算与实测分开", () => {
    const events = [
      event("draftCreated", NOW - 10 * 60_000),
      event("sendSent", NOW - 9 * 60_000, { transformRecipeId: "summarize" }),
      event("resultCaptured", NOW - 5 * 60_000, {
        transformRecipeId: "summarize",
        resultNoteId: "result-1",
      }),
    ];
    const options = {
      range: "7d" as const,
      nowMs: NOW,
      timeZone: "UTC",
      profileId: null,
      recipeId: null,
    };
    expect(aggregateOutcomeMetrics(events, [], [], [], options).estimatedTimeSavedMs).toBeNull();

    const baselines: OutcomeBaseline[] = [
      { scope: "profile", scopeId: "profile-a", minutes: 20 },
      { scope: "recipe", scopeId: "summarize", minutes: 8 },
    ];
    const metrics = aggregateOutcomeMetrics(events, [], [], baselines, options);
    expect(metrics.actualWorkflowMedianMs).toBe(5 * 60_000);
    expect(metrics.estimatedTimeSavedMs).toBe(3 * 60_000);
    expect(metrics.estimatedSampleSize).toBe(1);
  });

  it("结果改绑后不把旧结果的质量反馈归到新结果", () => {
    const events = [
      event("sendSent", NOW - 3_000),
      event("resultCaptured", NOW - 2_000, { resultNoteId: "result-old" }),
      event("resultCaptured", NOW - 1_000, { resultNoteId: "result-current" }),
    ];
    const options = {
      range: "all" as const,
      nowMs: NOW,
      timeZone: "UTC",
      profileId: null,
      recipeId: null,
    };
    const oldFeedback = aggregateOutcomeMetrics(events, [{
      deliveryId: "d1",
      resultNoteId: "result-old",
      quality: "directUse",
      updatedAtMs: NOW - 500,
    }], [], [], options);
    expect(oldFeedback.qualityFeedback.directUse).toBe(0);

    const currentFeedback = aggregateOutcomeMetrics(events, [{
      deliveryId: "d1",
      resultNoteId: "result-current",
      quality: "minorEdit",
      updatedAtMs: NOW - 500,
    }], [], [], options);
    expect(currentFeedback.qualityFeedback.minorEdit).toBe(1);
  });
});

describe("Outcome Intelligence 用户输入状态", () => {
  it("基线拒绝零值、负值、异常大值、重复项并保留合法 profile/recipe", () => {
    expect(normalizeOutcomeBaselines([
      { scope: "profile", scopeId: "p", minutes: 0 },
      { scope: "profile", scopeId: "p", minutes: -1 },
      { scope: "recipe", scopeId: "summarize", minutes: 10_081 },
      { scope: "profile", scopeId: "p", minutes: 12 },
      { scope: "profile", scopeId: "p", minutes: 15 },
      { scope: "recipe", scopeId: "summarize", minutes: 8 },
    ])).toEqual([
      { scope: "profile", scopeId: "p", minutes: 15 },
      { scope: "recipe", scopeId: "summarize", minutes: 8 },
    ]);
  });

  it("质量反馈按 delivery 更新且有界", () => {
    const first = upsertQualityFeedback([], {
      deliveryId: "d1",
      resultNoteId: "r1",
      quality: "directUse",
      updatedAtMs: 1,
    });
    const updated = upsertQualityFeedback(first, {
      deliveryId: "d1",
      resultNoteId: "r1",
      quality: "minorEdit",
      updatedAtMs: 2,
    });
    expect(updated).toEqual([{
      deliveryId: "d1",
      resultNoteId: "r1",
      quality: "minorEdit",
      updatedAtMs: 2,
    }]);
  });

  it("问题会话只允许开始→关联→解决或取消，并计算真实耗时", () => {
    let sessions = startProblemSession([], { id: "s1", startedAtMs: 100 });
    sessions = linkProblemSession(sessions, "s1", "d1", 120, "result-1");
    sessions = solveProblemSession(sessions, "s1", 400);
    expect(sessions[0]).toMatchObject({
      id: "s1",
      deliveryId: "d1",
      resultNoteId: "result-1",
      startedAtMs: 100,
      solvedAtMs: 400,
    });

    const unchanged = cancelProblemSession(sessions, "s1", 500);
    expect(unchanged).toEqual(sessions);
    const cancelled = cancelProblemSession(
      startProblemSession(sessions, { id: "s2", startedAtMs: 600 }),
      "s2",
      800
    );
    expect(cancelled.find((item: OutcomeProblemSession) => item.id === "s2"))
      .toMatchObject({ cancelledAtMs: 800, solvedAtMs: null });

    const epochSolved = solveProblemSession(
      startProblemSession([], { id: "epoch", startedAtMs: 0 }),
      "epoch",
      0
    );
    expect(startProblemSession(epochSolved, { id: "after-epoch", startedAtMs: 1 }))
      .toHaveLength(2);
    expect(normalizeProblemSessions([{
      id: "corrupt-link",
      startedAtMs: 1,
      deliveryId: "d1",
      resultNoteId: null,
      linkedAtMs: null,
      solvedAtMs: null,
      cancelledAtMs: null,
    }])).toEqual([]);
  });
});
