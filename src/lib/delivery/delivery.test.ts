import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  appIcon: vi.fn(),
  diagNote: vi.fn(),
  edgeHideNow: vi.fn(),
  getTargetSnapshot: vi.fn(),
  refreshTargetSnapshot: vi.fn(),
  refreshPrevApp: vi.fn(),
  sendDelivery: vi.fn(),
  scanSensitiveText: vi.fn(),
  showPanel: vi.fn(),
}));
const dialogMocks = vi.hoisted(() => ({ ask: vi.fn() }));

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => dialogMocks);
vi.mock("@/lib/tip", () => ({
  tip: vi.fn(),
  setPendingUndo: vi.fn(),
}));
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    api: { ...actual.api, ...apiMocks },
  };
});

import { buildDeliveryDraft, buildTaskMarkdown } from "./buildDraft";
import { submitPreflightDraft, updateOpenPreflightDraft } from "./preflight";
import {
  executeDeliveryDraft,
  inspectDeliveryDraft,
  invalidateDeliveryDrafts,
  nextDeliveryDraftRevision,
  resetDeliveryDraftSession,
} from "./executeDraft";
import type { DeliveryDraftBuildState, DeliveryDraftInput } from "./types";
import {
  defaultSettings,
  INBOX_ID,
  TASK_INBOX_ID,
  useNotesStore,
  type Note,
  type Task,
} from "@/store/notesStore";
import type {
  DeliveryStatus,
  SendDeliveryRequest,
  SendDeliveryResult,
  TargetSnapshot,
} from "@/lib/tauri";
import type { TargetProfileResolution } from "@/lib/targetProfiles";
import { currentTargetProfileResolution } from "@/lib/currentTargetProfile";
import { currentDataGeneration } from "@/lib/dataGeneration";
import { tip } from "@/lib/tip";
import { useDataOperationStore } from "@/store/dataOperationStore";
import { useUIStore } from "@/store/uiStore";
import {
  resetDeliveryStore,
  useDeliveryStore,
} from "@/store/deliveryStore";
import {
  applyTargetEvent,
  resetTargetState,
  setTargetProfileOverride,
  targetProfileIdentity,
  useTargetStore,
} from "@/store/targetStore";

const target: TargetSnapshot = {
  token: "target-token",
  pid: 42,
  bundleId: "com.openai.codex",
  appName: "Codex",
  launchedAtMs: 100,
  capturedAtMs: 200,
  revision: 3,
  ready: true,
  reason: null,
  windowId: null,
};

const profile: TargetProfileResolution = {
  profileId: "codex",
  profile: {
    id: "codex",
    name: "Codex",
    bundleIds: ["com.openai.codex"],
    promptGroupId: "engineering",
    defaultFormat: "plain",
    enterPolicy: "allow",
    privacyPolicy: "confirmRaw",
    keepPanel: false,
  },
  promptGroup: { id: "engineering", name: "工程", order: 1 },
  source: "exact",
  targetBundleId: "com.openai.codex",
  reason: "exact_bundle_match",
  isTargetReady: true,
  privacyCapabilityActive: false,
  safetyClamped: false,
  duplicateBundleProfileIds: ["codex"],
  ruleOverriddenKeys: [],
};

function note(id: string, text: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    text,
    sectionId: "inbox",
    done: false,
    createdAt: 1,
    ...overrides,
  };
}

function task(id: string, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    text,
    status: "todo",
    priority: "none",
    dueAt: null,
    createdAt: 1,
    remindedAt: null,
    ...overrides,
  };
}

function state(overrides: Partial<DeliveryDraftBuildState> = {}): DeliveryDraftBuildState {
  return {
    notes: [],
    tasks: [],
    promptSnippets: [],
    checkedItemIds: [],
    targetSnapshot: target,
    profileResolution: profile,
    panelPinned: false,
    dataGeneration: 7,
    firewallEnabled: true,
    firewallDisabledWarnCategories: [],
    aliasEntitiesEnabled: true,
    aliasEntities: [],
    ...overrides,
  };
}

function input(overrides: Partial<DeliveryDraftInput> = {}): DeliveryDraftInput {
  return {
    id: "draft-1",
    revision: 1,
    createdAtMs: 1_000,
    sourceKind: "note-batch",
    sourceItemIds: [],
    ...overrides,
  };
}

