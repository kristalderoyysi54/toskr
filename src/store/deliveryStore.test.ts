import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import type { DeliveryDraft } from "@/lib/delivery/types";
import { scanOpenDeliveryDraft } from "@/lib/delivery/firewallController";
import type { ScanSensitiveResult } from "@/lib/tauri";
import {
  resetDeliveryStore,
  useDeliveryStore,
} from "./deliveryStore";
import {
  serializePersistentState,
  useNotesStore,
} from "./notesStore";

function draft(): DeliveryDraft {
  return {
    id: "draft-1",
    revision: 1,
    createdAtMs: 1,
    sourceKind: "note",
    sourceItemIds: ["one"],
    selectionItemIds: ["one"],
    rawText: "正文",
    sourceTextOverride: null,
    assembledText: "自动正文",
    finalText: "自动正文",
    originalImageFiles: [],
    segments: null,
    imageFiles: [],
    imageFirewall: [],
    format: "plain",
    markdownMode: "preserve",
    promptSnippetId: null,
    transformRecipeId: null,
    promptSnippetGroupId: null,
    promptTemplate: null,
    targetSnapshot: null,
    targetProfileId: "safe",
    promptGroupId: "general",
    profileSource: "fallback",
    profileDefaultFormat: "plain",
    profileDefaultMarkdownMode: "preserve",
    profileKeepPanel: false,
    privacyPolicy: "requireRedaction",
    firewallEnabled: true,
    firewallDisabledWarnCategories: [],
    firewallStatus: "ready",
    findings: [],
    redactionMap: {},
    aliasReplacedCount: 0,
    scanRevision: 1,
    privacyDecision: {
      excludedFindingIds: [],
      rawConfirmation: null,
      replacedCount: 0,
    },
    enterPolicy: "confirm",
    enterDecisionConfirmed: false,
    pressEnter: false,
    keepPanel: false,
    warnings: [],
    dataGeneration: 1,
  };
}

