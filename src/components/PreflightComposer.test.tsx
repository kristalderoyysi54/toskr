import { renderToStaticMarkup } from "react-dom/server";
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
      appIcon: vi.fn(async () => null),
      imageThumbUrl: vi.fn(async () => null),
    },
  };
});

import { PreflightComposer } from "./PreflightComposer";
import { TargetLensBar } from "./TargetLensBar";
import { buildDeliveryDraft } from "@/lib/delivery/buildDraft";
import {
  nextDeliveryDraftRevision,
  resetDeliveryDraftSession,
} from "@/lib/delivery/executeDraft";
import { currentTargetProfileResolution } from "@/lib/currentTargetProfile";
import { currentDataGeneration } from "@/lib/dataGeneration";
import {
  resetDeliveryStore,
  useDeliveryStore,
} from "@/store/deliveryStore";
import {
  defaultSettings,
  INBOX_ID,
  TASK_INBOX_ID,
  useNotesStore,
} from "@/store/notesStore";
import {
  applyTargetEvent,
  resetTargetState,
  useTargetStore,
} from "@/store/targetStore";
import { useUIStore } from "@/store/uiStore";
import type { TargetSnapshot } from "@/lib/tauri";

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

function syncServerSnapshots() {
  Object.assign(useDeliveryStore.getInitialState(), useDeliveryStore.getState());
  Object.assign(useNotesStore.getInitialState(), useNotesStore.getState());
  Object.assign(useTargetStore.getInitialState(), useTargetStore.getState());
  Object.assign(useUIStore.getInitialState(), useUIStore.getState());
}