describe("buildDeliveryDraft", () => {
  it("按列表顺序构建正文，使用真实图片说明并按首次出现顺序去重附件", () => {
    const draft = buildDeliveryDraft(
      input({
        sourceItemIds: ["first", "image", "second"],
        promptSnippetId: "review",
        promptTemplate: "审查：\n{内容}",
      }),
      state({
        notes: [
          note("second", "第二条"),
          note("image", " 架构图 ", {
            kind: "image",
            imageFile: "diagram.png",
            attachments: ["detail.png", "diagram.png"],
          }),
          note("first", "第一条"),
        ],
      })
    );

    expect(draft.sourceItemIds).toEqual(["second", "image", "first"]);
    expect(draft.rawText).toBe("1. 第二条\n2. 架构图\n3. 第一条");
    expect(draft.finalText).toBe("审查：\n1. 第二条\n2. 架构图\n3. 第一条");
    expect(draft.originalImageFiles).toEqual(["diagram.png", "detail.png"]);
    expect(draft.imageFiles).toEqual(["diagram.png", "detail.png"]);
    expect(draft.imageFirewall).toEqual([
      expect.objectContaining({
        originalFile: "diagram.png",
        sendFile: "diagram.png",
        status: "idle",
      }),
      expect.objectContaining({
        originalFile: "detail.png",
        sendFile: "detail.png",
        status: "idle",
      }),
    ]);
    expect(draft).toMatchObject({
      id: "draft-1",
      revision: 1,
      createdAtMs: 1_000,
      format: "plain",
      promptSnippetId: "review",
      promptTemplate: "审查：\n{内容}",
      targetSnapshot: target,
      targetProfileId: "codex",
      promptGroupId: "engineering",
      enterPolicy: "allow",
      pressEnter: true,
      keepPanel: false,
      privacyPolicy: "confirmRaw",
      dataGeneration: 7,
      warnings: [],
    });
  });

  it("单张图文卡按块序生成交错段；正文被模板改动或多卡合选时退回默认顺序", () => {
    const richNote = note("rich", "开头\n结尾", {
      contentBlocks: [
        { type: "text", text: "开头" },
        { type: "image", file: "a.png" },
        { type: "text", text: "结尾" },
        { type: "image", file: "b.png" },
      ],
    });
    const draft = buildDeliveryDraft(
      input({ sourceKind: "note", sourceItemIds: ["rich"] }),
      state({ notes: [richNote] })
    );
    expect(draft.finalText).toBe("开头\n结尾");
    expect(draft.imageFiles).toEqual(["a.png", "b.png"]);
    expect(draft.segments).toEqual([
      { kind: "text", text: "开头" },
      { kind: "image", fileIndex: 0 },
      { kind: "text", text: "结尾" },
      { kind: "image", fileIndex: 1 },
    ]);

    // 模板改动了正文字节 → 交错段与已扫描正文无法逐字对应，必须退回
    const templated = buildDeliveryDraft(
      input({
        sourceKind: "note",
        sourceItemIds: ["rich"],
        promptTemplate: "请分析：{内容}",
      }),
      state({ notes: [richNote] })
    );
    expect(templated.segments).toBeNull();

    // 多卡合选走编号列表正文，同样不交错
    const batch = buildDeliveryDraft(
      input({ sourceItemIds: ["rich", "plain"] }),
      state({ notes: [richNote, note("plain", "另一条")] })
    );
    expect(batch.segments).toBeNull();
  });

  it("片段发送：单卡 sourceTextOverride 取代正文且图片不随行；多卡忽略覆盖", () => {
    const fragment = buildDeliveryDraft(
      input({
        sourceKind: "note",
        sourceItemIds: ["combo"],
        sourceTextOverride: "只发这一段",
      }),
      state({
        notes: [
          note("combo", "完整正文很长很长", {
            imageFile: "diagram.png",
            attachments: ["diagram.png"],
          }),
        ],
      })
    );
    expect(fragment.rawText).toBe("只发这一段");
    expect(fragment.finalText).toBe("只发这一段");
    expect(fragment.imageFiles).toEqual([]);
    expect(fragment.sourceItemIds).toEqual(["combo"]);
    // 覆盖必须随 Draft 留存：新鲜度复核按同一入参重建，否则片段被误判「来源已变化」
    expect(fragment.sourceTextOverride).toBe("只发这一段");

    const batch = buildDeliveryDraft(
      input({
        sourceItemIds: ["a", "b"],
        sourceTextOverride: "不该生效",
      }),
      state({ notes: [note("a", "甲"), note("b", "乙")] })
    );
    expect(batch.rawText).toBe("1. 甲\n2. 乙");
  });

  it("代码格式仅为单条保留语言，多条使用无语言代码块", () => {
    const single = buildDeliveryDraft(
      input({ sourceKind: "note", sourceItemIds: ["one"], format: "code" }),
      state({ notes: [note("one", "const n = 1", { codeLang: "typescript" })] })
    );
    const multiple = buildDeliveryDraft(
      input({ sourceItemIds: ["one", "two"], format: "code" }),
      state({
        notes: [
          note("one", "const n = 1", { codeLang: "typescript" }),
          note("two", "print(n)", { codeLang: "python" }),
        ],
      })
    );

    expect(single.finalText).toBe("```typescript\nconst n = 1\n```");
    expect(multiple.finalText).toBe("```\n1. const n = 1\n2. print(n)\n```");
  });

  it("图片尺寸占位不进入正文，链接仍按列表顺序参与 Draft", () => {
    const draft = buildDeliveryDraft(
      input({ sourceItemIds: ["image", "link"] }),
      state({
        notes: [
          note("image", "图片 800×600", {
            kind: "image",
            imageFile: "screen.png",
          }),
          note("link", "https://example.com", {
            kind: "link",
            url: "https://example.com",
          }),
        ],
      })
    );

    expect(draft.rawText).toBe("https://example.com");
    expect(draft.finalText).toBe("https://example.com");
    expect(draft.imageFiles).toEqual(["screen.png"]);
  });

  it("图片无说明时仍可由无占位模板生成安全正文", () => {
    const draft = buildDeliveryDraft(
      input({
        sourceKind: "note",
        sourceItemIds: ["image"],
        promptSnippetId: "analyze-image",
        promptTemplate: "请分析附件图片",
      }),
      state({
        notes: [
          note("image", "图片 20×10", {
            kind: "image",
            imageFile: "screen.png",
          }),
        ],
      })
    );

    expect(draft.rawText).toBe("");
    expect(draft.finalText).toBe("请分析附件图片");
    expect(draft.warnings).not.toContain("empty-payload");
  });

  it("无占位 Prompt 保持旧前缀语义，完全空载荷才标记 empty", () => {
    const prefixed = buildDeliveryDraft(
      input({
        sourceKind: "note",
        sourceItemIds: ["one"],
        promptTemplate: "请审查",
      }),
      state({ notes: [note("one", "正文")] })
    );
    const empty = buildDeliveryDraft(input(), state());

    expect(prefixed.finalText).toBe("请审查\n\n正文");
    expect(prefixed.warnings).toEqual([]);
    expect(empty.finalText).toBe("");
    expect(empty.imageFiles).toEqual([]);
    expect(empty.warnings).toContain("empty-payload");
  });

  it("把构建时勾选状态复制进 Draft，不保留可变数组引用", () => {
    const checkedItemIds = ["one"];
    const draft = buildDeliveryDraft(
      input({ sourceKind: "note", sourceItemIds: ["one"] }),
      state({ notes: [note("one", "正文")], checkedItemIds })
    );

    checkedItemIds.push("later");
    expect(draft.selectionItemIds).toEqual(["one"]);
  });

  it("confirm 默认不按回车，Pin 只影响 keepPanel", () => {
    const draft = buildDeliveryDraft(
      input({ sourceKind: "note", sourceItemIds: ["one"] }),
      state({
        notes: [note("one", "正文")],
        panelPinned: true,
        profileResolution: {
          ...profile,
          profile: { ...profile.profile, enterPolicy: "confirm" },
        },
      })
    );

    expect(draft.enterPolicy).toBe("confirm");
    expect(draft.pressEnter).toBe(false);
    expect(draft.keepPanel).toBe(true);
  });
});

