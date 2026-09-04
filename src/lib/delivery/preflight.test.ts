import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      scanSensitiveText: async (text: string) => ({
        findings: [],
        warnings: [],
        inputUtf16: text.length,
        scannedUtf16: text.length,
        complete: true,
      }),
    },
  };
});

import {
  confirmOpenPreflightTargetChange,
  deliveryRetryIsSafe,
  dispatchDeliveryDraft,
  rebindPreflightDraftTarget,
  rebuildPreflightDraft,
  recoverOpenPreflightTarget,
  shouldOpenPreflight,
  submitPreflightDraft,
  updateOpenPreflightDraft,
} from "./preflight";
import { inspectDeliveryDraft } from "./executeDraft";
import type { DeliveryDraft, ImageFirewallItem } from "./types";
import {
  resetDeliveryStore,
  useDeliveryStore,
} from "@/store/deliveryStore";
import type { SendDeliveryResult, TargetSnapshot } from "@/lib/tauri";
import type { TargetProfileResolution } from "@/lib/targetProfiles";
import type { DeliveryDraftBuildState } from "./types";
import {
  applyTargetEvent,
  resetTargetState,
  useTargetStore,
} from "@/store/targetStore";
import { useNotesStore } from "@/store/notesStore";

const target: TargetSnapshot = {
  token: "token",
  pid: 42,
  bundleId: "com.openai.codex",
  appName: "Codex",
  launchedAtMs: 10,
  capturedAtMs: 20,
  revision: 1,
  ready: true,
  reason: null,
  windowId: null,
};

const profileResolution: TargetProfileResolution = {
  profileId: "safe",
  profile: {
    id: "safe",
    name: "安全",
    bundleIds: ["com.openai.codex"],
    promptGroupId: "general",
    defaultFormat: "plain",
    defaultMarkdownMode: "preserve",
    enterPolicy: "never",
    privacyPolicy: "requireRedaction",
    keepPanel: false,
  },
  promptGroup: { id: "general", name: "通用", order: 0 },
  source: "exact",
  targetBundleId: "com.openai.codex",
  reason: "exact_bundle_match",
  isTargetReady: true,
  privacyCapabilityActive: false,
  safetyClamped: false,
  duplicateBundleProfileIds: ["safe"],
  ruleOverriddenKeys: [],
};

function draft(overrides: Partial<DeliveryDraft> = {}): DeliveryDraft {
  return {
    id: "draft-1",
    revision: 1,
    createdAtMs: 1,
    sourceKind: "note",
    sourceItemIds: ["one"],
    selectionItemIds: ["one"],
    rawText: "正文",
    sourceTextOverride: null,
    assembledText: "正文",
    finalText: "正文",
    originalImageFiles: [],
    segments: null,
    imageFiles: [],
    imageFirewall: [],
    format: "plain",
    markdownMode: "preserve",
    promptSnippetId: null,
    promptSnippetGroupId: null,
    promptTemplate: null,
    targetSnapshot: target,
    targetProfileId: "safe",
    promptGroupId: "general",
    profileSource: "exact",
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
    scanRevision: 1,
    privacyDecision: {
      excludedFindingIds: [],
      rawConfirmation: null,
      replacedCount: 0,
    },
    enterPolicy: "never",
    enterDecisionConfirmed: true,
    pressEnter: false,
    keepPanel: false,
    warnings: [],
    dataGeneration: 1,
    ...overrides,
    transformRecipeId: overrides.transformRecipeId ?? null,
  };
}

function sentResult(value: DeliveryDraft): SendDeliveryResult {
  return {
    deliveryId: value.id,
    status: "sent",
    reasonCode: "ok",
    message: "已发送",
    target,
    pasteCompleted: true,
    enterPressed: value.pressEnter,
    clipboardOutcome: "nothingToRestore",
    startedAtMs: 1,
    finishedAtMs: 2,
  };
}

function blockedResult(
  value: DeliveryDraft,
  overrides: Partial<SendDeliveryResult> = {}
): SendDeliveryResult {
  return {
    ...sentResult(value),
    status: "blocked",
    reasonCode: "target_not_frontmost",
    message: "发送中止",
    pasteCompleted: false,
    enterPressed: false,
    ...overrides,
  };
}

