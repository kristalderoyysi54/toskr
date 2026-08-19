import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryEvent as DeliveryEventShape } from "./deliveryActivityCore";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

const { appendDeliveryEvent, getRecentDeliveryEvents, refreshTargetSnapshot, sendDelivery } = vi.hoisted(() => ({
  appendDeliveryEvent: vi.fn<(
    event: DeliveryEventShape,
    retentionDays?: number
  ) => Promise<void>>(
    async () => undefined
  ),
  getRecentDeliveryEvents: vi.fn<(
    limit: number,
    retentionDays?: number
  ) => Promise<DeliveryEventShape[]>>(
    async () => []
  ),
  refreshTargetSnapshot: vi.fn(),
  sendDelivery: vi.fn(),
}));
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      appendDeliveryEvent,
      getRecentDeliveryEvents,
      refreshTargetSnapshot,
      sendDelivery,
    },
  };
});

import {
  deliveryActivityRecords,
  deliveryEventFromDraft,
  flushDeliveryActivityWrites,
  getRecentDeliveryEventsCached,
  invalidateDeliveryActivityCache,
  reprepareDeliveryEvent,
  type DeliveryEvent,
} from "./deliveryActivity";
import type { DeliveryDraft } from "./delivery/types";
import {
  executeDeliveryDraft,
  nextDeliveryDraftRevision,
  resetDeliveryDraftSession,
} from "./delivery/executeDraft";
import { resetDeliveryStore, useDeliveryStore } from "@/store/deliveryStore";
import { useDataOperationStore } from "@/store/dataOperationStore";
import {
  defaultSettings,
  INBOX_ID,
  TASK_INBOX_ID,
  useNotesStore,
} from "@/store/notesStore";
import { resetTargetState, useTargetStore } from "@/store/targetStore";
import type { TargetSnapshot } from "./tauri";
import {
  clearDeliveryRedactionSessions,
  deliveryRedactionMapAvailable,
} from "./resultReturn";

const oldTarget: TargetSnapshot = {
  token: "old-secret-token",
  pid: 10,
  bundleId: "com.old.target",
  appName: "Old Target",
  launchedAtMs: 1,
  capturedAtMs: 2,
  revision: 1,
  ready: true,
  reason: null,
  windowId: null,
};

const refreshedTarget: TargetSnapshot = {
  ...oldTarget,
  token: "fresh-token",
  pid: 20,
  bundleId: "com.openai.codex",
  appName: "Codex",
  launchedAtMs: 3,
  capturedAtMs: 4,
  revision: 2,
};

function draft(overrides: Partial<DeliveryDraft> = {}): DeliveryDraft {
  return {
    id: "delivery-1",
    revision: nextDeliveryDraftRevision(),
    createdAtMs: 1,
    sourceKind: "note",
    sourceItemIds: ["note-1"],
    selectionItemIds: ["note-1"],
    rawText: "secret raw body",
    sourceTextOverride: null,
    assembledText: "prompt secret raw body",
    finalText: "redacted body",
    originalImageFiles: ["/secret/image.png"],
    segments: null,
    imageFiles: ["/secret/image.png"],
    imageFirewall: [{
      originalFile: "/secret/image.png",
      sendFile: "/secret/image.png",
      status: "ready",
      pixelHash: null,
      redactedPixelHash: null,
      width: null,
      height: null,
      scanRevision: 1,
      findings: [{
        id: "image-region-secret",
        observationIndex: 0,
        category: "email",
        severity: "warn",
        boundingBox: { x: 0.123, y: 0.456, width: 0.2, height: 0.1 },
        pixelBox: { x: 12, y: 45, width: 20, height: 10 },
        maskedPreview: "ocr-secret-preview",
        ruleId: "ocr-rule-secret",
      }],
      redactedFindingIds: ["image-region-secret"],
      rawConfirmation: null,
      failureMessage: null,
    }],
    format: "plain",
    promptSnippetId: "snippet-secret",
    transformRecipeId: null,
    promptSnippetGroupId: "general",
    promptTemplate: "secret prompt",
    targetSnapshot: oldTarget,
    targetProfileId: "safe",
    promptGroupId: "general",
    profileSource: "exact",
    profileDefaultFormat: "plain",
    profileKeepPanel: false,
    privacyPolicy: "requireRedaction",
    firewallEnabled: true,
    firewallDisabledWarnCategories: [],
    firewallStatus: "ready",
    findings: [
      {
        id: "finding-secret",
        category: "apiKey",
        severity: "block",
        startUtf16: 0,
        endUtf16: 6,
        maskedPreview: "sk-***secret",
        suggestedPlaceholder: "[API_KEY]",
        ruleId: "rule-secret",
      },
    ],
    redactionMap: { "sk-secret": "[API_KEY_01]" },
    aliasReplacedCount: 0,
    scanRevision: 1,
    privacyDecision: {
      excludedFindingIds: [],
      rawConfirmation: null,
      replacedCount: 1,
    },
    enterPolicy: "never",
    enterDecisionConfirmed: true,
    pressEnter: false,
    keepPanel: false,
    warnings: [],
    dataGeneration: 0,
    ...overrides,
  };
}