describe("buildTaskMarkdown", () => {
  it("稳定组装标题、备注与 checklist", () => {
    expect(
      buildTaskMarkdown(
        task("task-1", "发布版本", {
          note: "先跑完整门禁",
          checklist: [
            { id: "a", text: "构建", done: true },
            { id: "b", text: "真机验证", done: false },
          ],
        })
      )
    ).toBe("发布版本\n\n备注：先跑完整门禁\n\n- [x] 构建\n- [ ] 真机验证");
  });
});

function deliveryResult(
  request: SendDeliveryRequest,
  status: DeliveryStatus
): SendDeliveryResult {
  return {
    deliveryId: request.deliveryId,
    status,
    reasonCode: status === "sent" ? "ok" : "target_not_frontmost",
    message: status === "sent" ? "已发送到 Codex" : "发送中止",
    target,
    pasteCompleted: status === "sent",
    enterPressed: request.pressEnter && status === "sent",
    clipboardOutcome: "nothingToRestore",
    startedAtMs: 1_000,
    finishedAtMs: 1_100,
  };
}

function resetExecution(status: DeliveryStatus = "sent") {
  resetDeliveryDraftSession();
  resetDeliveryStore();
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
  useUIStore.setState({
    open: true,
    pinned: false,
    edgeHideActive: false,
    edgeHidden: false,
    shortcutHoldOpen: false,
  });
  apiMocks.appIcon.mockReset().mockResolvedValue(null);
  resetTargetState();
  applyTargetEvent(target);
  apiMocks.diagNote.mockReset().mockResolvedValue(undefined);
  apiMocks.edgeHideNow.mockReset().mockResolvedValue(false);
  apiMocks.refreshTargetSnapshot.mockReset().mockResolvedValue(target);
  apiMocks.getTargetSnapshot.mockReset().mockResolvedValue(target);
  apiMocks.refreshPrevApp.mockReset();
  apiMocks.showPanel.mockReset().mockResolvedValue(undefined);
  apiMocks.scanSensitiveText.mockReset().mockImplementation(async (text: string) => ({
    findings: [],
    warnings: [],
    inputUtf16: text.length,
    scannedUtf16: text.length,
    complete: true,
  }));
  apiMocks.sendDelivery
    .mockReset()
    .mockImplementation(async (request: SendDeliveryRequest) =>
      deliveryResult(request, status)
    );
  dialogMocks.ask.mockReset().mockResolvedValue(true);
  vi.mocked(tip).mockClear();
}