describe("shouldOpenPreflight", () => {
  it("always 与 off 精确覆盖 smart，但显式预检可覆盖 off", () => {
    const simple = draft();

    expect(shouldOpenPreflight(simple, "always")).toBe(true);
    expect(shouldOpenPreflight(simple, "off")).toBe(false);
    expect(shouldOpenPreflight(simple, "off", true)).toBe(true);
  });

  it("smart 只让单条稳定纯文本直发", () => {
    const simple = draft();
    expect(shouldOpenPreflight(simple, "smart")).toBe(false);

    for (const complex of [
      draft({ sourceKind: "note-batch", sourceItemIds: ["one", "two"] }),
      // 带图但缺扫描回执（imageFirewall 为空）→ 仍需预检
      draft({ imageFiles: ["one.png"] }),
      draft({ promptSnippetId: "review", promptTemplate: "审查：{内容}" }),
      draft({ format: "code" }),
      draft({ markdownMode: "strip" }),
      draft({ enterPolicy: "confirm", enterDecisionConfirmed: false }),
      draft({ enterPolicy: "allow", pressEnter: true }),
      draft({ warnings: ["source-missing"] }),
    ]) {
      expect(shouldOpenPreflight(complex, "smart")).toBe(true);
    }
  });

  it("smart 下图片已全部通过隐私扫描（零发现）直发；回执不齐或防火墙关闭仍预检", () => {
    const readyImage = (file: string): ImageFirewallItem => ({
      originalFile: file,
      sendFile: file,
      status: "ready",
      pixelHash: `hash-${file}`,
      redactedPixelHash: null,
      width: 100,
      height: 60,
      scanRevision: 1,
      findings: [],
      redactedFindingIds: [],
      keptFindingIds: [],
      manualRegions: [],
      rawConfirmation: null,
      failureMessage: null,
    });

    // 每张图都有 ready 且零发现的回执 → 自动直发，省一步确认
    const cleared = draft({
      imageFiles: ["one.png", "two.png"],
      imageFirewall: [readyImage("one.png"), readyImage("two.png")],
    });
    expect(shouldOpenPreflight(cleared, "smart")).toBe(false);

    // 回执数量与图片数不齐 → 弹（防御 draft 构造不同步的静默放行）
    const missingReceipt = draft({
      imageFiles: ["one.png", "two.png"],
      imageFirewall: [readyImage("one.png")],
    });
    expect(shouldOpenPreflight(missingReceipt, "smart")).toBe(true);

    // 防火墙关闭：没检测过谈不上「无异常」→ 维持预检
    const firewallOff = draft({
      firewallEnabled: false,
      firewallStatus: "disabled",
      imageFiles: ["one.png"],
      imageFirewall: [{ ...readyImage("one.png"), status: "disabled" }],
    });
    expect(shouldOpenPreflight(firewallOff, "smart")).toBe(true);

    // 扫描有发现走防火墙分支 → 必弹，且 always 档不受直发豁免影响
    expect(shouldOpenPreflight(cleared, "always")).toBe(true);
  });
});

