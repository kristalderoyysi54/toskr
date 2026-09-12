import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import type { AiRequestHandle } from "./aiClient";
import { AiError } from "./aiClient";
import {
  applyOpenDraftTransform,
  cancelOpenDraftTransform,
  closeOpenDraftWithTransforms,
  discardOpenDraftTransform,
  restoreOpenDraftTransform,
  runOpenDraftTransform,
  TRANSFORM_RECIPES,
} from "./aiTransform";
import type { DeliveryDraft } from "./delivery/types";
import type { ScanSensitiveResult } from "./tauri";
import { resetDeliveryStore, useDeliveryStore } from "@/store/deliveryStore";

function draft(patch: Partial<DeliveryDraft> = {}): DeliveryDraft {
  return {
    id: "draft-transform",
    revision: 10,
    createdAtMs: 1,
    sourceKind: "note",
    sourceItemIds: ["note-1"],
    selectionItemIds: ["note-1"],
    rawText: "原始正文",
    sourceTextOverride: null,
    assembledText: "原始正文",
    finalText: "原始正文",
    originalImageFiles: [],
    segments: null,
    imageFiles: [],
    imageFirewall: [],
    format: "plain",
    markdownMode: "preserve",
    promptSnippetId: null,
    promptSnippetGroupId: null,
    promptTemplate: null,
    targetSnapshot: null,
    targetProfileId: "default",
    promptGroupId: "general",
    profileSource: "fallback",
    profileDefaultFormat: "plain",
    profileDefaultMarkdownMode: "preserve",
    profileKeepPanel: false,
    privacyPolicy: "requireRedaction",
    firewallEnabled: true,
    firewallDisabledWarnCategories: [],
    firewallStatus: "ready",
    aliasReplacedCount: 0,
    findings: [],
    redactionMap: {},
    scanRevision: 2,
    privacyDecision: {
      excludedFindingIds: [],
      rawConfirmation: null,
      replacedCount: 0,
    },
    enterPolicy: "confirm",
    enterDecisionConfirmed: true,
    pressEnter: true,
    keepPanel: false,
    warnings: [],
    dataGeneration: 1,
    ...patch,
    transformRecipeId: patch.transformRecipeId ?? null,
  };
}

function resolvedHandle(text: string, provider = "测试提供商"): AiRequestHandle {
  const result = Promise.resolve(text);
  return {
    descriptor: {
      provider,
      model: "test-model",
      baseUrl: "https://api.example.test",
      enabled: true,
      ready: true,
    },
    result,
    cancel: vi.fn(),
    transportSettled: result.then(() => undefined, () => undefined),
  };
}

function deferredHandle(provider = "测试提供商") {
  let resolve!: (value: string) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<string>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  let settleTransport!: () => void;
  const transportSettled = new Promise<void>((done) => {
    settleTransport = done;
  });
  const handle: AiRequestHandle = {
    descriptor: {
      provider,
      model: "test-model",
      baseUrl: "https://api.example.test",
      enabled: true,
      ready: true,
    },
    result,
    cancel: vi.fn(() => reject(new AiError("cancelled", "已取消"))),
    transportSettled,
  };
  return { handle, resolve, reject, settleTransport };
}

const cleanScan: ScanSensitiveResult = {
  findings: [],
  warnings: [],
  inputUtf16: 4,
  scannedUtf16: 4,
  complete: true,
};