describe("PreflightComposer", () => {
  beforeEach(() => {
    resetDeliveryDraftSession();
    resetDeliveryStore();
    resetTargetState();
    useNotesStore.setState({
      sections: [{ id: INBOX_ID, name: "收件箱" }],
      notes: [],
      tasks: [],
      taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }],
      checkedIds: [],
      settings: defaultSettings(),
      undoStack: [],
    });
    useUIStore.setState({ open: true, pinned: false });
    applyTargetEvent(target);
  });

  it("VoiceOver 可读目标、回车、warning、正文与按钮状态", () => {
    const id = useNotesStore.getState().addNote("需要发送的正文").id!;
    useNotesStore.getState().setChecked([id]);
    const revision = nextDeliveryDraftRevision();
    const draft = buildDeliveryDraft(
      {
        id: "preflight-a11y",
        revision,
        createdAtMs: 1,
        sourceKind: "note",
        sourceItemIds: [id],
      },
      {
        notes: useNotesStore.getState().notes,
        tasks: [],
        promptSnippets: useNotesStore.getState().settings.promptSnippets,
        checkedItemIds: [id],
        targetSnapshot: useTargetStore.getState().snapshot,
        profileResolution: currentTargetProfileResolution(),
        panelPinned: false,
        dataGeneration: currentDataGeneration(),
        firewallEnabled: true,
        firewallDisabledWarnCategories:
          useNotesStore.getState().settings.firewallDisabledWarnCategories,
        aliasEntitiesEnabled: true,
        aliasEntities: [],
      }
    );
    useDeliveryStore.getState().openDraft({
      ...draft,
      firewallStatus: "ready",
      enterPolicy: "confirm",
      enterDecisionConfirmed: false,
      pressEnter: false,
      warnings: ["source-missing"],
    });
    useTargetStore.setState({ status: "blocked", reason: "target_exited" });
    syncServerSnapshots();

    const html = renderToStaticMarkup(<PreflightComposer />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Codex");
    expect(html).toContain("粘贴后动作");
    expect(html).toContain("本次尚未确认");
    expect(html).toContain("本次不按回车");
    expect(html).toContain("本次粘贴后按回车");
    expect(html).toContain('type="radio"');
    expect(html).toContain('aria-label="发送警告"');
    expect(html).toContain("部分来源已不存在");
    expect(html).toContain('aria-label="最终发送内容"');
    expect(html).toContain("需要发送的正文");
    expect(html).toContain('aria-describedby="preflight-status"');
    expect(html).toContain("确认发送");
    expect(html).toContain('aria-label="重新检测当前文本"');
    expect(html).toContain("重新检测");
    expect(html).toContain("disabled");
  });

  it("横栏在同一浮层并排呈现概览与最终内容", () => {
    const id = useNotesStore.getState().addNote("横栏正文").id!;
    useNotesStore.getState().setChecked([id]);
    const revision = nextDeliveryDraftRevision();
    useDeliveryStore.getState().openDraft({
      ...buildDeliveryDraft(
        {
          id: "horizontal",
          revision,
          createdAtMs: 1,
          sourceKind: "note",
          sourceItemIds: [id],
        },
        {
          notes: useNotesStore.getState().notes,
          tasks: [],
          promptSnippets: useNotesStore.getState().settings.promptSnippets,
          checkedItemIds: [id],
          targetSnapshot: useTargetStore.getState().snapshot,
          profileResolution: currentTargetProfileResolution(),
          panelPinned: false,
          dataGeneration: currentDataGeneration(),
          firewallEnabled: true,
          firewallDisabledWarnCategories:
            useNotesStore.getState().settings.firewallDisabledWarnCategories,
          aliasEntitiesEnabled: true,
          aliasEntities: [],
        }
      ),
      firewallStatus: "ready",
    });
    syncServerSnapshots();

    const html = renderToStaticMarkup(<PreflightComposer horizontal />);
    expect(html).toContain("grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]");
    expect(html).toContain('aria-label="发送概览"');
    expect(html).toContain('aria-label="最终发送内容"');
    expect(html).not.toContain('role="tablist"');
  });

  it("安全演练预检明确展示 no-enter 锁且不提供回车单选项", () => {
    const id = useNotesStore.getState().addNote("安全演练正文").id!;
    useNotesStore.getState().setChecked([id]);
    const built = buildDeliveryDraft(
      {
        id: "safe-rehearsal-ui",
        revision: nextDeliveryDraftRevision(),
        createdAtMs: 1,
        sourceKind: "note",
        sourceItemIds: [id],
      },
      {
        notes: useNotesStore.getState().notes,
        tasks: [],
        promptSnippets: useNotesStore.getState().settings.promptSnippets,
        checkedItemIds: [id],
        targetSnapshot: useTargetStore.getState().snapshot,
        profileResolution: currentTargetProfileResolution(),
        panelPinned: false,
        dataGeneration: currentDataGeneration(),
        firewallEnabled: true,
        firewallDisabledWarnCategories: [],
        aliasEntitiesEnabled: true,
        aliasEntities: [],
      }
    );
    useDeliveryStore.getState().openDraft({
      ...built,
      safeRehearsal: true,
      firewallStatus: "ready",
      enterPolicy: "confirm",
      enterDecisionConfirmed: true,
      pressEnter: false,
      keepPanel: true,
    });
    syncServerSnapshots();

    const html = renderToStaticMarkup(<PreflightComposer />);

    expect(html).toContain("安全发送演练预检");
    expect(html).toContain("演练安全锁：只粘贴，不按回车");
    expect(html).toContain("安全粘贴");
    expect(html).not.toContain('name="preflight-enter-decision"');
  });

  it("已证明零粘贴的目标失效允许从同一 Draft 重新识别并重试", () => {
    const id = useNotesStore.getState().addNote("保留的本次修改").id!;
    useNotesStore.getState().setChecked([id]);
    useDeliveryStore.getState().openDraft({
      ...buildDeliveryDraft(
        {
          id: "safe-retry",
          revision: nextDeliveryDraftRevision(),
          createdAtMs: 1,
          sourceKind: "note",
          sourceItemIds: [id],
        },
        {
          notes: useNotesStore.getState().notes,
          tasks: [],
          promptSnippets: useNotesStore.getState().settings.promptSnippets,
          checkedItemIds: [id],
          targetSnapshot: useTargetStore.getState().snapshot,
          profileResolution: currentTargetProfileResolution(),
          panelPinned: false,
          dataGeneration: currentDataGeneration(),
          firewallEnabled: true,
          firewallDisabledWarnCategories:
            useNotesStore.getState().settings.firewallDisabledWarnCategories,
          aliasEntitiesEnabled: true,
          aliasEntities: [],
        }
      ),
      firewallStatus: "ready",
    });
    useDeliveryStore.getState().setSafeRetryPending(true);
    useTargetStore.setState({ status: "blocked", reason: "refresh_failed" });
    syncServerSnapshots();

    const html = renderToStaticMarkup(<PreflightComposer />);
    const recoveryButton = html.match(
      /<button[^>]*aria-describedby="preflight-status"[^>]*>[\s\S]*?<\/button>/
    )?.[0];

    expect(recoveryButton).toContain("重新识别并重试");
    expect(recoveryButton).not.toMatch(/\sdisabled(?:=|\s|>)/);
  });

  it("切到另一个已就绪目标时提供原地确认，不要求取消后重走发送", () => {
    const id = useNotesStore.getState().addNote("继续保留的预检正文").id!;
    useNotesStore.getState().setChecked([id]);
    useDeliveryStore.getState().openDraft({
      ...buildDeliveryDraft(
        {
          id: "confirm-target-change",
          revision: nextDeliveryDraftRevision(),
          createdAtMs: 1,
          sourceKind: "note",
          sourceItemIds: [id],
        },
        {
          notes: useNotesStore.getState().notes,
          tasks: [],
          promptSnippets: useNotesStore.getState().settings.promptSnippets,
          checkedItemIds: [id],
          targetSnapshot: useTargetStore.getState().snapshot,
          profileResolution: currentTargetProfileResolution(),
          panelPinned: false,
          dataGeneration: currentDataGeneration(),
          firewallEnabled: true,
          firewallDisabledWarnCategories: [],
          aliasEntitiesEnabled: true,
          aliasEntities: [],
        }
      ),
      firewallStatus: "ready",
    });
    applyTargetEvent({
      ...target,
      token: "ishot-target-token",
      pid: 84,
      bundleId: "cc.ffitch.shot",
      appName: "iShot Pro",
      launchedAtMs: 300,
      capturedAtMs: 400,
      revision: 4,
    });
    syncServerSnapshots();

    const html = renderToStaticMarkup(<PreflightComposer />);
    const targetButton = html.match(
      /<button[^>]*aria-label="确认将发送目标改为 iShot Pro"[^>]*>[\s\S]*?<\/button>/
    )?.[0];

    expect(html).toContain("Codex → iShot Pro");
    expect(html).toContain("待确认新目标");
    expect(html).toContain("待重算方案");
    expect(html).toContain("当前为 iShot Pro，确认后将重算发送方案");
    expect(targetButton).toContain("确认新目标");
    expect(targetButton).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).not.toContain("取消后重新发起发送");
  });

  it("展示 Firewall 分类、遮罩、处理动作与高风险二次确认", () => {
    const id = useNotesStore.getState().addNote("fake_phase08_token").id!;
    useNotesStore.getState().setChecked([id]);
    const built = buildDeliveryDraft(
      {
        id: "privacy-ui",
        revision: nextDeliveryDraftRevision(),
        createdAtMs: 1,
        sourceKind: "note",
        sourceItemIds: [id],
      },
      {
        notes: useNotesStore.getState().notes,
        tasks: [],
        promptSnippets: useNotesStore.getState().settings.promptSnippets,
        checkedItemIds: [id],
        targetSnapshot: useTargetStore.getState().snapshot,
        profileResolution: currentTargetProfileResolution(),
        panelPinned: false,
        dataGeneration: currentDataGeneration(),
        firewallEnabled: true,
        firewallDisabledWarnCategories: [],
        aliasEntitiesEnabled: true,
        aliasEntities: [],
      }
    );
    useDeliveryStore.getState().openDraft({
      ...built,
      privacyPolicy: "allowRaw",
      firewallStatus: "ready",
      findings: [{
        id: "api-key-ui",
        category: "apiKey",
        severity: "block",
        startUtf16: 0,
        endUtf16: built.finalText.length,
        maskedPreview: "fa•••en",
        suggestedPlaceholder: "[API_KEY]",
        ruleId: "test.api-key",
      }],
      pressEnter: false,
    });
    syncServerSnapshots();

    const html = renderToStaticMarkup(<PreflightComposer />);
    expect(html).toContain('aria-label="本地隐私检查"');
    expect(html).toContain("API 密钥 · 高风险 ×1");
    expect(html).toContain("fa•••en");
    expect(html).toContain("替换为占位符");
    expect(html).toContain("同类全部替换");
    expect(html).toContain("保留原文发送");
    expect(html).toContain('aria-label="在正文中定位这一项"');
    // 单条命中时不出现批量按钮，降低误当选项卡的噪音
    expect(html).not.toContain("一键全部替换");
    expect(html).toContain("再次确认保留高风险原文");
  });

  it("图片预检展示区域框、原图与发送状态，未遮挡 block 时禁用发送", () => {
    const id = useNotesStore.getState().addNote("假敏感截图", {
      kind: "image",
      imageFile: "img-synthetic.png",
      imageW: 400,
      imageH: 200,
    }).id!;
    useNotesStore.getState().setChecked([id]);
    const built = buildDeliveryDraft(
      {
        id: "image-firewall-ui",
        revision: nextDeliveryDraftRevision(),
        createdAtMs: 1,
        sourceKind: "note",
        sourceItemIds: [id],
      },
      {
        notes: useNotesStore.getState().notes,
        tasks: [],
        promptSnippets: useNotesStore.getState().settings.promptSnippets,
        checkedItemIds: [id],
        targetSnapshot: useTargetStore.getState().snapshot,
        profileResolution: currentTargetProfileResolution(),
        panelPinned: false,
        dataGeneration: currentDataGeneration(),
        firewallEnabled: true,
        firewallDisabledWarnCategories: [],
        aliasEntitiesEnabled: true,
        aliasEntities: [],
      }
    );
    useDeliveryStore.getState().openDraft({
      ...built,
      firewallStatus: "ready",
      imageFirewall: [{
        ...built.imageFirewall[0],
        status: "ready",
        pixelHash: "a".repeat(64),
        width: 400,
        height: 200,
        scanRevision: 1,
        findings: [{
          id: "image-api-key",
          observationIndex: 0,
          category: "apiKey",
          severity: "block",
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.15 },
          pixelBox: { x: 38, y: 38, width: 204, height: 34 },
          maskedPreview: "sk••••89",
          ruleId: "test.image-api-key",
        }],
      }],
    });
    syncServerSnapshots();

    const html = renderToStaticMarkup(<PreflightComposer />);

    expect(html).toContain('aria-label="图片隐私检查"');
    expect(html).toContain("请遮挡全部图片敏感区域");
    expect(html).toContain("原图");
    expect(html).toContain('aria-label="查看图片 1 原图"');
    expect(html).toContain('title="点击查看原图"');
    expect(html).toContain("遮挡此文字区域");
    expect(html).toContain("遮挡全部图片敏感区域");
    expect(html).toContain('aria-label="重新检测当前文本和原始图片"');
    expect(html).toContain("left:10%");
    // 2:1 原图在 4:3 contain 预览中上下留白，区域框必须随真实画面偏移。
    expect(html).toContain("top:30%");
    const submit = html.match(
      /<button[^>]*aria-describedby="preflight-status"[^>]*>[\s\S]*?<\/button>/
    )?.[0];
    expect(submit).toContain("disabled");

    useDeliveryStore.setState((state) => ({
      draft: state.draft
        ? {
            ...state.draft,
            imageFiles: ["toskr-redacted:preview.png"],
            imageFirewall: state.draft.imageFirewall.map((item) => ({
              ...item,
              sendFile: "toskr-redacted:preview.png",
              redactedPixelHash: "b".repeat(64),
              redactedFindingIds: ["image-api-key"],
            })),
          }
        : null,
    }));
    syncServerSnapshots();
    const redactedHtml = renderToStaticMarkup(<PreflightComposer />);
    expect(redactedHtml).toContain('aria-label="查看图片 1 实际发送图"');
    expect(redactedHtml).toContain('title="点击查看实际发送图"');
  });

  it("内容页展示富内容图片附件，并提供逐张查看入口", () => {
    const id = useNotesStore.getState().addNote("调用方旧文本会被忽略", {
      contentBlocks: [
        { type: "text", text: "第一段" },
        { type: "image", file: "screen-a.png" },
        { type: "text", text: "第二段" },
        { type: "image", file: "screen-b.png" },
      ],
    }).id!;
    useNotesStore.getState().setChecked([id]);
    const built = buildDeliveryDraft(
      {
        id: "rich-attachments-ui",
        revision: nextDeliveryDraftRevision(),
        createdAtMs: 1,
        sourceKind: "note",
        sourceItemIds: [id],
      },
      {
        notes: useNotesStore.getState().notes,
        tasks: [],
        promptSnippets: useNotesStore.getState().settings.promptSnippets,
        checkedItemIds: [id],
        targetSnapshot: useTargetStore.getState().snapshot,
        profileResolution: currentTargetProfileResolution(),
        panelPinned: false,
        dataGeneration: currentDataGeneration(),
        firewallEnabled: true,
        firewallDisabledWarnCategories: [],
        aliasEntitiesEnabled: true,
        aliasEntities: [],
      }
    );
    useDeliveryStore.getState().openDraft({ ...built, firewallStatus: "ready" });
    useDeliveryStore.getState().setActiveSection("content");
    syncServerSnapshots();

    const html = renderToStaticMarkup(<PreflightComposer />);

    expect(built.originalImageFiles).toEqual(["screen-a.png", "screen-b.png"]);
    expect(html).toContain('aria-label="图片附件原图，共 2 张"');
    expect(html).toContain("2 张 · 点击查看原图");
    expect(html).toContain('aria-label="查看附件原图 1，共 2 张"');
    expect(html).toContain('aria-label="查看附件原图 2，共 2 张"');
    expect(html.match(/aria-label="查看附件原图/g)).toHaveLength(2);
  });

  it("AI 转换预览已按用户反馈移除：即使 AI 已配置也不出现入口", () => {
    useNotesStore.setState((state) => ({
      settings: {
        ...state.settings,
        aiEnabled: true,
        aiBaseUrl: "https://api.deepseek.com",
        aiModel: "deepseek-chat",
      },
    }));
    const id = useNotesStore.getState().addNote("四字正文").id!;
    useNotesStore.getState().setChecked([id]);
    const built = buildDeliveryDraft(
      {
        id: "ai-transform-ui",
        revision: nextDeliveryDraftRevision(),
        createdAtMs: 1,
        sourceKind: "note",
        sourceItemIds: [id],
      },
      {
        notes: useNotesStore.getState().notes,
        tasks: [],
        promptSnippets: useNotesStore.getState().settings.promptSnippets,
        checkedItemIds: [id],
        targetSnapshot: useTargetStore.getState().snapshot,
        profileResolution: currentTargetProfileResolution(),
        panelPinned: false,
        dataGeneration: currentDataGeneration(),
        firewallEnabled: true,
        firewallDisabledWarnCategories: [],
        aliasEntitiesEnabled: true,
        aliasEntities: [],
      }
    );
    useDeliveryStore.getState().openDraft({ ...built, firewallStatus: "ready" });
    syncServerSnapshots();

    const html = renderToStaticMarkup(<PreflightComposer />);
    expect(html).not.toContain("AI 显式转换");
    expect(html).not.toContain("AI 转换预览");
    expect(html).not.toContain("生成预览");
    expect(html).not.toContain("deepseek-chat");
    // 预检主体仍完整
    expect(html).toContain("本地隐私检查");
    expect(html).toContain('id="preflight-final-text"');
  });

  it("50,000 条历史下 Target Lens 与 Preflight 不渲染整份历史", () => {
    const notes = Array.from({ length: 50_000 }, (_, index) => ({
      id: `history-${index}`,
      text: `历史正文 ${index}`,
      sectionId: INBOX_ID,
      done: false,
      createdAt: index,
    }));
    const source = notes.at(-1)!;
    useNotesStore.setState({ notes, checkedIds: [source.id] });
    const built = buildDeliveryDraft(
      {
        id: "history-scale",
        revision: nextDeliveryDraftRevision(),
        createdAtMs: 1,
        sourceKind: "note",
        sourceItemIds: [source.id],
      },
      {
        notes,
        tasks: [],
        promptSnippets: useNotesStore.getState().settings.promptSnippets,
        checkedItemIds: [source.id],
        targetSnapshot: useTargetStore.getState().snapshot,
        profileResolution: currentTargetProfileResolution(),
        panelPinned: false,
        dataGeneration: currentDataGeneration(),
        firewallEnabled: true,
        firewallDisabledWarnCategories: [],
        aliasEntitiesEnabled: true,
        aliasEntities: [],
      }
    );
    useDeliveryStore.getState().openDraft({ ...built, firewallStatus: "ready" });
    syncServerSnapshots();
    const startedAt = performance.now();

    const html = renderToStaticMarkup(
      <>
        <TargetLensBar />
        <PreflightComposer />
      </>
    );
    const elapsedMs = performance.now() - startedAt;

    expect(html).toContain(source.text);
    expect(html).toContain("发送预检");
    expect(html.length).toBeLessThan(150_000);
    expect(elapsedMs).toBeLessThan(2_500);
  });
});