describe("rebuildPreflightDraft", () => {
  it("格式与 Prompt 只重建本次 Draft，保留目标和发送策略", () => {
    const original = draft({
      sourceItemIds: ["one"],
      selectionItemIds: ["one"],
      keepPanel: true,
    });
    const buildState: DeliveryDraftBuildState = {
      notes: [
        {
          id: "one",
          text: "const answer = 42",
          sectionId: "inbox",
          done: false,
          createdAt: 1,
          codeLang: "typescript",
        },
      ],
      tasks: [],
      promptSnippets: [
        {
          id: "review",
          label: "审查",
          text: "审查：{内容}",
          groupId: "general",
        },
      ],
      checkedItemIds: ["one", "later"],
      targetSnapshot: { ...target, token: "new-token" },
      profileResolution,
      panelPinned: false,
      dataGeneration: 999,
      firewallEnabled: true,
      firewallDisabledWarnCategories: [],
      aliasEntitiesEnabled: true,
      aliasEntities: [],
    };

    const rebuilt = rebuildPreflightDraft(
      original,
      {
        format: "code",
        promptSnippetId: "review",
        promptTemplate: "审查：{内容}",
      },
      buildState,
      7
    );

    expect(rebuilt.revision).toBe(7);
    expect(rebuilt.finalText).toBe(
      "审查：```typescript\nconst answer = 42\n```"
    );
    expect(rebuilt.assembledText).toBe(rebuilt.finalText);
    expect(rebuilt.targetSnapshot).toEqual(original.targetSnapshot);
    expect(rebuilt.selectionItemIds).toEqual(["one"]);
    expect(rebuilt.dataGeneration).toBe(original.dataGeneration);
    expect(rebuilt.keepPanel).toBe(true);
    expect(original.finalText).toBe("正文");
  });

  it("预检切换去 Markdown 后重建实际正文并保留原始来源", () => {
    const original = draft({
      sourceItemIds: ["one"],
      selectionItemIds: ["one"],
      rawText: "# 标题\n\n**正文**",
      assembledText: "# 标题\n\n**正文**",
      finalText: "# 标题\n\n**正文**",
    });
    const buildState: DeliveryDraftBuildState = {
      notes: [{
        id: "one",
        text: "# 标题\n\n**正文**",
        sectionId: "inbox",
        done: false,
        createdAt: 1,
      }],
      tasks: [],
      promptSnippets: [],
      checkedItemIds: ["one"],
      targetSnapshot: target,
      profileResolution,
      panelPinned: false,
      dataGeneration: 1,
      firewallEnabled: true,
      firewallDisabledWarnCategories: [],
      aliasEntitiesEnabled: true,
      aliasEntities: [],
    };
    const rebuilt = rebuildPreflightDraft(
      original,
      { format: "plain", markdownMode: "strip" },
      buildState,
      2
    );

    expect(rebuilt.rawText).toBe("# 标题\n\n**正文**");
    expect(rebuilt.finalText).toBe("标题\n\n正文");
    expect(rebuilt.markdownMode).toBe("strip");

    const code = rebuildPreflightDraft(
      rebuilt,
      { format: "code", markdownMode: "preserve" },
      buildState,
      3
    );
    expect(code.rawText).toBe("# 标题\n\n**正文**");
    expect(code.finalText).toBe("```\n# 标题\n\n**正文**\n```");
    expect(code.markdownMode).toBe("preserve");
  });

  it("确认新目标会保留本次内容与图片遮挡，但撤销旧目标的原文放行", () => {
    const nextTarget: TargetSnapshot = {
      ...target,
      token: "target-b-token",
      bundleId: "com.example.target-b",
      appName: "Target B",
      pid: 84,
      launchedAtMs: 40,
      revision: 2,
    };
    const nextResolution: TargetProfileResolution = {
      ...profileResolution,
      profileId: "target-b",
      targetBundleId: nextTarget.bundleId,
      promptGroup: { id: "coding", name: "编码", order: 1 },
      profile: {
        ...profileResolution.profile,
        id: "target-b",
        bundleIds: [nextTarget.bundleId!],
        promptGroupId: "coding",
        defaultFormat: "code",
        enterPolicy: "confirm",
        privacyPolicy: "confirmRaw",
        keepPanel: true,
      },
    };
    const original = draft({
      finalText: "用户修改后的正文",
      markdownMode: "strip",
      privacyDecision: {
        excludedFindingIds: ["text-secret"],
        rawConfirmation: {
          revision: 1,
          targetToken: target.token,
          level: "warn",
        },
        replacedCount: 2,
      },
      originalImageFiles: ["screen.png"],
      imageFiles: ["toskr-redacted:screen.png"],
      imageFirewall: [{
        originalFile: "screen.png",
        sendFile: "toskr-redacted:screen.png",
        status: "ready",
        pixelHash: "a".repeat(64),
        redactedPixelHash: "b".repeat(64),
        width: 100,
        height: 80,
        scanRevision: 1,
        findings: [],
        redactedFindingIds: ["image-secret"],
        keptFindingIds: [],
        manualRegions: [],
        rawConfirmation: {
          revision: 1,
          targetToken: target.token,
          level: "warn",
        },
        failureMessage: null,
      }],
      keepPanel: false,
    });

    const rebound = rebindPreflightDraftTarget(
      original,
      {
        targetSnapshot: nextTarget,
        profileResolution: nextResolution,
        firewallEnabled: true,
        firewallDisabledWarnCategories: [],
      },
      7
    );

    expect(rebound).toMatchObject({
      revision: 7,
      finalText: "用户修改后的正文",
      format: "plain",
      targetProfileId: "target-b",
      promptGroupId: "coding",
      profileDefaultFormat: "code",
      profileDefaultMarkdownMode: "preserve",
      markdownMode: "strip",
      privacyPolicy: "confirmRaw",
      enterPolicy: "confirm",
      enterDecisionConfirmed: false,
      pressEnter: false,
      keepPanel: false,
    });
    expect(rebound.targetSnapshot).toEqual(nextTarget);
    expect(rebound.imageFiles).toEqual(["toskr-redacted:screen.png"]);
    expect(rebound.imageFirewall[0].rawConfirmation).toBeNull();
    expect(rebound.privacyDecision).toEqual({
      excludedFindingIds: [],
      rawConfirmation: null,
      replacedCount: 2,
    });
  });
});