function failedEvent(overrides: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    eventId: "event-failed",
    deliveryId: "delivery-old",
    eventType: "sendFailed",
    timestampMs: 1,
    sourceKind: "note",
    sourceItemIds: ["note-1"],
    targetBundleId: "com.old.target",
    targetAppName: "Old Target",
    profileId: "safe",
    status: "failed",
    reasonCode: "paste_failed",
    durationMs: 10,
    textCharCount: 99,
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
    clipboardOutcome: "notOwned",
    resultNoteId: null,
    ...overrides,
  };
}

describe("delivery activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDeliveryRedactionSessions();
    resetDeliveryDraftSession();
    resetDeliveryStore();
    resetTargetState();
    useDataOperationStore.setState({ locked: false, phase: "idle", message: "" });
    useNotesStore.setState({
      sections: [{ id: INBOX_ID, name: "收件箱" }],
      notes: [],
      tasks: [],
      taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }],
      checkedIds: [],
      settings: defaultSettings(),
      undoStack: [],
    });
    useTargetStore.setState({ snapshot: oldTarget, status: "ready", reason: null });
  });

  afterEach(async () => {
    await flushDeliveryActivityWrites();
  });

  it("500 条活动记录聚合保持有界且顺序稳定", () => {
    const events = Array.from({ length: 500 }, (_, index) => failedEvent({
      eventId: `event-${index}`,
      deliveryId: `delivery-${index}`,
      timestampMs: index,
    }));
    const startedAt = performance.now();

    const records = deliveryActivityRecords(events);
    const elapsedMs = performance.now() - startedAt;

    expect(records).toHaveLength(500);
    expect(records[0].deliveryId).toBe("delivery-499");
    expect(records.at(-1)?.deliveryId).toBe("delivery-0");
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("仅生成白名单元数据，不泄露正文、Prompt、路径、finding 或目标 token", () => {
    const event = deliveryEventFromDraft(
      draft({ transformRecipeId: "summarize" }),
      "sendStarted",
      {
      eventId: "event-1",
      timestampMs: 10,
      status: "started",
      }
    );
    const serialized = JSON.stringify(event);

    expect(Object.keys(event).sort()).toEqual([
      "clipboardOutcome",
      "deliveryId",
      "durationMs",
      "eventId",
      "eventType",
      "firewallCounts",
      "imageCount",
      "metricsEligible",
      "metricsEpoch",
      "profileId",
      "reasonCode",
      "redactionCount",
      "resultNoteId",
      "sourceItemIds",
      "sourceKind",
      "status",
      "targetAppName",
      "targetBundleId",
      "textCharCount",
      "timestampMs",
      "transformRecipeId",
      "verificationCheckCount",
      "verificationIssueCount",
      "verificationStatus",
    ].sort());
    expect(event.firewallCounts.apiKey).toBe(1);
    expect(event.firewallCounts.email).toBe(1);
    expect(event.redactionCount).toBe(2);
    expect(event.textCharCount).toBe("redacted body".length);
    expect(event.transformRecipeId).toBe("summarize");
    for (const forbidden of [
      "secret raw body",
      "secret prompt",
      "/secret/image.png",
      "sk-***secret",
      "old-secret-token",
      "snippet-secret",
      "rule-secret",
      "ocr-secret-preview",
      "ocr-rule-secret",
      "0.123",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("关闭成效度量后只写恢复账本标记，并按设置传递保留期", async () => {
    useNotesStore.setState((state) => ({
      settings: {
        ...state.settings,
        outcomeMetricsEnabled: false,
        outcomeRetentionDays: 90,
      },
    }));
    const core = await import("./deliveryActivityCore");

    await core.recordDeliveryEvent(failedEvent());
    await core.getRecentDeliveryEvents(40);

    expect(appendDeliveryEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metricsEligible: false }),
      90
    );
    expect(getRecentDeliveryEvents).toHaveBeenCalledWith(40, 90);
  });

  it("捕获 HUD 的短 TTL 查询复用内存结果，新增事件会立即失效缓存", async () => {
    getRecentDeliveryEvents.mockResolvedValue([failedEvent()]);
    await getRecentDeliveryEventsCached(100, 60_000);
    await getRecentDeliveryEventsCached(100, 60_000);
    expect(getRecentDeliveryEvents).toHaveBeenCalledOnce();

    await import("./deliveryActivityCore").then(({ recordDeliveryEvent }) =>
      recordDeliveryEvent(failedEvent({ eventId: "new-event" }))
    );
    await getRecentDeliveryEventsCached(100, 60_000);
    expect(getRecentDeliveryEvents).toHaveBeenCalledTimes(2);
  });

  it("其他窗口清空台账的广播会立即失效当前窗口缓存", async () => {
    invalidateDeliveryActivityCache();
    getRecentDeliveryEvents.mockResolvedValue([failedEvent()]);
    await getRecentDeliveryEventsCached(100, 60_000);
    await getRecentDeliveryEventsCached(100, 60_000);
    expect(getRecentDeliveryEvents).toHaveBeenCalledOnce();

    invalidateDeliveryActivityCache();
    await getRecentDeliveryEventsCached(100, 60_000);
    expect(getRecentDeliveryEvents).toHaveBeenCalledTimes(2);
  });

  it("保留期变化会使短 TTL 查询重新读取并按新范围压实", async () => {
    invalidateDeliveryActivityCache();
    getRecentDeliveryEvents.mockResolvedValue([failedEvent()]);
    await getRecentDeliveryEventsCached(100, 60_000);
    useNotesStore.getState().setSettings({ outcomeRetentionDays: 90 });

    await getRecentDeliveryEventsCached(100, 60_000);

    expect(getRecentDeliveryEvents).toHaveBeenCalledTimes(2);
    expect(getRecentDeliveryEvents).toHaveBeenLastCalledWith(100, 90);
  });

  it("重新准备读取修改后的当前来源、刷新目标、重跑 Firewall 且只打开预检", async () => {
    const noteId = useNotesStore.getState().addNote("旧正文").id!;
    useNotesStore.getState().updateNoteText(noteId, "修改后的当前正文");
    const scan = vi.fn(async (text: string) => ({
      findings: [],
      warnings: [],
      inputUtf16: text.length,
      scannedUtf16: text.length,
      complete: true,
    }));
    const refresh = vi.fn(async () => {
      useTargetStore.setState({
        snapshot: refreshedTarget,
        status: "ready",
        reason: null,
      });
      return refreshedTarget;
    });

    const result = await reprepareDeliveryEvent(
      failedEvent({ sourceItemIds: [noteId] }),
      { refresh, scan }
    );

    expect(result).toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledWith("修改后的当前正文");
    expect(sendDelivery).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState().open).toBe(true);
    expect(useDeliveryStore.getState().draft?.finalText).toBe("修改后的当前正文");
    expect(useDeliveryStore.getState().draft?.targetSnapshot?.token).toBe("fresh-token");
    expect(useDeliveryStore.getState().draft?.targetSnapshot?.token).not.toBe(
      "old-secret-token"
    );
  });

  it("图片 Firewall 阻止记录可重新准备，并以无正文元数据标记重试", async () => {
    const noteId = useNotesStore.getState().addNote("重新检查图片").id!;
    const refresh = vi.fn(async () => {
      useTargetStore.setState({ snapshot: refreshedTarget, status: "ready", reason: null });
      return refreshedTarget;
    });

    const result = await reprepareDeliveryEvent(
      failedEvent({
        eventType: "firewallBlocked",
        status: "blocked",
        reasonCode: "privacy_gate_blocked",
        sourceItemIds: [noteId],
      }),
      { refresh }
    );
    await flushDeliveryActivityWrites();

    expect(result).toEqual({ ok: true });
    expect(appendDeliveryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "draftCreated",
        reasonCode: "retry-prepared",
      }),
      expect.any(Number)
    );
    expect(sendDelivery).not.toHaveBeenCalled();
  });

  it("来源已删除时明确失败，不刷新目标、不打开预检也不发送", async () => {
    const refresh = vi.fn();

    const result = await reprepareDeliveryEvent(failedEvent(), { refresh });

    expect(result).toEqual({ ok: false, reason: "sourceMissing" });
    expect(refresh).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState().open).toBe(false);
    expect(sendDelivery).not.toHaveBeenCalled();
  });

  it("目标刷新异常时释放恢复状态，不打开预检也不发送", async () => {
    const noteId = useNotesStore.getState().addNote("仍存在的来源").id!;

    const result = await reprepareDeliveryEvent(
      failedEvent({ sourceItemIds: [noteId] }),
      { refresh: async () => { throw new Error("offline"); } }
    );

    expect(result).toEqual({ ok: false, reason: "targetUnavailable" });
    expect(useDeliveryStore.getState().open).toBe(false);
    expect(sendDelivery).not.toHaveBeenCalled();
  });

  it("真实执行链记录创建、预检、开始、结果和剪贴板事件", async () => {
    const noteId = useNotesStore.getState().addNote("生命周期正文").id!;
    const scan = async (text: string) => ({
      findings: [],
      warnings: [],
      inputUtf16: text.length,
      scannedUtf16: text.length,
      complete: true,
    });
    const refresh = async () => {
      useTargetStore.setState({ snapshot: refreshedTarget, status: "ready", reason: null });
      return refreshedTarget;
    };
    await reprepareDeliveryEvent(
      failedEvent({ sourceItemIds: [noteId] }),
      { refresh, scan }
    );
    await flushDeliveryActivityWrites();
    expect(appendDeliveryEvent.mock.calls.map(([item]) => item.eventType)).toEqual([
      "draftCreated",
      "preflightOpened",
    ]);

    const prepared = useDeliveryStore.getState().draft!;
    useDeliveryStore.getState().closeDraft();
    appendDeliveryEvent.mockClear();
    refreshTargetSnapshot.mockResolvedValue(refreshedTarget);
    sendDelivery.mockImplementation(async (request) => ({
      deliveryId: request.deliveryId,
      status: "sent",
      reasonCode: "ok",
      message: "已发送",
      target: refreshedTarget,
      pasteCompleted: true,
      enterPressed: false,
      clipboardOutcome: "restored",
      startedAtMs: 20,
      finishedAtMs: 30,
    }));

    await executeDeliveryDraft({
      ...prepared,
      redactionMap: { "alice@example.com": "[EMAIL_01]" },
    });
    await flushDeliveryActivityWrites();

    expect(appendDeliveryEvent.mock.calls.map(([item]) => item.eventType)).toEqual([
      "sendStarted",
      "sendSent",
      "clipboardRestored",
    ]);
    expect(sendDelivery).toHaveBeenCalledOnce();
    expect(deliveryRedactionMapAvailable(prepared.id)).toBe(true);
  });
});
