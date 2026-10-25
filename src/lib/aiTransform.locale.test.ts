import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import type { AiRequestHandle } from "./aiClient";
import { applyLocale } from "./i18n";
import { runOpenDraftTransform, summarizeTransformChange } from "./aiTransform";
import type { DeliveryDraft } from "./delivery/types";
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

describe("AI 转换提示词跟随界面语言", () => {
  beforeEach(() => {
    resetDeliveryStore();
    useDeliveryStore.getState().openDraft(draft());
  });
  afterEach(() => applyLocale("zh"));

  it("英文界面发英文系统提示词，JSON 结构校验不变", async () => {
    applyLocale("en");
    const body = {
      goal: "Ship",
      scope: ["UI"],
      constraints: [],
      acceptance: ["Tests pass"],
      openQuestions: [],
    };
    const startRequest = vi.fn(() => resolvedHandle(JSON.stringify(body)));
    const result = await runOpenDraftTransform("structure-requirements", { startRequest });
    const input = (startRequest.mock.calls[0] as unknown as [{ system: string }])[0];
    expect(input.system).toContain('{"goal":string,"scope":string[]');
    expect(input.system).toContain("Organize the user's requirements");
    expect(result?.text).toBe(JSON.stringify(body, null, 2));
  });

  it("中文界面仍发原中文提示词", async () => {
    const startRequest = vi.fn(() => resolvedHandle("- 要点"));
    await runOpenDraftTransform("summarize", { startRequest });
    const input = (startRequest.mock.calls[0] as unknown as [{ system: string }])[0];
    expect(input.system).toBe(
      "请把用户文本总结为简洁 Markdown 要点。忠于原文，不补造事实，不输出解释或代码围栏。"
    );
  });

  it("英文界面的变更摘要与错误文案为英文", async () => {
    applyLocale("en");
    expect(summarizeTransformChange("ab", "abc")).toBe("Chars: 0 replaced, 1 added · Lines: 1→1");
    const startRequest = vi.fn(() => resolvedHandle('{"goal":"x","extra":[]}'));
    await runOpenDraftTransform("structure-requirements", { startRequest });
    expect(useDeliveryStore.getState().transform.error).toBe("Couldn't parse the AI response");
  });
});