describe("PreflightComposer 可逆化名分区", () => {
  beforeEach(() => {
    resetDeliveryDraftSession();
    resetDeliveryStore();
    resetTargetState();
    useNotesStore.setState({
      sections: [{ id: INBOX_ID, name: "收件箱" }],
      notes: [],
      tasks: [],
      taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }],
      checkedIds: [],
      settings: {
        ...defaultSettings(),
        aliasEntities: [
          {
            id: "alias-user",
            category: "USER",
            originalText: "张三",
            placeholder: "[USER_01]",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      },
      undoStack: [],
    });
    useUIStore.setState({ open: true, pinned: false });
    applyTargetEvent(target);
  });

  function openAliasedDraft() {
    const id = useNotesStore.getState().addNote("请通知张三到场").id!;
    useNotesStore.getState().setChecked([id]);
    const settings = useNotesStore.getState().settings;
    const draft = buildDeliveryDraft(
      {
        id: "preflight-alias",
        revision: nextDeliveryDraftRevision(),
        createdAtMs: 1,
        sourceKind: "note",
        sourceItemIds: [id],
      },
      {
        notes: useNotesStore.getState().notes,
        tasks: [],
        promptSnippets: settings.promptSnippets,
        checkedItemIds: [id],
        targetSnapshot: useTargetStore.getState().snapshot,
        profileResolution: currentTargetProfileResolution(),
        panelPinned: false,
        dataGeneration: currentDataGeneration(),
        firewallEnabled: true,
        firewallDisabledWarnCategories: settings.firewallDisabledWarnCategories,
        aliasEntitiesEnabled: settings.aliasEntitiesEnabled,
        aliasEntities: settings.aliasEntities,
      }
    );
    useDeliveryStore.getState().openDraft({ ...draft, firewallStatus: "ready" });
    return draft;
  }

  it("展示已自动替换的词典命中与还原按钮", () => {
    const draft = openAliasedDraft();
    expect(draft.finalText).toBe("请通知[USER_01]到场");
    syncServerSnapshots();
    const html = renderToStaticMarkup(<PreflightComposer />);
    expect(html).toContain("可逆化名");
    expect(html).toContain("已自动替换 1 处");
    expect(html).toContain("张三 → [USER_01]");
    expect(html).toContain("还原为原文");
  });

  it("还原一处后分区收缩且正文恢复原文", () => {
    openAliasedDraft();
    const current = useDeliveryStore.getState().draft!;
    const start = current.finalText.indexOf("[USER_01]");
    useDeliveryStore.getState().revertAliasFinding({
      startUtf16: start,
      endUtf16: start + "[USER_01]".length,
      placeholder: "[USER_01]",
      originalText: "张三",
    });
    expect(useDeliveryStore.getState().draft!.finalText).toBe("请通知张三到场");
    syncServerSnapshots();
    const html = renderToStaticMarkup(<PreflightComposer />);
    expect(html).not.toContain("可逆化名");
  });

  it("总开关关闭时不渲染分区", () => {
    useNotesStore.setState((state) => ({
      settings: { ...state.settings, aliasEntitiesEnabled: false },
    }));
    const draft = openAliasedDraft();
    expect(draft.finalText).toBe("请通知张三到场");
    syncServerSnapshots();
    const html = renderToStaticMarkup(<PreflightComposer />);
    expect(html).not.toContain("可逆化名");
  });
});