describe("显式 AI 转换", () => {
  beforeEach(() => {
    resetDeliveryStore();
    useDeliveryStore.getState().openDraft(draft());
  });

  it("只暴露四个固定 recipe，未解决 block 时请求次数为 0", async () => {
    expect(TRANSFORM_RECIPES.map((item) => item.label)).toEqual([
      "总结要点",
      "提取行动项",
      "优化 Prompt",
      "结构化需求",
    ]);
    useDeliveryStore.getState().openDraft(draft({
      finalText: "fake_token",
      findings: [{
        id: "block-1",
        category: "apiKey",
        severity: "block",
        startUtf16: 0,
        endUtf16: 10,
        maskedPreview: "fa•••en",
        suggestedPlaceholder: "[API_KEY]",
        ruleId: "test.api-key",
      }],
    }));
    const startRequest = vi.fn(() => resolvedHandle("不应调用"));

    await runOpenDraftTransform("summarize", { startRequest });

    expect(startRequest).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState().transform.error).toContain("隐私");
  });

  it("结果绑定 Draft revision；编辑后的迟到结果只能过期查看", async () => {
    const pending = deferredHandle();
    const running = runOpenDraftTransform("summarize", {
      startRequest: () => pending.handle,
      requestId: () => "request-stale",
      now: () => 100,
    });
    useDeliveryStore.getState().setFinalText("用户已继续编辑");
    pending.resolve("迟到候选");
    pending.settleTransport();
    await running;

    expect(useDeliveryStore.getState().transform).toMatchObject({
      status: "stale",
      result: {
        requestId: "request-stale",
        draftId: "draft-transform",
        draftRevision: 10,
        text: "迟到候选",
      },
    });
    await expect(applyOpenDraftTransform()).resolves.toBe(false);
    expect(useDeliveryStore.getState().draft?.finalText).toBe("用户已继续编辑");
  });

  it("取消会立即丢弃候选并释放 busy，底层迟到结束不回写", async () => {
    const pending = deferredHandle();
    const running = runOpenDraftTransform("summarize", {
      startRequest: () => pending.handle,
      requestId: () => "request-cancel",
    });
    expect(useDeliveryStore.getState().transform.status).toBe("running");

    cancelOpenDraftTransform();
    await running;
    expect(useDeliveryStore.getState().transform).toMatchObject({
      status: "cancelled",
      result: null,
    });
    expect(pending.handle.cancel).toHaveBeenCalledTimes(1);

    pending.settleTransport();
    await pending.handle.transportSettled;
    expect(useDeliveryStore.getState().transform.result).toBeNull();
  });

  it("关闭预检会取消在途转换并清空请求与结果", async () => {
    const pending = deferredHandle();
    const running = runOpenDraftTransform("summarize", {
      startRequest: () => pending.handle,
      requestId: () => "request-close",
    });

    closeOpenDraftWithTransforms();
    await running;
    expect(pending.handle.cancel).toHaveBeenCalledTimes(1);
    expect(useDeliveryStore.getState()).toMatchObject({
      open: false,
      draft: null,
      transform: {
        status: "idle",
        request: null,
        result: null,
      },
    });
    pending.settleTransport();
  });

  it("应用候选递增 revision、清确认并立即重扫；可恢复转换前文本", async () => {
    const before = useDeliveryStore.getState().draft!;
    await runOpenDraftTransform("summarize", {
      startRequest: () => resolvedHandle("候选正文"),
      requestId: () => "request-apply",
    });
    const scan = vi.fn(async (text: string): Promise<ScanSensitiveResult> => ({
      ...cleanScan,
      inputUtf16: text.length,
      scannedUtf16: text.length,
    }));

    await expect(applyOpenDraftTransform(scan)).resolves.toBe(true);
    const applied = useDeliveryStore.getState().draft!;
    expect(applied.finalText).toBe("候选正文");
    expect(applied.revision).toBeGreaterThan(before.revision);
    expect(applied.firewallStatus).toBe("ready");
    expect(applied.enterDecisionConfirmed).toBe(false);
    expect(applied.pressEnter).toBe(false);
    expect(applied.privacyDecision.rawConfirmation).toBeNull();
    expect(scan).toHaveBeenCalledWith("候选正文");
    expect(useDeliveryStore.getState().transform.status).toBe("applied");

    await expect(restoreOpenDraftTransform(scan)).resolves.toBe(true);
    expect(useDeliveryStore.getState().draft?.finalText).toBe("原始正文");
    expect(useDeliveryStore.getState().draft!.revision).toBeGreaterThan(applied.revision);
  });

  it.each([
    ["network", new AiError("network", "offline")],
    ["timeout", new AiError("network", "timeout")],
    ["empty", "   "],
    ["parse", "not-json"],
  ] as const)("%s/解析失败不丢原文", async (kind, failure) => {
    const recipe = kind === "parse" ? "structure-requirements" : "summarize";
    const startRequest = () => {
      if (failure instanceof Error) {
        const result = Promise.reject(failure);
        result.catch(() => undefined);
        return {
          ...resolvedHandle(""),
          result,
          transportSettled: result.then(() => undefined, () => undefined),
        };
      }
      return resolvedHandle(failure);
    };

    await runOpenDraftTransform(recipe, { startRequest });

    expect(useDeliveryStore.getState().draft?.finalText).toBe("原始正文");
    expect(useDeliveryStore.getState().transform.status).toBe("error");
  });

  it.each([
    {},
    { goal: "需求" },
    { goal: 123, scope: [], constraints: [], acceptance: [], openQuestions: [] },
    { goal: " ", scope: [], constraints: [], acceptance: [], openQuestions: [] },
    { goal: "需求", scope: "范围", constraints: [], acceptance: [], openQuestions: [] },
    { goal: "需求", scope: [123], constraints: [], acceptance: [], openQuestions: [] },
    { goal: "需求", scope: [], constraints: [null], acceptance: [], openQuestions: [] },
    { goal: "需求", scope: [], constraints: [], acceptance: [" "], openQuestions: [] },
    { goal: "需求", scope: [], constraints: [], acceptance: [], openQuestions: [{}] },
    { goal: "需求", scope: [], constraints: [], acceptance: [], openQuestions: [], unexpected: true },
    { goal: "字".repeat(4_001), scope: [], constraints: [], acceptance: [], openQuestions: [] },
    { goal: "需求", scope: Array(51).fill("范围"), constraints: [], acceptance: [], openQuestions: [] },
    { goal: "需求", scope: [], constraints: ["字".repeat(4_001)], acceptance: [], openQuestions: [] },
  ])("结构化需求拒绝错误业务字段，保留原稿且不能应用候选 %#", async (output) => {
    const before = useDeliveryStore.getState().draft;
    await expect(runOpenDraftTransform("structure-requirements", {
      startRequest: () => resolvedHandle(JSON.stringify(output)),
    })).resolves.toBeNull();
    expect(useDeliveryStore.getState().draft).toBe(before);
    expect(useDeliveryStore.getState().transform).toMatchObject({ status: "error", result: null });
    await expect(applyOpenDraftTransform()).resolves.toBe(false);
  });

  it("结构化字段上限内完整保留内容，不截断或改写", async () => {
    const output = {
      goal: "字".repeat(4_000),
      scope: Array(50).fill("范围"),
      constraints: ["字".repeat(4_000)],
      acceptance: [],
      openQuestions: [],
    };
    const result = await runOpenDraftTransform("structure-requirements", {
      startRequest: () => resolvedHandle(JSON.stringify(output)),
    });
    expect(JSON.parse(result!.text)).toEqual(output);
    expect(useDeliveryStore.getState().draft?.finalText).toBe("原始正文");
  });

  it("结构错误后可重试合法业务对象，应用及恢复仍保留原稿", async () => {
    await runOpenDraftTransform("structure-requirements", {
      startRequest: () => resolvedHandle('{}'),
    });
    const output = { goal: "整理需求", scope: ["资料"], constraints: [], acceptance: ["可恢复原文"], openQuestions: [] };
    const text = JSON.stringify(output, null, 2);
    await runOpenDraftTransform("structure-requirements", {
      startRequest: () => resolvedHandle('```json\n' + JSON.stringify(output) + '\n```'),
    });
    expect(useDeliveryStore.getState().transform).toMatchObject({ status: "ready", result: { text } });
    const scan = vi.fn(async (value: string): Promise<ScanSensitiveResult> => ({
      ...cleanScan, inputUtf16: value.length, scannedUtf16: value.length,
    }));
    await expect(applyOpenDraftTransform(scan)).resolves.toBe(true);
    expect(useDeliveryStore.getState().draft?.finalText).toBe(text);
    await expect(restoreOpenDraftTransform(scan)).resolves.toBe(true);
    expect(useDeliveryStore.getState().draft?.finalText).toBe("原始正文");
  });

  it("同一 Draft 重复点击只发一次，并在调用前记录 provider/model/数据范围", async () => {
    const pending = deferredHandle("DeepSeek");
    const startRequest = vi.fn(() => pending.handle);
    const first = runOpenDraftTransform("summarize", {
      startRequest,
      requestId: () => "request-one",
      now: () => 321,
    });
    const second = runOpenDraftTransform("summarize", { startRequest });

    expect(startRequest).toHaveBeenCalledTimes(1);
    expect(useDeliveryStore.getState().transform.request).toMatchObject({
      requestId: "request-one",
      provider: "DeepSeek",
      model: "test-model",
      inputChars: 4,
      draftRevision: 10,
      startedAtMs: 321,
    });

    pending.resolve("候选");
    pending.settleTransport();
    await Promise.all([first, second]);
    discardOpenDraftTransform();
    expect(useDeliveryStore.getState().transform).toMatchObject({
      status: "idle",
      request: null,
      result: null,
    });
  });
});