function executableNoteDraft(ids: string[]) {
  const snapshot = useTargetStore.getState().snapshot;
  const revision = nextDeliveryDraftRevision();
  const draft = buildDeliveryDraft(
    input({
      id: `draft-${revision}`,
      revision,
      sourceKind: ids.length === 1 ? "note" : "note-batch",
      sourceItemIds: ids,
    }),
    {
      notes: useNotesStore.getState().notes,
      tasks: useNotesStore.getState().tasks,
      promptSnippets: useNotesStore.getState().settings.promptSnippets,
      checkedItemIds: useNotesStore.getState().checkedIds,
      targetSnapshot: snapshot,
      profileResolution: currentTargetProfileResolution(),
      panelPinned: useUIStore.getState().pinned,
      dataGeneration: currentDataGeneration(),
      firewallEnabled: useNotesStore.getState().settings.firewallEnabled,
      firewallDisabledWarnCategories:
        useNotesStore.getState().settings.firewallDisabledWarnCategories,
      aliasEntitiesEnabled:
        useNotesStore.getState().settings.aliasEntitiesEnabled,
      aliasEntities: useNotesStore.getState().settings.aliasEntities,
    }
  );
  return { ...draft, firewallStatus: "ready" as const };
}

describe("executeDeliveryDraft", () => {
  beforeEach(() => resetExecution());

  it("每次创建 Draft 都分配新的单调 revision", () => {
    expect(nextDeliveryDraftRevision()).toBe(1);
    expect(nextDeliveryDraftRevision()).toBe(2);
    expect(nextDeliveryDraftRevision()).toBe(3);
  });

  it("Pin 只决定本次 keepPanel，不会把刚创建的 Draft 误判为 Profile 变化", () => {
    useUIStore.setState({ pinned: true });
    const id = useNotesStore.getState().addNote("Pin 下预检").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);

    expect(draft.keepPanel).toBe(true);
    expect(draft.profileKeepPanel).toBe(false);
    expect(inspectDeliveryDraft(draft)).toBeNull();
  });

  it("Prompt 文本未变但被移到别组时，旧 Draft 仍判定来源过期", () => {
    const id = useNotesStore.getState().addNote("需要审查").id!;
    useNotesStore.getState().setChecked([id]);
    const snippet = {
      id: "moving-snippet",
      label: "移动中的模板",
      text: "审查：{内容}",
      groupId: "group-a",
    };
    const originalSettings = useNotesStore.getState().settings;
    useNotesStore.setState({
      settings: {
        ...originalSettings,
        promptSnippets: [...originalSettings.promptSnippets, snippet],
      },
    });
    const revision = nextDeliveryDraftRevision();
    const current = useNotesStore.getState();
    const draft = buildDeliveryDraft(
      input({
        id: "snippet-group-snapshot",
        revision,
        sourceKind: "note",
        sourceItemIds: [id],
        promptSnippetId: snippet.id,
        promptTemplate: snippet.text,
      }),
      {
        notes: current.notes,
        tasks: current.tasks,
        promptSnippets: current.settings.promptSnippets,
        checkedItemIds: current.checkedIds,
        targetSnapshot: useTargetStore.getState().snapshot,
        profileResolution: currentTargetProfileResolution(),
        panelPinned: false,
        dataGeneration: currentDataGeneration(),
        firewallEnabled: current.settings.firewallEnabled,
        firewallDisabledWarnCategories:
          current.settings.firewallDisabledWarnCategories,
        aliasEntitiesEnabled: current.settings.aliasEntitiesEnabled,
        aliasEntities: current.settings.aliasEntities,
      }
    );
    useNotesStore.setState({
      settings: {
        ...current.settings,
        promptSnippets: current.settings.promptSnippets.map((item) =>
          item.id === snippet.id ? { ...item, groupId: "group-b" } : item
        ),
      },
    });

    expect(draft.promptSnippetGroupId).toBe("group-a");
    expect(inspectDeliveryDraft(draft)).toBe("source");
  });

  it("目标与来源同时过期时，切格式不能把新正文洗成基线", () => {
    const id = useNotesStore.getState().addNote("旧正文").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);
    useDeliveryStore.getState().openDraft(draft);
    useDeliveryStore.getState().setSafeRetryPending(true);
    useTargetStore.setState({ status: "blocked", reason: "refresh_failed" });
    useNotesStore.getState().updateNoteText(id, "被外部修改的新正文");

    updateOpenPreflightDraft({ format: "code" });

    expect(useDeliveryStore.getState().draft).toBe(draft);
    expect(useDeliveryStore.getState().safeRetryPending).toBe(true);
    expect(useDeliveryStore.getState().lastError).toContain("来源内容已变化");
  });

  it("把 Draft 的最终字节交给 Native，且仅成功后更新笔记状态", async () => {
    const first = useNotesStore.getState().addNote("第一条").id!;
    const second = useNotesStore.getState().addNote("第二条").id!;
    useNotesStore.getState().setChecked([first, second]);
    const draft = executableNoteDraft([second, first]);

    const outcome = await executeDeliveryDraft(draft);

    expect(outcome?.status).toBe("sent");
    expect(apiMocks.sendDelivery).toHaveBeenCalledWith({
      targetToken: target.token,
      text: draft.finalText,
      imageFiles: draft.imageFiles,
      expectedImagePixelHashes: [],
      pressEnter: draft.pressEnter,
      keepPanel: draft.keepPanel,
      deliveryId: draft.id,
    });
    expect(useNotesStore.getState().notes.every((item) => item.done)).toBe(true);
    expect(useNotesStore.getState().checkedIds).toEqual([]);
    expect(useNotesStore.getState().settings.onboarding.sent).toBe(true);
  });

  it("贴边模式发送后只滑出收起，不把面板真隐藏", async () => {
    const id = useNotesStore.getState().addNote("贴边发送").id!;
    useNotesStore.getState().setChecked([id]);
    useUIStore.setState({
      edgeHideActive: true,
      edgeHidden: false,
      shortcutHoldOpen: true,
    });
    const draft = executableNoteDraft([id]);

    expect(draft.keepPanel).toBe(false);
    await executeDeliveryDraft(draft);

    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ keepPanel: true })
    );
    expect(apiMocks.edgeHideNow).toHaveBeenCalledWith(true);
    expect(useUIStore.getState()).toMatchObject({
      open: true,
      shortcutHoldOpen: false,
    });
  });

  it("从已滑出的贴边细条发送时保留唤回入口", async () => {
    const id = useNotesStore.getState().addNote("已贴边发送").id!;
    useNotesStore.getState().setChecked([id]);
    useUIStore.setState({
      edgeHideActive: true,
      edgeHidden: true,
      shortcutHoldOpen: false,
    });

    await executeDeliveryDraft(executableNoteDraft([id]));

    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ keepPanel: true })
    );
    expect(apiMocks.edgeHideNow).not.toHaveBeenCalled();
    expect(useUIStore.getState().open).toBe(true);
  });

  it("安全演练即使命中 allow 方案也只粘贴、不按回车", async () => {
    const id = useNotesStore.getState().addNote("安全演练正文").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = {
      ...executableNoteDraft([id]),
      safeRehearsal: true as const,
      enterDecisionConfirmed: true,
      pressEnter: true,
      keepPanel: true,
    };

    await executeDeliveryDraft(draft);

    expect(dialogMocks.ask).not.toHaveBeenCalled();
    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ pressEnter: false, keepPanel: true })
    );
  });

  it("未处理 block 在执行器最后一道门禁仍无法绕过", async () => {
    const id = useNotesStore.getState().addNote("api_key=fake_phase08_value").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);

    const outcome = await executeDeliveryDraft({
      ...draft,
      findings: [{
        id: "api-key-1",
        category: "apiKey",
        severity: "block",
        startUtf16: 0,
        endUtf16: 7,
        maskedPreview: "api•••ue",
        suggestedPlaceholder: "[API_KEY]",
        ruleId: "test.api-key",
      }],
    });

    expect(outcome).toBeNull();
    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(tip).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("请替换或明确保留")
    );
  });

  it("未遮挡的图片 block 在执行器最后门禁阻断，不触发 Native", async () => {
    const id = useNotesStore.getState().addNote("假敏感截图", {
      kind: "image",
      imageFile: "img-synthetic.png",
      imageW: 400,
      imageH: 200,
    }).id!;
    useNotesStore.getState().setChecked([id]);
    const built = executableNoteDraft([id]);
    const finding = {
      id: "image-block",
      observationIndex: 0,
      category: "apiKey" as const,
      severity: "block" as const,
      boundingBox: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
      pixelBox: { x: 38, y: 38, width: 164, height: 24 },
      maskedPreview: "sk••••89",
      ruleId: "test.image-api-key",
    };
    const draft = {
      ...built,
      imageFirewall: [{
        ...built.imageFirewall[0],
        status: "ready" as const,
        pixelHash: "a".repeat(64),
        width: 400,
        height: 200,
        scanRevision: 1,
        findings: [finding],
      }],
    };

    expect(await executeDeliveryDraft(draft)).toBeNull();
    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(tip).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("遮挡")
    );
  });

  it("图片遮挡后只把临时副本 token 交给 Native，来源校验仍绑定原图", async () => {
    const id = useNotesStore.getState().addNote("假敏感截图", {
      kind: "image",
      imageFile: "img-synthetic.png",
      imageW: 400,
      imageH: 200,
    }).id!;
    useNotesStore.getState().setChecked([id]);
    const built = executableNoteDraft([id]);
    const finding = {
      id: "image-block",
      observationIndex: 0,
      category: "apiKey" as const,
      severity: "block" as const,
      boundingBox: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
      pixelBox: { x: 38, y: 38, width: 164, height: 24 },
      maskedPreview: "sk••••89",
      ruleId: "test.image-api-key",
    };
    const sendFile = "toskr-redacted:redacted-content-hash.png";
    const draft = {
      ...built,
      imageFiles: [sendFile],
      imageFirewall: [{
        ...built.imageFirewall[0],
        sendFile,
        status: "ready" as const,
        pixelHash: "a".repeat(64),
        redactedPixelHash: "b".repeat(64),
        width: 400,
        height: 200,
        scanRevision: 1,
        findings: [finding],
        redactedFindingIds: [finding.id],
      }],
    };

    expect(inspectDeliveryDraft(draft)).toBeNull();
    expect((await executeDeliveryDraft(draft))?.status).toBe("sent");
    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        imageFiles: [sendFile],
        expectedImagePixelHashes: ["b".repeat(64)],
      })
    );
  });

  it("allowRaw 的 block 二次确认后仍强制关闭自动回车", async () => {
    const current = useNotesStore.getState();
    current.setSettings({
      targetProfiles: [{
        id: "raw-profile",
        name: "原文测试",
        bundleIds: [target.bundleId!],
        promptGroupId: "general",
        defaultFormat: "plain",
        enterPolicy: "allow",
        privacyPolicy: "allowRaw",
        keepPanel: false,
      }],
      defaultTargetProfileId: "raw-profile",
    });
    const id = current.addNote("fake-block-value").id!;
    current.setChecked([id]);
    const built = executableNoteDraft([id]);
    const draft = {
      ...built,
      findings: [{
        id: "block-1",
        category: "apiKey" as const,
        severity: "block" as const,
        startUtf16: 0,
        endUtf16: 5,
        maskedPreview: "fa•••ue",
        suggestedPlaceholder: "[API_KEY]",
        ruleId: "test.api-key",
      }],
      privacyDecision: {
        ...built.privacyDecision,
        rawConfirmation: {
          revision: built.scanRevision,
          targetToken: built.targetSnapshot?.token ?? null,
          level: "block" as const,
        },
      },
    };

    await executeDeliveryDraft(draft);

    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ pressEnter: false })
    );
    expect(apiMocks.getTargetSnapshot).toHaveBeenCalledOnce();
    expect(apiMocks.refreshTargetSnapshot).not.toHaveBeenCalled();
  });

  it("原文确认后的目标 token 若已轮换，执行器不会把旧确认搬到新能力", async () => {
    const current = useNotesStore.getState();
    current.setSettings({
      targetProfiles: [{
        id: "raw-profile",
        name: "原文测试",
        bundleIds: [target.bundleId!],
        promptGroupId: "general",
        defaultFormat: "plain",
        enterPolicy: "never",
        privacyPolicy: "allowRaw",
        keepPanel: false,
      }],
      defaultTargetProfileId: "raw-profile",
    });
    const id = current.addNote("fake-block-value").id!;
    current.setChecked([id]);
    const built = executableNoteDraft([id]);
    const draft = {
      ...built,
      findings: [{
        id: "block-1",
        category: "apiKey" as const,
        severity: "block" as const,
        startUtf16: 0,
        endUtf16: 5,
        maskedPreview: "fa•••ue",
        suggestedPlaceholder: "[API_KEY]",
        ruleId: "test.api-key",
      }],
      privacyDecision: {
        ...built.privacyDecision,
        rawConfirmation: {
          revision: built.scanRevision,
          targetToken: built.targetSnapshot?.token ?? null,
          level: "block" as const,
        },
      },
    };
    apiMocks.getTargetSnapshot.mockResolvedValueOnce({
      ...target,
      token: "rotated-target-token",
      revision: target.revision + 1,
    });

    expect(await executeDeliveryDraft(draft)).toBeNull();
    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(tip).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("重新确认原文发送")
    );
  });

  it("blocked 回执保持选择和卡片状态并恢复面板", async () => {
    resetExecution("blocked");
    const id = useNotesStore.getState().addNote("保留内容").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);

    const outcome = await executeDeliveryDraft(draft);

    expect(outcome?.status).toBe("blocked");
    expect(useNotesStore.getState().notes[0].done).toBe(false);
    expect(useNotesStore.getState().checkedIds).toEqual([id]);
    expect(useUIStore.getState().open).toBe(true);
    expect(apiMocks.showPanel).toHaveBeenCalledOnce();
  });

  it("Native 调用前目标刷新失败时保留可编辑、可重试的预检", async () => {
    const id = useNotesStore.getState().addNote("刷新失败仍保留").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);
    useDeliveryStore.getState().openDraft(draft);
    apiMocks.refreshTargetSnapshot.mockRejectedValueOnce(new Error("offline"));

    const outcome = await submitPreflightDraft();

    expect(outcome).toBeNull();
    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState().retryBlocked).toBe(false);
    expect(useDeliveryStore.getState().lastError).toContain("可以修改后重试");

    useDeliveryStore.getState().setFinalText("失败后修改");
    expect(useDeliveryStore.getState().draft?.finalText).toBe("失败后修改");
    expect(useDeliveryStore.getState().lastError).toBeNull();

    const recoveredTarget: TargetSnapshot = {
      ...target,
      token: "recovered-token",
      capturedAtMs: target.capturedAtMs + 1,
      revision: target.revision + 1,
    };
    apiMocks.refreshTargetSnapshot.mockResolvedValue(recoveredTarget);
    const retried = await submitPreflightDraft();

    expect(retried?.status).toBe("sent");
    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        targetToken: recoveredTarget.token,
        text: "失败后修改",
      })
    );
    expect(useDeliveryStore.getState().draft).toBeNull();
  });

  it("Native IPC 启动后的异常按结果不确定处理，禁止原 Draft 重投", async () => {
    const id = useNotesStore.getState().addNote("避免重复外发").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);
    useDeliveryStore.getState().openDraft(draft);
    apiMocks.sendDelivery.mockRejectedValueOnce(new Error("reply lost"));

    const outcome = await submitPreflightDraft();

    expect(outcome).toMatchObject({
      status: "failed",
      reasonCode: "internal_error",
      pasteCompleted: false,
    });
    expect(useDeliveryStore.getState().retryBlocked).toBe(true);
    expect(useDeliveryStore.getState().lastError).toContain("核对");
  });

  it("预检失败后只刷新同一目标的 token，Draft 可直接重试", async () => {
    const id = useNotesStore.getState().addNote("保留重试").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);
    const refreshedTarget = {
      ...target,
      token: "refreshed-token",
      revision: target.revision + 1,
      capturedAtMs: target.capturedAtMs + 1,
    };
    apiMocks.refreshTargetSnapshot.mockResolvedValue(refreshedTarget);
    apiMocks.sendDelivery.mockImplementation(async (request: SendDeliveryRequest) =>
      ({ ...deliveryResult(request, "blocked"), target: refreshedTarget })
    );
    useDeliveryStore.getState().openDraft(draft);

    await submitPreflightDraft();

    const retry = useDeliveryStore.getState().draft!;
    expect(retry.targetSnapshot?.token).toBe("refreshed-token");
    expect(retry.revision).toBeGreaterThan(draft.revision);
    expect(inspectDeliveryDraft(retry)).toBeNull();
    expect(useDeliveryStore.getState().lastError).toContain("可以修改后重试");
  });

  it("同一目标刷新轮换 token 不算目标变化，Draft 照常发出", async () => {
    const id = useNotesStore.getState().addNote("选中片段").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);
    // 详情窗「发送选中」关窗那一下必然触发一次刷新：同一进程/同一窗口，
    // 只有能力令牌与观测时钟在动
    const rotated: TargetSnapshot = {
      ...target,
      token: "rotated-token",
      revision: target.revision + 1,
      capturedAtMs: target.capturedAtMs + 1,
    };
    applyTargetEvent(rotated);
    apiMocks.refreshTargetSnapshot.mockResolvedValue(rotated);

    const outcome = await executeDeliveryDraft(draft);

    expect(outcome?.status).toBe("sent");
    // 下发用的是刷新后的能力令牌，不是 Draft 里那枚旧的
    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ targetToken: "rotated-token" })
    );
  });

  it("目标换成另一个进程时仍然拦下发送", async () => {
    const id = useNotesStore.getState().addNote("目标真的换了").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);
    applyTargetEvent({
      ...target,
      token: "other-token",
      pid: 84,
      launchedAtMs: 300,
      revision: target.revision + 1,
      capturedAtMs: target.capturedAtMs + 1,
    });

    await expect(executeDeliveryDraft(draft)).resolves.toBeNull();

    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(tip).toHaveBeenCalledWith("warn", "发送目标已变化，请确认后重试发送");
  });

  it("旧 revision 在执行前 fail-closed，不触发 Native 副作用", async () => {
    const id = useNotesStore.getState().addNote("旧草稿").id!;
    const draft = executableNoteDraft([id]);
    invalidateDeliveryDrafts();

    await expect(executeDeliveryDraft(draft)).resolves.toBeNull();

    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(tip).toHaveBeenCalledWith("warn", "发送已取消：发送内容已更新，请重试");
  });

  it("Native 回执晚于 revision 更新时丢弃状态副作用", async () => {
    const id = useNotesStore.getState().addNote("在途草稿").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);
    let resolve!: (value: SendDeliveryResult) => void;
    apiMocks.sendDelivery.mockImplementation(
      () => new Promise<SendDeliveryResult>((done) => { resolve = done; })
    );

    const pending = executeDeliveryDraft(draft);
    await vi.waitFor(() => expect(apiMocks.sendDelivery).toHaveBeenCalledOnce());
    invalidateDeliveryDrafts();
    const request = apiMocks.sendDelivery.mock.calls[0][0] as SendDeliveryRequest;
    resolve(deliveryResult(request, "sent"));
    await pending;

    expect(useNotesStore.getState().notes[0].done).toBe(false);
    expect(useNotesStore.getState().checkedIds).toEqual([id]);
    expect(useNotesStore.getState().settings.onboarding.sent).toBe(false);
  });

  it("发送途中分配未执行 Draft 不会作废当前原生回执", async () => {
    const id = useNotesStore.getState().addNote("当前发送").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);
    let resolve!: (value: SendDeliveryResult) => void;
    apiMocks.sendDelivery.mockImplementation(
      () => new Promise<SendDeliveryResult>((done) => { resolve = done; })
    );

    const pending = executeDeliveryDraft(draft);
    await vi.waitFor(() => expect(apiMocks.sendDelivery).toHaveBeenCalledOnce());
    expect(nextDeliveryDraftRevision()).toBe(draft.revision + 1);
    const request = apiMocks.sendDelivery.mock.calls[0][0] as SendDeliveryRequest;
    resolve(deliveryResult(request, "sent"));
    await pending;

    expect(useNotesStore.getState().notes[0].done).toBe(true);
    expect(useNotesStore.getState().checkedIds).toEqual([]);
  });

  it("Native 等待期间来源内容变化时不消费旧 Draft 回执", async () => {
    const id = useNotesStore.getState().addNote("发送前正文").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);
    let resolve!: (value: SendDeliveryResult) => void;
    apiMocks.sendDelivery.mockImplementation(
      () => new Promise<SendDeliveryResult>((done) => { resolve = done; })
    );

    const pending = executeDeliveryDraft(draft);
    await vi.waitFor(() => expect(apiMocks.sendDelivery).toHaveBeenCalledOnce());
    useNotesStore.getState().updateNoteText(id, "发送后编辑");
    const request = apiMocks.sendDelivery.mock.calls[0][0] as SendDeliveryRequest;
    resolve(deliveryResult(request, "sent"));
    await pending;

    expect(useNotesStore.getState().notes[0].done).toBe(false);
    expect(useNotesStore.getState().checkedIds).toEqual([id]);
    expect(tip).toHaveBeenCalledWith(
      "warn",
      "发送已完成，但来源内容已变化，未修改卡片状态"
    );
  });

  it("Native 等待期间新勾选内容时旧回执不得清除新选择", async () => {
    const id = useNotesStore.getState().addNote("正在发送").id!;
    const later = useNotesStore.getState().addNote("稍后选择").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);
    let resolve!: (value: SendDeliveryResult) => void;
    apiMocks.sendDelivery.mockImplementation(
      () => new Promise<SendDeliveryResult>((done) => { resolve = done; })
    );

    const pending = executeDeliveryDraft(draft);
    await vi.waitFor(() => expect(apiMocks.sendDelivery).toHaveBeenCalledOnce());
    useNotesStore.getState().setChecked([id, later]);
    const request = apiMocks.sendDelivery.mock.calls[0][0] as SendDeliveryRequest;
    resolve(deliveryResult(request, "sent"));
    await pending;

    expect(useNotesStore.getState().notes.find((item) => item.id === id)?.done).toBe(false);
    expect(useNotesStore.getState().checkedIds).toEqual([id, later]);
    expect(tip).toHaveBeenCalledWith(
      "warn",
      "发送已完成，但选择已变化，未修改卡片状态"
    );
  });

  it("A 的迟到成功回执不会清除 B 上新选的同名临时方案", async () => {
    const overrideId = useNotesStore.getState().settings.targetProfiles[0]!.id;
    setTargetProfileOverride(overrideId);
    const id = useNotesStore.getState().addNote("发送到 A").id!;
    useNotesStore.getState().setChecked([id]);
    const draft = executableNoteDraft([id]);
    expect(draft.profileSource).toBe("temporary");
    let resolve!: (value: SendDeliveryResult) => void;
    apiMocks.sendDelivery.mockImplementation(
      () => new Promise<SendDeliveryResult>((done) => { resolve = done; })
    );

    const pending = executeDeliveryDraft(draft);
    await vi.waitFor(() => expect(apiMocks.sendDelivery).toHaveBeenCalledOnce());
    const targetB: TargetSnapshot = {
      ...target,
      token: "target-b-token",
      pid: 84,
      launchedAtMs: 300,
      capturedAtMs: 400,
      revision: 4,
    };
    applyTargetEvent(targetB);
    setTargetProfileOverride(overrideId);
    const request = apiMocks.sendDelivery.mock.calls[0][0] as SendDeliveryRequest;
    resolve(deliveryResult(request, "sent"));
    await pending;

    expect(useTargetStore.getState().profileOverrideId).toBe(overrideId);
    expect(useTargetStore.getState().profileOverrideTargetIdentity).toBe(
      targetProfileIdentity(targetB)
    );
  });
});