describe("deliveryStore", () => {
  beforeEach(() => resetDeliveryStore());

  it("默认 smart 且正文只保存在会话态", () => {
    expect(useDeliveryStore.getState()).toMatchObject({
      draft: null,
      open: false,
      busy: false,
      activeSection: "summary",
      lastError: null,
      retryBlocked: false,
      safeRetryPending: false,
      preflightMode: "smart",
    });
  });

  it("编辑 finalText、恢复自动内容与 keepPanel 都产生新 revision", () => {
    useDeliveryStore.getState().openDraft(draft());
    const initial = useDeliveryStore.getState().draft!;

    useDeliveryStore.getState().setFinalText("手工正文");
    const edited = useDeliveryStore.getState().draft!;
    expect(edited.finalText).toBe("手工正文");
    expect(edited.assembledText).toBe("自动正文");
    expect(edited.revision).toBeGreaterThan(initial.revision);

    useDeliveryStore.getState().resetFinalText();
    const restored = useDeliveryStore.getState().draft!;
    expect(restored.finalText).toBe("自动正文");
    expect(restored.revision).toBeGreaterThan(edited.revision);

    useDeliveryStore.getState().setKeepPanel(true);
    expect(useDeliveryStore.getState().draft).toMatchObject({ keepPanel: true });
    expect(useDeliveryStore.getState().draft!.revision).toBeGreaterThan(restored.revision);
  });

  it("只为实际应用且未再手工改写的正文保留 AI 配方归因", () => {
    const initial = draft();
    useDeliveryStore.getState().openDraft(initial);
    const request = {
      requestId: "request-1",
      draftId: initial.id,
      draftRevision: initial.revision,
      recipeId: "summarize" as const,
      provider: "local",
      model: "test",
      inputChars: initial.finalText.length,
      startedAtMs: 1,
    };
    expect(useDeliveryStore.getState().beginTransform(request)).toBe(true);
    useDeliveryStore.getState().finishTransform({
      ...request,
      text: "AI 摘要",
      createdAtMs: 2,
    });
    expect(useDeliveryStore.getState().applyTransformResult()).toBe(true);
    expect(useDeliveryStore.getState().draft).toMatchObject({
      finalText: "AI 摘要",
      transformRecipeId: "summarize",
    });

    useDeliveryStore.getState().setFinalText("人工改写");
    expect(useDeliveryStore.getState().draft?.transformRecipeId).toBeNull();
  });

  it("AI 结果重新经过无 Markdown 输出投影，并可恢复应用前正文", () => {
    const initial = {
      ...draft(),
      assembledText: "原始纯文本",
      finalText: "原始纯文本",
      markdownMode: "strip" as const,
    };
    useDeliveryStore.getState().openDraft(initial);
    const request = {
      requestId: "request-strip",
      draftId: initial.id,
      draftRevision: initial.revision,
      recipeId: "summarize" as const,
      provider: "local",
      model: "test",
      inputChars: initial.finalText.length,
      startedAtMs: 1,
    };
    useDeliveryStore.getState().beginTransform(request);
    useDeliveryStore.getState().finishTransform({
      ...request,
      text: "- **重点**：[文档](https://example.com)",
      createdAtMs: 2,
    });

    expect(useDeliveryStore.getState().applyTransformResult()).toBe(true);
    expect(useDeliveryStore.getState().draft).toMatchObject({
      finalText: "• 重点：文档（https://example.com）",
      transformRecipeId: "summarize",
    });
    expect(useDeliveryStore.getState().restoreTransformText()).toBe(true);
    expect(useDeliveryStore.getState().draft).toMatchObject({
      finalText: "原始纯文本",
      transformRecipeId: null,
    });
  });

  it("AI 结果重新经过代码块输出投影，非正文设置不误判为过期", () => {
    const initial = {
      ...draft(),
      assembledText: "```\n原始正文\n```",
      finalText: "```\n原始正文\n```",
      format: "code" as const,
    };
    useDeliveryStore.getState().openDraft(initial);
    const request = {
      requestId: "request-code",
      draftId: initial.id,
      draftRevision: initial.revision,
      recipeId: "improve-prompt" as const,
      provider: "local",
      model: "test",
      inputChars: initial.finalText.length,
      startedAtMs: 1,
    };
    useDeliveryStore.getState().beginTransform(request);
    useDeliveryStore.getState().finishTransform({
      ...request,
      text: "const answer = 42;",
      createdAtMs: 2,
    });

    expect(useDeliveryStore.getState().applyTransformResult()).toBe(true);
    expect(useDeliveryStore.getState().draft?.finalText).toBe(
      "```\nconst answer = 42;\n```"
    );
    useDeliveryStore.getState().setKeepPanel(true);
    expect(useDeliveryStore.getState().transform.status).toBe("applied");
    useDeliveryStore.getState().setFinalText("人工改写");
    expect(useDeliveryStore.getState().transform.status).toBe("stale");
  });

  it("confirm 回车必须由本次预检明确确认", () => {
    useDeliveryStore.getState().openDraft(draft());

    useDeliveryStore.getState().confirmEnter(false);
    expect(useDeliveryStore.getState().draft).toMatchObject({
      enterDecisionConfirmed: true,
      pressEnter: false,
    });

    useDeliveryStore.getState().openDraft(draft());
    useDeliveryStore.getState().confirmEnter(true);
    expect(useDeliveryStore.getState().draft).toMatchObject({
      enterDecisionConfirmed: true,
      pressEnter: true,
    });
  });

  it("安全演练 Draft 无法被预检交互重新开启回车", () => {
    useDeliveryStore.getState().openDraft({
      ...draft(),
      safeRehearsal: true,
      enterDecisionConfirmed: true,
      pressEnter: false,
      keepPanel: true,
    });

    useDeliveryStore.getState().confirmEnter(true);

    expect(useDeliveryStore.getState().draft).toMatchObject({
      safeRehearsal: true,
      enterDecisionConfirmed: true,
      pressEnter: false,
      keepPanel: true,
    });
  });

  it("批量替换同值复用占位符，正文变化使 finding 与原文授权失效", () => {
    const text = "alice@example.com / alice@example.com";
    useDeliveryStore.getState().openDraft({
      ...draft(),
      finalText: text,
      assembledText: text,
      findings: [
        {
          id: "email-1",
          category: "email",
          severity: "warn",
          startUtf16: 0,
          endUtf16: 17,
          maskedPreview: "a•••m",
          suggestedPlaceholder: "[EMAIL]",
          ruleId: "test.email",
        },
        {
          id: "email-2",
          category: "email",
          severity: "warn",
          startUtf16: 20,
          endUtf16: 37,
          maskedPreview: "a•••m",
          suggestedPlaceholder: "[EMAIL]",
          ruleId: "test.email",
        },
      ],
    });

    useDeliveryStore.getState().replaceFirewallCategory("email");
    expect(useDeliveryStore.getState().draft).toMatchObject({
      finalText: "[EMAIL_01] / [EMAIL_01]",
      firewallStatus: "idle",
      findings: [],
      redactionMap: { "alice@example.com": "[EMAIL_01]" },
      privacyDecision: { replacedCount: 2, rawConfirmation: null },
    });

    useDeliveryStore.setState((state) => ({
      draft: state.draft ? {
        ...state.draft,
        firewallStatus: "ready",
        findings: [{
          id: "warn",
          category: "email",
          severity: "warn",
          startUtf16: 0,
          endUtf16: 10,
          maskedPreview: "占•••符",
          suggestedPlaceholder: "[EMAIL]",
          ruleId: "test.email",
        }],
      } : null,
    }));
    useDeliveryStore.getState().confirmRawPrivacy("warn");
    const confirmedScanRevision = useDeliveryStore.getState().draft!.scanRevision;
    useDeliveryStore.getState().setKeepPanel(true);
    expect(useDeliveryStore.getState().draft?.privacyDecision.rawConfirmation)
      .toMatchObject({ revision: confirmedScanRevision });

    useDeliveryStore.getState().setFinalText("重新输入");
    expect(useDeliveryStore.getState().draft).toMatchObject({
      firewallStatus: "idle",
      findings: [],
      privacyDecision: { excludedFindingIds: [], rawConfirmation: null },
    });
  });

  it("Esc 等价 close：清理 Draft 但不触碰外部选择", () => {
    useDeliveryStore.getState().openDraft(draft());
    useDeliveryStore.getState().setActiveSection("content");
    useDeliveryStore.getState().setRetryBlocked(true);
    useDeliveryStore.getState().setSafeRetryPending(true);
    useDeliveryStore.getState().closeDraft();

    expect(useDeliveryStore.getState()).toMatchObject({
      draft: null,
      open: false,
      busy: false,
      activeSection: "summary",
      lastError: null,
      retryBlocked: false,
      safeRetryPending: false,
    });
  });

  it("异步扫描只回写同一 scan revision，正文变化会丢弃旧结果", async () => {
    let resolve!: (result: ScanSensitiveResult) => void;
    const pending = new Promise<ScanSensitiveResult>((done) => {
      resolve = done;
    });
    useDeliveryStore.getState().openDraft({
      ...draft(),
      firewallStatus: "idle",
      scanRevision: 0,
    });

    const scanning = scanOpenDeliveryDraft(() => pending);
    expect(useDeliveryStore.getState().draft?.firewallStatus).toBe("scanning");
    useDeliveryStore.getState().setFinalText("正文已经变化");
    resolve({
      findings: [{
        id: "old-email",
        category: "email",
        severity: "warn",
        startUtf16: 0,
        endUtf16: 2,
        maskedPreview: "旧••",
        suggestedPlaceholder: "[EMAIL]",
        ruleId: "test.email",
      }],
      warnings: [],
      inputUtf16: 2,
      scannedUtf16: 2,
      complete: true,
    });
    await scanning;

    expect(useDeliveryStore.getState().draft).toMatchObject({
      finalText: "正文已经变化",
      firewallStatus: "idle",
      findings: [],
    });
  });

  it("会话 redactionMap 不进入持久化文件，关闭后立即清理", () => {
    const raw = "phase08_fake_secret@example.test";
    useDeliveryStore.getState().openDraft({
      ...draft(),
      rawText: raw,
      sourceTextOverride: null,
      assembledText: raw,
      finalText: "[EMAIL_01]",
      redactionMap: { [raw]: "[EMAIL_01]" },
    });

    expect(serializePersistentState(useNotesStore.getState())).not.toContain(raw);
    useDeliveryStore.getState().closeDraft();
    expect(useDeliveryStore.getState().draft).toBeNull();
  });
});