describe("preflight controller", () => {
  beforeEach(() => {
    resetDeliveryStore();
    resetTargetState();
  });

  it("复杂 Draft 只打开预检，不提前执行", async () => {
    const execute = vi.fn(async () => sentResult(draft()));
    const complex = draft({ imageFiles: ["one.png"] });

    await dispatchDeliveryDraft(complex, { execute });

    expect(execute).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState()).toMatchObject({
      open: true,
      draft: complex,
      busy: false,
    });
  });

  it("快速发送先扫描；出现 finding 时升级预检且不调用执行器", async () => {
    const execute = vi.fn();
    const scan = vi.fn(async () => ({
      findings: [{
        id: "email-1",
        category: "email" as const,
        severity: "warn" as const,
        startUtf16: 0,
        endUtf16: 2,
        maskedPreview: "正••",
        suggestedPlaceholder: "[EMAIL]",
        ruleId: "test.email",
      }],
      warnings: [],
      inputUtf16: 2,
      scannedUtf16: 2,
      complete: true,
    }));

    await dispatchDeliveryDraft(draft({ firewallStatus: "idle" }), {
      execute,
      scan,
    });

    expect(scan).toHaveBeenCalledWith("正文");
    expect(execute).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState()).toMatchObject({ open: true });
    expect(useDeliveryStore.getState().draft?.findings).toHaveLength(1);
  });

  it("重复 Cmd+Enter 只执行一次，成功后清理会话正文", async () => {
    const value = draft({ imageFiles: ["one.png"] });
    useDeliveryStore.getState().openDraft(value);
    let finish!: (result: SendDeliveryResult) => void;
    const execute = vi.fn(
      () => new Promise<SendDeliveryResult>((resolve) => { finish = resolve; })
    );

    const first = submitPreflightDraft({ execute, inspect: () => null });
    const duplicate = await submitPreflightDraft({ execute, inspect: () => null });
    expect(duplicate).toBeNull();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(value);

    finish(sentResult(value));
    await first;
    expect(useDeliveryStore.getState()).toMatchObject({
      open: false,
      draft: null,
      busy: false,
    });
  });

  it("AI 转换在途时 Cmd+Enter 不会把旧 finalText 提前发送", async () => {
    const value = draft();
    useDeliveryStore.getState().openDraft(value);
    useDeliveryStore.getState().beginTransform({
      requestId: "transform-running",
      draftId: value.id,
      draftRevision: value.revision,
      recipeId: "summarize",
      provider: "Test",
      model: "model",
      inputChars: value.finalText.length,
      startedAtMs: 1,
    });
    const execute = vi.fn();

    await submitPreflightDraft({ execute, inspect: () => null });

    expect(execute).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState().lastError).toContain("AI 转换正在生成");
  });

  it("失败后保留 Draft，可继续编辑和重试", async () => {
    const value = draft({ imageFiles: ["one.png"] });
    useDeliveryStore.getState().openDraft(value);

    await submitPreflightDraft({
      execute: vi.fn(async () => blockedResult(value)),
      inspect: () => null,
      rebase: () => null,
    });

    expect(useDeliveryStore.getState().open).toBe(true);
    expect(useDeliveryStore.getState().draft).toBe(value);
    expect(useDeliveryStore.getState().busy).toBe(false);
    expect(useDeliveryStore.getState().lastError).toBe("发送未完成，可以修改后重试");
  });

  it("Native 调用前中止不会锁死 Draft，用户仍可修改并重试", async () => {
    const value = draft({ imageFiles: ["one.png"] });
    useDeliveryStore.getState().openDraft(value);
    const execute = vi.fn(async () => null);

    await submitPreflightDraft({ execute, inspect: () => null });
    useDeliveryStore.getState().setFinalText("失败后继续修改");
    await submitPreflightDraft({ execute, inspect: () => null });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(useDeliveryStore.getState().retryBlocked).toBe(false);
    expect(useDeliveryStore.getState().draft?.finalText).toBe("失败后继续修改");
    expect(useDeliveryStore.getState().lastError).toContain("可以修改后重试");
  });

  it("零粘贴失败且目标待恢复时仍可切换 Prompt 与格式", () => {
    const value = draft({ imageFiles: ["one.png"] });
    useDeliveryStore.getState().openDraft(value);
    useDeliveryStore.getState().setSafeRetryPending(true);
    useNotesStore.setState({
      notes: [
        {
          id: "one",
          text: "正文",
          sectionId: "inbox",
          done: false,
          createdAt: 1,
        },
      ],
      checkedIds: ["one"],
    });

    updateOpenPreflightDraft(
      { format: "code" },
      () => "target",
      () => null
    );

    expect(useDeliveryStore.getState().draft?.format).toBe("code");
    expect(useDeliveryStore.getState().safeRetryPending).toBe(true);
    expect(useDeliveryStore.getState().lastError).toBeNull();
  });

  it("A 的重新识别迟到时不会解除新会话 B 的 busy", async () => {
    const valueA = draft({ id: "draft-a", imageFiles: ["a.png"] });
    const valueB = draft({ id: "draft-b", imageFiles: ["b.png"] });
    useDeliveryStore.getState().openDraft(valueA);
    useDeliveryStore.getState().setSafeRetryPending(true);
    let finishRefresh!: (value: TargetSnapshot | null) => void;
    const refresh = vi.fn(
      () => new Promise<TargetSnapshot | null>((resolve) => { finishRefresh = resolve; })
    );
    const pendingA = submitPreflightDraft({
      inspect: () => "target",
      refresh,
      rebase: vi.fn(() => valueA),
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    useDeliveryStore.getState().closeDraft();
    useDeliveryStore.getState().openDraft(valueB);
    let finishB!: (value: SendDeliveryResult) => void;
    const executeB = vi.fn(
      () => new Promise<SendDeliveryResult>((resolve) => { finishB = resolve; })
    );
    const pendingB = submitPreflightDraft({ execute: executeB, inspect: () => null });
    await vi.waitFor(() => expect(executeB).toHaveBeenCalledOnce());
    finishRefresh(target);
    await pendingA;

    expect(useDeliveryStore.getState()).toMatchObject({
      draft: valueB,
      open: true,
      busy: true,
    });

    finishB(sentResult(valueB));
    await pendingB;
    expect(useDeliveryStore.getState().open).toBe(false);
  });

  it("失败后同一目标的新 token 会替换进重试 Draft", async () => {
    const value = draft({ imageFiles: ["one.png"] });
    const retry = {
      ...value,
      revision: 2,
      targetSnapshot: { ...target, token: "refreshed-token" },
    };
    useDeliveryStore.getState().openDraft(value);

    await submitPreflightDraft({
      execute: vi.fn(async () => blockedResult(value)),
      inspect: () => null,
      rebase: () => retry,
    });

    expect(useDeliveryStore.getState().draft).toBe(retry);
    expect(useDeliveryStore.getState().lastError).toContain("可以修改后重试");
  });

  it("可能已经粘贴的回执禁止原 Draft 重试，避免重复外发", async () => {
    const value = draft({ imageFiles: ["one.png"] });
    useDeliveryStore.getState().openDraft(value);
    const execute = vi.fn(async () =>
      blockedResult(value, {
        reasonCode: "target_focus_drift",
        pasteCompleted: false,
      })
    );
    const rebase = vi.fn(() => ({ ...value, revision: 2 }));

    await submitPreflightDraft({ execute, inspect: () => null, rebase });
    await submitPreflightDraft({ execute, inspect: () => null, rebase });

    expect(execute).toHaveBeenCalledOnce();
    expect(rebase).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState().retryBlocked).toBe(true);
    expect(useDeliveryStore.getState().lastError).toContain("核对");

    updateOpenPreflightDraft({ format: "code" }, () => null);
    expect(useDeliveryStore.getState().draft).toBe(value);
    expect(useDeliveryStore.getState().retryBlocked).toBe(true);
  });

  it("只把 Native 保证在首次 paste 前的失败视为安全重试", () => {
    const value = draft();
    expect(deliveryRetryIsSafe(blockedResult(value))).toBe(true);
    expect(
      deliveryRetryIsSafe(
        blockedResult(value, {
          reasonCode: "target_focus_drift",
          pasteCompleted: false,
        })
      )
    ).toBe(false);
    expect(
      deliveryRetryIsSafe(
        blockedResult(value, {
          reasonCode: "enter_failed",
          status: "failed",
          pasteCompleted: true,
        })
      )
    ).toBe(false);
  });

  it("stale 来源不能靠切换格式或 Prompt 偷偷重建为新基线", () => {
    const value = draft();
    useDeliveryStore.getState().openDraft(value);

    updateOpenPreflightDraft({ format: "code" }, () => "source");

    expect(useDeliveryStore.getState().draft).toBe(value);
    expect(useDeliveryStore.getState().lastError).toContain("来源内容已变化");
  });

  it("stale target 阻止执行并保留草稿", async () => {
    const value = draft({ imageFiles: ["one.png"] });
    useDeliveryStore.getState().openDraft(value);
    const execute = vi.fn(async () => sentResult(value));

    await submitPreflightDraft({ execute, inspect: () => "target" });

    expect(execute).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState().draft).toBe(value);
    expect(useDeliveryStore.getState().lastError).toContain("发送目标已变化");
  });

  it("真实目标 token 变化会把旧 Draft 标记为 stale", () => {
    useTargetStore.setState({
      status: "ready",
      snapshot: { ...target, token: "new-target-token" },
      profileOverrideNeedsConfirmation: false,
    });

    expect(inspectDeliveryDraft(draft())).toBe("target");
  });

  it("关闭预检只清理会话 Draft，不清空 Note 选择", () => {
    useNotesStore.setState({ checkedIds: ["one"] });
    useDeliveryStore.getState().openDraft(draft());

    useDeliveryStore.getState().closeDraft();

    expect(useDeliveryStore.getState().draft).toBeNull();
    expect(useNotesStore.getState().checkedIds).toEqual(["one"]);
  });

  it("把用户本次修改后的同一个 Draft 原样交给执行器", async () => {
    useDeliveryStore.getState().openDraft(
      draft({ enterPolicy: "confirm", enterDecisionConfirmed: false })
    );
    useDeliveryStore.getState().setFinalText("本次修改后的正文");
    useDeliveryStore.getState().setKeepPanel(true);
    useDeliveryStore.getState().confirmEnter(true);
    const submitted = useDeliveryStore.getState().draft!;
    const execute = vi.fn(async (value: DeliveryDraft) => sentResult(value));

    await submitPreflightDraft({ execute, inspect: () => null });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      id: submitted.id,
      finalText: submitted.finalText,
      keepPanel: true,
      pressEnter: true,
      firewallStatus: "ready",
    }));
  });
});