describe("buildDeliveryDraft 词典化名", () => {
  const dictionary = [
    {
      id: "alias-user",
      category: "USER",
      originalText: "张三",
      placeholder: "[USER_01]",
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  ];

  it("开启时在构建阶段替换并记录映射与命中数", () => {
    const draft = buildDeliveryDraft(
      input({ sourceItemIds: ["n1"] }),
      state({
        notes: [note("n1", "请通知张三，让张三确认")],
        aliasEntities: dictionary,
      })
    );
    expect(draft.finalText).toBe("请通知[USER_01]，让[USER_01]确认");
    expect(draft.assembledText).toBe(draft.finalText);
    expect(draft.aliasReplacedCount).toBe(2);
    expect(draft.redactionMap).toEqual({ 张三: "[USER_01]" });
  });

  it("模板文字与正文一样参与化名（与隐私扫描待遇一致）", () => {
    const draft = buildDeliveryDraft(
      input({ sourceItemIds: ["n1"], promptTemplate: "转告张三：\n{内容}" }),
      state({
        notes: [note("n1", "会议改期")],
        aliasEntities: dictionary,
      })
    );
    expect(draft.finalText).toBe("转告[USER_01]：\n会议改期");
    expect(draft.aliasReplacedCount).toBe(1);
  });

  it("总开关关闭时保留原文且不产生映射", () => {
    const draft = buildDeliveryDraft(
      input({ sourceItemIds: ["n1"] }),
      state({
        notes: [note("n1", "请通知张三")],
        aliasEntitiesEnabled: false,
        aliasEntities: dictionary,
      })
    );
    expect(draft.finalText).toBe("请通知张三");
    expect(draft.aliasReplacedCount).toBe(0);
    expect(draft.redactionMap).toEqual({});
  });
});