describe("revertAliasFinding", () => {
  beforeEach(() => resetDeliveryStore());

  function aliasedDraft(): DeliveryDraft {
    return {
      ...draft(),
      assembledText: "通知 [USER_01] 到场",
      finalText: "通知 [USER_01] 到场",
      redactionMap: { 张三: "[USER_01]" },
      aliasReplacedCount: 1,
    };
  }

  it("按鲜活偏移量还原原文，递减计数并触发隐私重扫描", () => {
    useDeliveryStore.getState().openDraft(aliasedDraft());
    useDeliveryStore.getState().revertAliasFinding({
      startUtf16: 3,
      endUtf16: 12,
      placeholder: "[USER_01]",
      originalText: "张三",
    });
    const next = useDeliveryStore.getState().draft!;
    expect(next.finalText).toBe("通知 张三 到场");
    expect(next.aliasReplacedCount).toBe(0);
    // invalidatePrivacy：扫描状态复位并推进 scanRevision
    expect(next.firewallStatus).toBe("idle");
    expect(next.scanRevision).toBe(2);
  });

  it("偏移量已失效（文本被编辑）时静默忽略", () => {
    useDeliveryStore.getState().openDraft(aliasedDraft());
    useDeliveryStore.getState().setFinalText("完全不同的正文");
    const before = useDeliveryStore.getState().draft!;
    useDeliveryStore.getState().revertAliasFinding({
      startUtf16: 3,
      endUtf16: 12,
      placeholder: "[USER_01]",
      originalText: "张三",
    });
    expect(useDeliveryStore.getState().draft).toBe(before);
  });
});