describe("recoverOpenPreflightTarget", () => {
  beforeEach(() => {
    resetDeliveryStore();
    resetTargetState();
  });

  it("同一目标身份仅 token 轮换时自动重基线，预检内容与隐私状态保留", () => {
    applyTargetEvent({ ...target, token: "token-next", revision: 2, capturedAtMs: 30 });
    const value = draft({ redactionMap: { 张三: "[USER_01]" }, aliasReplacedCount: 1 });
    useDeliveryStore.getState().openDraft(value);

    expect(recoverOpenPreflightTarget(() => null)).toBe(true);
    const next = useDeliveryStore.getState().draft!;
    expect(next.targetSnapshot?.token).toBe("token-next");
    expect(next.revision).toBeGreaterThan(value.revision);
    expect(next.finalText).toBe(value.finalText);
    expect(next.redactionMap).toEqual({ 张三: "[USER_01]" });
    expect(useDeliveryStore.getState().open).toBe(true);
  });

  it("目标身份变化（重启/换窗口）时拒绝自动重绑", () => {
    applyTargetEvent({
      ...target,
      token: "token-next",
      launchedAtMs: 99,
      revision: 2,
    });
    const value = draft();
    useDeliveryStore.getState().openDraft(value);

    expect(recoverOpenPreflightTarget(() => null)).toBe(false);
    expect(useDeliveryStore.getState().draft?.targetSnapshot?.token).toBe(target.token);
  });

  it("token 未变化时幂等 no-op；来源/方案漂移时拒绝恢复", () => {
    applyTargetEvent({ ...target });
    useDeliveryStore.getState().openDraft(draft());
    expect(recoverOpenPreflightTarget(() => null)).toBe(false);

    applyTargetEvent({ ...target, token: "token-next", revision: 2 });
    expect(recoverOpenPreflightTarget(() => "source")).toBe(false);
    expect(useDeliveryStore.getState().draft?.targetSnapshot?.token).toBe(target.token);
  });
});

describe("confirmOpenPreflightTargetChange", () => {
  beforeEach(() => {
    resetDeliveryStore();
    resetTargetState();
    useNotesStore.setState((state) => ({
      settings: {
        ...state.settings,
        firewallEnabled: true,
        firewallDisabledWarnCategories: [],
      },
    }));
  });

  it("把已识别的新目标同步绑定到原 Draft，无需关闭预检重来", () => {
    const nextTarget: TargetSnapshot = {
      ...target,
      token: "target-b-token",
      bundleId: "com.example.target-b",
      appName: "Target B",
      pid: 84,
      launchedAtMs: 40,
      revision: 2,
    };
    const nextResolution: TargetProfileResolution = {
      ...profileResolution,
      targetBundleId: nextTarget.bundleId,
      profile: {
        ...profileResolution.profile,
        bundleIds: [nextTarget.bundleId!],
      },
    };
    const original = draft({ finalText: "保留的手工修改" });
    useDeliveryStore.getState().openDraft(original);
    applyTargetEvent(nextTarget);

    expect(confirmOpenPreflightTargetChange({
      inspectFreshness: () => null,
      resolveProfile: () => nextResolution,
    })).toBe(true);

    const state = useDeliveryStore.getState();
    expect(state.open).toBe(true);
    expect(state.draft?.finalText).toBe("保留的手工修改");
    expect(state.draft?.targetSnapshot).toEqual(nextTarget);
    expect(state.draft?.revision).toBeGreaterThan(original.revision);
    expect(state.lastError).toBeNull();
  });

  it("来源已变化时不允许借确认新目标偷换草稿基线", () => {
    const nextTarget: TargetSnapshot = {
      ...target,
      token: "target-b-token",
      bundleId: "com.example.target-b",
      pid: 84,
      launchedAtMs: 40,
      revision: 2,
    };
    const original = draft();
    useDeliveryStore.getState().openDraft(original);
    applyTargetEvent(nextTarget);

    expect(confirmOpenPreflightTargetChange({
      inspectFreshness: () => "source",
      resolveProfile: () => profileResolution,
    })).toBe(false);
    expect(useDeliveryStore.getState().draft).toBe(original);
    expect(useDeliveryStore.getState().lastError).toContain("来源内容已变化");
  });

  it("用户看到的新目标在点击前再次变化时拒绝静默改绑", () => {
    const displayedTarget: TargetSnapshot = {
      ...target,
      token: "target-b-token",
      bundleId: "com.example.target-b",
      appName: "Target B",
      pid: 84,
      launchedAtMs: 40,
      revision: 2,
    };
    const currentTarget: TargetSnapshot = {
      ...displayedTarget,
      token: "target-c-token",
      bundleId: "com.example.target-c",
      appName: "Target C",
      pid: 126,
      launchedAtMs: 60,
      revision: 3,
    };
    const original = draft();
    useDeliveryStore.getState().openDraft(original);
    applyTargetEvent(currentTarget);

    expect(confirmOpenPreflightTargetChange({
      expectedTarget: displayedTarget,
      inspectFreshness: () => null,
      resolveProfile: () => profileResolution,
    })).toBe(false);
    expect(useDeliveryStore.getState().draft).toBe(original);
    expect(useDeliveryStore.getState().lastError).toContain("目标已再次变化");
  });
});
