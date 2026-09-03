import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  refreshTargetSnapshot: vi.fn(),
  refreshPrevApp: vi.fn(),
  sendDelivery: vi.fn(),
  showPanel: vi.fn(),
  showTextPreview: vi.fn(),
  quickLook: vi.fn(),
  appIcon: vi.fn(),
  diagNote: vi.fn(),
  scanSensitiveText: vi.fn(),
  copyText: vi.fn(),
  copyImage: vi.fn(),
  copyRichClipboard: vi.fn(),
  exportNotesBundle: vi.fn(),
}));
const dialogMocks = vi.hoisted(() => ({ ask: vi.fn(), save: vi.fn() }));
const eventMocks = vi.hoisted(() => ({
  emit: vi.fn(),
  emitTo: vi.fn(),
  listen: vi.fn(),
  listeners: new Map<string, (event: { payload: Record<string, unknown> }) => void>(),
}));
const webviewMocks = vi.hoisted(() => ({ getByLabel: vi.fn() }));

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
vi.mock("@tauri-apps/api/event", () => eventMocks);
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: webviewMocks.getByLabel },
}));
vi.mock("@tauri-apps/plugin-dialog", () => dialogMocks);
vi.mock("@/lib/tip", () => ({
  tip: vi.fn(),
  setPendingUndo: vi.fn(),
}));
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      ...apiMocks,
    },
  };
});

import {
  armNoteEditUndo,
  copyNoteContent,
  exportNotesBundle,
  mergeCheckedWithUndo,
  moveClipsToNotesWithUndo,
  openNoteBatchDetail,
  openSafeRehearsalPreflight,
  openNoteDetail,
  restoreNoteAliasesWithUndo,
  sendCheckedToChat,
  sendNotesToChat,
  sendTaskToChat,
  warnWithPanel,
} from "./actions";
import { SAFE_REHEARSAL_TEXT } from "./onboarding";
import { submitPreflightDraft } from "./delivery/preflight";
import { setPendingUndo, tip } from "./tip";
import {
  advanceDataGeneration,
  hasDataGenerationLeases,
} from "./dataGeneration";
import type {
  DeliveryStatus,
  SendDeliveryRequest,
  SendDeliveryResult,
  TargetSnapshot,
} from "./tauri";
import {
  CLIPBOARD_ID,
  defaultSettings,
  INBOX_ID,
  TASK_INBOX_ID,
  useNotesStore,
} from "../store/notesStore";
import { useUIStore } from "../store/uiStore";
import { useDataOperationStore } from "../store/dataOperationStore";
import {
  resetDeliveryStore,
  useDeliveryStore,
} from "../store/deliveryStore";
import {
  applyTargetEvent,
  setTargetProfileOverride,
  observeTargetAfterBlur,
  resetTargetState,
  useTargetStore,
} from "../store/targetStore";
import {
  clearEditorSessionMedia,
  editorSessionMediaFiles,
} from "./editorSessionMedia";

const target: TargetSnapshot = {
  token: "token-1",
  pid: 42,
  bundleId: "com.openai.codex",
  appName: "Codex",
  launchedAtMs: 500,
  capturedAtMs: 900,
  revision: 1,
  ready: true,
  reason: null,
  windowId: null,
};

function result(
  request: SendDeliveryRequest,
  status: DeliveryStatus
): SendDeliveryResult {
  return {
    deliveryId: request.deliveryId,
    status,
    reasonCode:
      status === "sent"
        ? "ok"
        : status === "blocked"
          ? "target_not_frontmost"
          : "paste_failed",
    message:
      status === "sent" ? "已发送到 Codex" : "发送中止：目标应用未处于前台",
    target,
    pasteCompleted: status === "sent",
    enterPressed: false,
    clipboardOutcome: "nothingToRestore",
    startedAtMs: 1_000,
    finishedAtMs: 1_100,
  };
}

function reset(status: DeliveryStatus) {
  clearEditorSessionMedia();
  resetDeliveryStore();
  // 既有执行器回归保持直发；Preflight 行为由本阶段专用用例覆盖。
  useDeliveryStore.getState().setPreflightMode("off");
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
  useUIStore.setState({ open: true, pinned: false, detailEditorNoteId: null });
  apiMocks.appIcon.mockReset().mockResolvedValue(null);
  resetTargetState();
  applyTargetEvent(target);
  apiMocks.refreshTargetSnapshot.mockReset().mockResolvedValue(target);
  apiMocks.refreshPrevApp.mockReset();
  apiMocks.showPanel.mockReset().mockResolvedValue(undefined);
  apiMocks.showTextPreview.mockReset().mockResolvedValue(undefined);
  apiMocks.quickLook.mockReset().mockResolvedValue(undefined);
  apiMocks.copyText.mockReset().mockResolvedValue(undefined);
  apiMocks.copyImage.mockReset().mockResolvedValue(undefined);
  apiMocks.copyRichClipboard.mockReset().mockResolvedValue(undefined);
  apiMocks.exportNotesBundle.mockReset().mockResolvedValue(undefined);
  apiMocks.scanSensitiveText.mockReset().mockImplementation(async (text: string) => ({
    findings: [],
    warnings: [],
    inputUtf16: text.length,
    scannedUtf16: text.length,
    complete: true,
  }));
  eventMocks.listeners.clear();
  eventMocks.emit.mockReset().mockResolvedValue(undefined);
  eventMocks.listen.mockReset().mockImplementation(async (event, handler) => {
    eventMocks.listeners.set(event, handler);
    return () => eventMocks.listeners.delete(event);
  });
  eventMocks.emitTo.mockReset().mockImplementation(
    async (_target: string, event: string, payload: Record<string, unknown>) => {
      if (event !== "toskr://note-editor-insert") return;
      eventMocks.listeners.get("toskr://note-editor-insert-result")?.({
        payload: {
          requestId: payload.requestId,
          targetId: payload.targetId,
          targetSessionId: payload.targetSessionId,
          dataGeneration: payload.dataGeneration,
          status: "applied",
        },
      });
    }
  );
  webviewMocks.getByLabel.mockReset().mockResolvedValue(null);
  apiMocks.sendDelivery
    .mockReset()
    .mockImplementation(async (request: SendDeliveryRequest) => result(request, status));
  dialogMocks.ask.mockReset().mockResolvedValue(true);
  dialogMocks.save.mockReset().mockResolvedValue(null);
  vi.mocked(tip).mockClear();
}

describe("结构化发送结果的 store 副作用", () => {
  beforeEach(() => reset("sent"));

  it("图片卡编辑优先打开文字备注输入，不直接进入打码", () => {
    const { id } = useNotesStore.getState().addNote("图片 231×242", {
      kind: "image",
      imageFile: "shot.png",
      imageW: 231,
      imageH: 242,
    });

    openNoteDetail(id!, true);

    expect(apiMocks.quickLook).toHaveBeenCalledWith(
      ["shot.png"],
      0,
      {
        id,
        text: "",
        dataGeneration: expect.any(Number),
        edit: true,
      }
    );
  });

  it("文字详情载荷不再携带主面板方向", () => {
    const { id } = useNotesStore.getState().addNote("正文");

    openNoteDetail(id!);

    const payload = eventMocks.emitTo.mock.calls.find(
      ([label, event]) =>
        label === "textpreview" && event === "toskr://note-preview"
    )?.[2];
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty("detailFrameNotchSide");
  });

  it("交错图文卡把权威块传给详情并按原顺序富复制", async () => {
    const contentBlocks = [
      { type: "text" as const, text: "路径：审批管理" },
      { type: "image" as const, file: "first.png", alt: "第一张" },
      { type: "text" as const, text: "一、商户类型" },
      { type: "image" as const, file: "second.png" },
    ];
    const { id } = useNotesStore.getState().addNote("", { contentBlocks });
    const note = useNotesStore.getState().notes.find((item) => item.id === id)!;

    openNoteDetail(id!, true);
    await copyNoteContent(note);

    const payload = eventMocks.emitTo.mock.calls.find(
      ([label, event]) =>
        label === "textpreview" && event === "toskr://note-preview"
    )?.[2];
    expect(payload).toMatchObject({ contentBlocks, edit: true });
    expect(apiMocks.quickLook).not.toHaveBeenCalled();
    expect(apiMocks.copyRichClipboard).toHaveBeenCalledWith([
      { kind: "text", text: "路径：审批管理" },
      { kind: "image", file: "first.png", alt: "第一张" },
      { kind: "text", text: "一、商户类型" },
      { kind: "image", file: "second.png" },
    ]);
    expect(apiMocks.copyText).not.toHaveBeenCalled();
    expect(apiMocks.copyImage).not.toHaveBeenCalled();
  });

  it("导出勾选笔记为单一 Markdown 媒体包且保留选择", async () => {
    const firstId = useNotesStore.getState().addNote("前文", {
      contentBlocks: [
        { type: "text", text: "前文" },
        { type: "image", file: "first.png" },
      ],
    }).id!;
    const secondId = useNotesStore.getState().addNote("后文").id!;
    useNotesStore.getState().setChecked([firstId, secondId]);
    dialogMocks.save.mockResolvedValue("/tmp/Toskr-笔记.zip");
    apiMocks.exportNotesBundle.mockResolvedValue(undefined);

    await exportNotesBundle([firstId, secondId]);

    expect(dialogMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: "Toskr Markdown 笔记包", extensions: ["zip"] }],
      })
    );
    expect(apiMocks.exportNotesBundle).toHaveBeenCalledWith(
      "/tmp/Toskr-笔记.zip",
      expect.stringMatching(/后文[\s\S]*前文[\s\S]*media\/first\.png/),
      ["first.png"]
    );
    expect(useNotesStore.getState().checkedIds).toEqual([firstId, secondId]);
    expect(tip).toHaveBeenLastCalledWith("ok", "已导出 2 条笔记、1 张图");
  });

  it("导出前阻止仍在详情窗中的笔记，避免拿到未同步草稿", async () => {
    const id = useNotesStore.getState().addNote("旧正文").id!;
    useUIStore.getState().setDetailEditorNoteId(id);

    await exportNotesBundle([id]);

    expect(dialogMocks.save).not.toHaveBeenCalled();
    expect(apiMocks.exportNotesBundle).not.toHaveBeenCalled();
    expect(tip).toHaveBeenLastCalledWith(
      "warn",
      "请先关闭已打开的笔记详情，确认最新编辑已同步后再导出"
    );
  });

  it("合并发送来源按发送规则重建图文只读预览", () => {
    const textId = useNotesStore.getState().addNote("问题背景").id!;
    const firstImageId = useNotesStore.getState().addNote("图片 1200×800", {
      kind: "image",
      imageFile: "first.png",
    }).id!;
    const secondImageId = useNotesStore.getState().addNote("图片 900×600", {
      kind: "image",
      imageFile: "second.png",
    }).id!;

    expect(
      openNoteBatchDetail([textId, firstImageId, secondImageId], 3)
    ).toBe(true);

    const payload = eventMocks.emitTo.mock.calls.find(
      ([label, event]) =>
        label === "textpreview" && event === "toskr://note-preview"
    )?.[2];
    expect(apiMocks.showTextPreview).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({
      text: "问题背景",
      images: ["first.png", "second.png"],
      kind: "text",
      title: "合并发送内容",
      subtitle: "3 张当前来源卡片 · 发送记录不保存正文",
      edit: false,
      readOnly: true,
    });
    expect(payload?.id).not.toBe(textId);
    expect(payload?.id).not.toBe(firstImageId);
    expect(payload?.id).not.toBe(secondImageId);
  });

  it("剪贴板卡优先追加到当前可见卡片编辑器，不误发送到外部目标", async () => {
    const destination = useNotesStore.getState().addNote("原卡内容").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    apiMocks.showTextPreview.mockClear();

    useNotesStore.getState().addClipNote("剪贴板正文", {});
    useNotesStore.getState().addClipNote("图片 20×10", {
      kind: "image",
      imageFile: "clip.png",
      imageW: 20,
      imageH: 10,
    });
    const sourceIds = useNotesStore
      .getState()
      .notes.filter((note) => note.sectionId === CLIPBOARD_ID)
      .map((note) => note.id);
    useNotesStore.getState().setChecked(sourceIds);
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });

    await sendNotesToChat(sourceIds);

    expect(eventMocks.emitTo).toHaveBeenCalledWith(
      "textpreview",
      "toskr://note-editor-insert",
      {
        requestId: expect.any(String),
        operationKey: expect.stringMatching(/^editor-insert-/),
        expiresAt: expect.any(Number),
        targetId: destination,
        targetSessionId: expect.any(String),
        text: "剪贴板正文",
        images: ["clip.png"],
        dataGeneration: expect.any(Number),
      }
    );
    expect(apiMocks.showTextPreview).toHaveBeenCalledOnce();
    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useNotesStore.getState().checkedIds).toEqual([]);
  });

  it("剪贴卡详情页发送选中绕过同窗内部追加并投递到外部目标", async () => {
    useNotesStore.getState().addClipNote("完整正文", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    openNoteDetail(sourceId, false);
    eventMocks.emitTo.mockClear();
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });

    await sendNotesToChat([sourceId], undefined, {
      overrideText: "选中片段",
    });

    expect(eventMocks.emitTo).not.toHaveBeenCalledWith(
      "textpreview",
      "toskr://note-editor-insert",
      expect.anything()
    );
    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "选中片段",
        imageFiles: [],
        targetToken: "token-1",
      })
    );
    expect(tip).not.toHaveBeenCalledWith("warn", "不能把卡片内容添加到自身");
  });

  it.each([
    ["显式预检", "off", { forcePreflight: true }],
    ["always 模式", "always", undefined],
  ] as const)("%s 不被剪贴板编辑器内部追加旁路", async (_label, mode, options) => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("需要外部预检", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    useDeliveryStore.getState().setPreflightMode(mode);
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });

    await sendNotesToChat([sourceId], undefined, options);

    expect(useDeliveryStore.getState()).toMatchObject({ open: true, busy: false });
    expect(useDeliveryStore.getState().draft?.sourceItemIds).toEqual([sourceId]);
    expect(eventMocks.emitTo).not.toHaveBeenCalledWith(
      "textpreview",
      "toskr://note-editor-insert",
      expect.anything()
    );
  });

  it("图片追加后即使来源卡删除，未保存编辑会话仍持有媒体引用", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("图片 20×10", {
      kind: "image",
      imageFile: "clip.png",
      imageW: 20,
      imageH: 10,
    });
    const sourceId = useNotesStore.getState().notes[0].id;
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });

    await sendNotesToChat([sourceId]);
    useNotesStore.getState().deleteNotes([sourceId]);

    expect(editorSessionMediaFiles()).toEqual(["clip.png"]);
  });

  it("用户两次明确添加同一内容时创建两个操作，不把第二次误判为重试", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("可重复添加", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });

    await sendNotesToChat([sourceId]);
    await sendNotesToChat([sourceId]);

    const payloads = eventMocks.emitTo.mock.calls
      .filter(([, event]) => event === "toskr://note-editor-insert")
      .map(([, , payload]) => payload as Record<string, unknown>);
    expect(payloads).toHaveLength(2);
    expect(payloads[1].operationKey).not.toBe(payloads[0].operationKey);
    expect(payloads[1].targetSessionId).toBe(payloads[0].targetSessionId);
  });

  it("同一卡片关闭重开会轮换编辑会话，旧操作不能命中新草稿", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    const firstPreview = eventMocks.emitTo.mock.calls.find(
      ([, event]) => event === "toskr://note-preview"
    )?.[2] as Record<string, unknown>;
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("相同来源", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });
    await sendNotesToChat([sourceId]);

    openNoteDetail(destination, true);
    const secondPreview = eventMocks.emitTo.mock.calls.find(
      ([, event]) => event === "toskr://note-preview"
    )?.[2] as Record<string, unknown>;
    expect(secondPreview.sessionId).not.toBe(firstPreview.sessionId);

    eventMocks.emitTo.mockClear();
    await sendNotesToChat([sourceId]);
    expect(eventMocks.emitTo).toHaveBeenCalledWith(
      "textpreview",
      "toskr://note-editor-insert",
      expect.objectContaining({ targetSessionId: secondPreview.sessionId })
    );
  });

  it("卡片编辑器不可见时，剪贴板卡仍按原链路发送外部目标", async () => {
    useNotesStore.getState().addClipNote("发给外部目标", {});
    const sourceId = useNotesStore.getState().notes[0].id;

    await sendNotesToChat([sourceId]);

    expect(eventMocks.emitTo).not.toHaveBeenCalledWith(
      "textpreview",
      "toskr://note-editor-insert",
      expect.anything()
    );
    expect(apiMocks.sendDelivery).toHaveBeenCalledOnce();
  });

  it("已确认存在卡片编辑器但内部事件失败时保持 fail-closed", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("敏感剪贴板内容", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    useNotesStore.getState().setChecked([sourceId]);
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });
    eventMocks.emitTo.mockRejectedValueOnce(new Error("event unavailable"));

    await sendNotesToChat([sourceId]);

    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useNotesStore.getState().checkedIds).toEqual([sourceId]);
    expect(tip).toHaveBeenCalledWith(
      "warn",
      "添加到卡片编辑器失败：Error: event unavailable"
    );
  });

  it("编辑器可见性查询失败时不回退外投", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("仅供内部编辑", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    useNotesStore.getState().setChecked([sourceId]);
    webviewMocks.getByLabel.mockRejectedValue(new Error("visibility unavailable"));

    await sendNotesToChat([sourceId]);

    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useNotesStore.getState().checkedIds).toEqual([sourceId]);
    expect(tip).toHaveBeenCalledWith(
      "warn",
      "无法确认卡片编辑器状态：Error: visibility unavailable"
    );
  });

  it("编辑器拒绝 ACK 时不清选择、不假报成功也不回退外投", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("等待确认", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    useNotesStore.getState().setChecked([sourceId]);
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });
    eventMocks.emitTo.mockImplementationOnce(
      async (_target: string, event: string, payload: Record<string, unknown>) => {
        if (event !== "toskr://note-editor-insert") return;
        eventMocks.listeners.get("toskr://note-editor-insert-result")?.({
          payload: {
            requestId: payload.requestId,
            targetId: payload.targetId,
            targetSessionId: payload.targetSessionId,
            dataGeneration: payload.dataGeneration,
            status: "rejected",
            reason: "目标已变化",
          },
        });
      }
    );

    await sendNotesToChat([sourceId]);

    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useNotesStore.getState().checkedIds).toEqual([sourceId]);
    expect(tip).toHaveBeenCalledWith(
      "warn",
      "添加到卡片编辑器失败：Error: 目标已变化"
    );
  });

  it("卡片编辑器追加在途时拒绝重复操作", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("只追加一次", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });
    let pendingPayload: Record<string, unknown> | undefined;
    eventMocks.emitTo.mockImplementation(
      async (_target: string, event: string, payload: Record<string, unknown>) => {
        if (event === "toskr://note-editor-insert") pendingPayload = payload;
      }
    );

    const first = sendNotesToChat([sourceId]);
    await vi.waitFor(() => expect(pendingPayload).toBeDefined());
    await sendNotesToChat([sourceId]);
    eventMocks.listeners.get("toskr://note-editor-insert-result")?.({
      payload: {
        requestId: pendingPayload!.requestId,
        targetId: pendingPayload!.targetId,
        targetSessionId: pendingPayload!.targetSessionId,
        dataGeneration: pendingPayload!.dataGeneration,
        status: "applied",
      },
    });
    await first;

    expect(
      eventMocks.emitTo.mock.calls.filter(
        ([, event]) => event === "toskr://note-editor-insert"
      )
    ).toHaveLength(1);
    expect(tip).toHaveBeenCalledWith("warn", "已有发送正在进行，请稍候");
  });

  it("编辑器可见性探测期间打开预检后，不再把旧意图追加到编辑器", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("等待可见性", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    let resolveVisible!: (visible: boolean) => void;
    const isVisible = vi.fn(
      () => new Promise<boolean>((resolve) => { resolveVisible = resolve; })
    );
    webviewMocks.getByLabel.mockResolvedValue({ isVisible });

    const pendingInsert = sendNotesToChat([sourceId]);
    await vi.waitFor(() => expect(isVisible).toHaveBeenCalledOnce());
    const taskId = useNotesStore.getState().addTask("另一个明确意图").id!;
    await sendTaskToChat(taskId, { forcePreflight: true });
    resolveVisible(true);
    await pendingInsert;

    expect(useDeliveryStore.getState().draft?.sourceKind).toBe("task");
    expect(eventMocks.emitTo).not.toHaveBeenCalledWith(
      "textpreview",
      "toskr://note-editor-insert",
      expect.anything()
    );
    expect(tip).toHaveBeenCalledWith("warn", "请先完成或关闭当前发送预检");
  });

  it("编辑器探测期间数据代际变化时禁止旧剪贴板内容外投", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    useNotesStore.getState().addClipNote("旧数据内容", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    let resolveVisible!: (visible: boolean) => void;
    const isVisible = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveVisible = resolve))
    );
    webviewMocks.getByLabel.mockResolvedValue({ isVisible });

    const pending = sendNotesToChat([sourceId]);
    await vi.waitFor(() => expect(isVisible).toHaveBeenCalledOnce());
    advanceDataGeneration();
    resolveVisible(false);
    await pending;

    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(tip).toHaveBeenCalledWith(
      "warn",
      "发送已取消：数据上下文已变化，请重新选择内容"
    );
  });

  it("内部 IPC 挂起会超时释放 ACK 监听、发送锁与数据租约", async () => {
    vi.useFakeTimers();
    try {
      const destination = useNotesStore.getState().addNote("目标卡片").id!;
      openNoteDetail(destination, true);
      eventMocks.emitTo.mockClear();
      useNotesStore.getState().addClipNote("超时后可安全重试", {});
      const sourceId = useNotesStore.getState().notes[0].id;
      useNotesStore.getState().setChecked([sourceId]);
      webviewMocks.getByLabel.mockResolvedValue({
        isVisible: vi.fn().mockResolvedValue(true),
      });
      const payloads: Record<string, unknown>[] = [];
      eventMocks.emitTo.mockImplementation(
        (_target: string, event: string, payload: Record<string, unknown>) => {
          if (event === "toskr://note-editor-insert") payloads.push(payload);
          return new Promise<never>(() => {});
        }
      );

      const first = sendNotesToChat([sourceId]);
      await vi.advanceTimersByTimeAsync(1600);
      await first;

      expect(hasDataGenerationLeases()).toBe(false);
      expect(useNotesStore.getState().checkedIds).toEqual([sourceId]);
      expect(tip).toHaveBeenCalledWith(
        "warn",
        "添加到卡片编辑器失败：Error: 卡片编辑器未确认接收"
      );

      eventMocks.emitTo.mockImplementation(
        async (_target: string, event: string, payload: Record<string, unknown>) => {
          if (event !== "toskr://note-editor-insert") return;
          payloads.push(payload);
          eventMocks.listeners.get("toskr://note-editor-insert-result")?.({
            payload: {
              requestId: payload.requestId,
              targetId: payload.targetId,
              targetSessionId: payload.targetSessionId,
              dataGeneration: payload.dataGeneration,
              status: "applied",
            },
          });
        }
      );
      await sendNotesToChat([sourceId]);

      expect(payloads).toHaveLength(2);
      expect(payloads[1].requestId).not.toBe(payloads[0].requestId);
      expect(payloads[1].operationKey).toBe(payloads[0].operationKey);
      expect(payloads[1].expiresAt).toBeGreaterThan(
        payloads[0].expiresAt as number
      );
      expect(useNotesStore.getState().checkedIds).toEqual([]);
      expect(hasDataGenerationLeases()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("编辑器已 ACK 时不被仍悬挂的派发 Promise 拖成失败", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("ACK 已到", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    useNotesStore.getState().setChecked([sourceId]);
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });
    eventMocks.emitTo.mockImplementation(
      (_target: string, event: string, payload: Record<string, unknown>) => {
        if (event !== "toskr://note-editor-insert") return Promise.resolve();
        eventMocks.listeners.get("toskr://note-editor-insert-result")?.({
          payload: {
            requestId: payload.requestId,
            targetId: payload.targetId,
            targetSessionId: payload.targetSessionId,
            dataGeneration: payload.dataGeneration,
            status: "applied",
          },
        });
        return new Promise<never>(() => {});
      }
    );

    await sendNotesToChat([sourceId]);

    expect(useNotesStore.getState().checkedIds).toEqual([]);
    expect(tip).toHaveBeenCalledWith("ok", "已添加到卡片编辑器");
    expect(hasDataGenerationLeases()).toBe(false);
  });

  it("窗口探测挂起同样有界退出，不泄漏数据租约", async () => {
    vi.useFakeTimers();
    try {
      const destination = useNotesStore.getState().addNote("目标卡片").id!;
      openNoteDetail(destination, true);
      useNotesStore.getState().addClipNote("窗口探测超时", {});
      const sourceId = useNotesStore.getState().notes[0].id;
      webviewMocks.getByLabel.mockReturnValue(new Promise<never>(() => {}));

      const pending = sendNotesToChat([sourceId]);
      await vi.advanceTimersByTimeAsync(1600);
      await pending;

      expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
      expect(hasDataGenerationLeases()).toBe(false);
      expect(tip).toHaveBeenCalledWith(
        "warn",
        "无法确认卡片编辑器状态：Error: 卡片编辑器窗口探测超时"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("窗口探测期间来源卡被编辑时使用最新内容，不追加旧快照", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("旧内容", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    let resolveVisible!: (visible: boolean) => void;
    const visible = new Promise<boolean>((resolve) => (resolveVisible = resolve));
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockReturnValue(visible),
    });

    const pending = sendNotesToChat([sourceId]);
    await vi.waitFor(() => expect(webviewMocks.getByLabel).toHaveBeenCalled());
    useNotesStore.getState().updateNoteText(sourceId, "最新内容");
    resolveVisible(true);
    await pending;

    expect(eventMocks.emitTo).toHaveBeenCalledWith(
      "textpreview",
      "toskr://note-editor-insert",
      expect.objectContaining({ text: "最新内容" })
    );
  });

  it("ACK 监听注册期间来源卡被编辑时仍在派发前重读最新内容", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("监听前旧内容", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });
    let resolveRegistration!: () => void;
    eventMocks.listen.mockImplementation((event, handler) => {
      eventMocks.listeners.set(event, handler);
      return new Promise<() => void>((resolve) => {
        resolveRegistration = () =>
          resolve(() => eventMocks.listeners.delete(event));
      });
    });

    const pending = sendNotesToChat([sourceId]);
    await vi.waitFor(() => expect(eventMocks.listen).toHaveBeenCalledOnce());
    useNotesStore.getState().updateNoteText(sourceId, "监听后最新内容");
    resolveRegistration();
    await pending;

    expect(eventMocks.emitTo).toHaveBeenCalledWith(
      "textpreview",
      "toskr://note-editor-insert",
      expect.objectContaining({ text: "监听后最新内容" })
    );
  });

  it("ACK 返回前目标卡被删除时不清选择、不假报成功", async () => {
    const destination = useNotesStore.getState().addNote("目标卡片").id!;
    openNoteDetail(destination, true);
    eventMocks.emitTo.mockClear();
    useNotesStore.getState().addClipNote("等待目标复核", {});
    const sourceId = useNotesStore.getState().notes[0].id;
    useNotesStore.getState().setChecked([sourceId]);
    webviewMocks.getByLabel.mockResolvedValue({
      isVisible: vi.fn().mockResolvedValue(true),
    });
    let payload: Record<string, unknown> | undefined;
    eventMocks.emitTo.mockImplementation(
      async (_target: string, event: string, next: Record<string, unknown>) => {
        if (event === "toskr://note-editor-insert") payload = next;
      }
    );

    const pending = sendNotesToChat([sourceId]);
    await vi.waitFor(() => expect(payload).toBeDefined());
    useNotesStore.getState().deleteNotes([destination]);
    eventMocks.listeners.get("toskr://note-editor-insert-result")?.({
      payload: {
        requestId: payload!.requestId,
        targetId: payload!.targetId,
        targetSessionId: payload!.targetSessionId,
        dataGeneration: payload!.dataGeneration,
        status: "applied",
      },
    });
    await pending;

    expect(useNotesStore.getState().checkedIds).toEqual([sourceId]);
    expect(tip).toHaveBeenCalledWith(
      "warn",
      "卡片编辑目标已变化，内容未确认添加"
    );
  });

  it("Native 数据事务状态尚未核验时阻止发送", async () => {
    const added = useNotesStore.getState().addNote("bootstrap pending");
    useDataOperationStore.setState({
      locked: true,
      phase: "prepare",
      message: "正在核验数据事务状态…",
    });

    await expect(sendNotesToChat([added.id!])).resolves.toBeNull();
    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
  });

  it("仅 sent 标完成、清选择并完成 onboarding", async () => {
    const added = useNotesStore.getState().addNote("hello");
    useNotesStore.getState().setChecked([added.id!]);

    const response = await sendNotesToChat([added.id!]);

    expect(response?.status).toBe("sent");
    expect(useNotesStore.getState().notes[0].done).toBe(true);
    expect(useNotesStore.getState().checkedIds).toEqual([]);
    expect(useNotesStore.getState().settings.onboarding.sent).toBe(true);
    expect(useUIStore.getState().open).toBe(false);
    expect(apiMocks.showPanel).not.toHaveBeenCalled();
  });

  it("smart 模式的图片 Draft 打开预检且不提前调用 Native", async () => {
    useDeliveryStore.getState().setPreflightMode("smart");
    const added = useNotesStore.getState().addNote("图片 20×10", {
      kind: "image",
      imageFile: "fixture.png",
    });
    useNotesStore.getState().setChecked([added.id!]);

    await sendNotesToChat([added.id!]);

    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState()).toMatchObject({ open: true, busy: false });
    expect(useDeliveryStore.getState().draft?.imageFiles).toEqual(["fixture.png"]);
    expect(useNotesStore.getState().checkedIds).toEqual([added.id]);
  });

  it("异步编辑器探测后的并发意图不能覆盖已打开的预检 Draft", async () => {
    useDeliveryStore.getState().setPreflightMode("smart");
    const firstId = useNotesStore.getState().addNote("第一张图", {
      kind: "image",
      imageFile: "first.png",
    }).id!;
    const secondId = useNotesStore.getState().addNote("第二张图", {
      kind: "image",
      imageFile: "second.png",
    }).id!;

    await Promise.all([
      sendNotesToChat([firstId]),
      sendNotesToChat([secondId]),
    ]);

    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState().draft?.sourceItemIds).toEqual([firstId]);
    expect(tip).toHaveBeenCalledWith("warn", "已有发送正在进行，请稍候");
  });

  it("发送菜单可对简单文本显式强制预检", async () => {
    useDeliveryStore.getState().setPreflightMode("off");
    const id = useNotesStore.getState().addNote("需要确认").id!;

    await sendNotesToChat([id], undefined, { forcePreflight: true });

    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState().draft?.finalText).toBe("需要确认");
  });

  it("安全演练只为受控示例打开带 no-enter 锁的真实预检", async () => {
    const id = useNotesStore.getState().addNote(SAFE_REHEARSAL_TEXT).id!;
    const store = useNotesStore.getState();
    store.transitionOnboarding({ type: "start" });
    store.transitionOnboarding({ type: "permissionsReady" });
    store.transitionOnboarding({ type: "samplePrepared" });
    store.transitionOnboarding({ type: "sampleCaptured", noteId: id });
    store.transitionOnboarding({ type: "targetConfirmed" });

    await openSafeRehearsalPreflight(id);

    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useDeliveryStore.getState()).toMatchObject({ open: true });
    expect(useDeliveryStore.getState().draft).toMatchObject({
      safeRehearsal: true,
      sourceItemIds: [id],
      enterDecisionConfirmed: true,
      pressEnter: false,
      keepPanel: true,
    });
    expect(useNotesStore.getState().settings.onboarding.rehearsalStep)
      .toBe("delivery");

    await submitPreflightDraft();

    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ pressEnter: false, keepPanel: true })
    );
    expect(useNotesStore.getState().settings.onboarding).toMatchObject({
      done: true,
      sent: true,
      rehearsalStep: "complete",
      rehearsalActive: false,
    });
  });

  it.each(["blocked", "failed"] as const)(
    "%s 保持卡片、选择和 onboarding，并重新打开面板",
    async (status) => {
      reset(status);
      const added = useNotesStore.getState().addNote("keep me");
      useNotesStore.getState().setChecked([added.id!]);

      const response = await sendNotesToChat([added.id!]);

      expect(response?.status).toBe(status);
      expect(useNotesStore.getState().notes[0].done).toBe(false);
      expect(useNotesStore.getState().checkedIds).toEqual([added.id]);
      expect(useNotesStore.getState().settings.onboarding.sent).toBe(false);
      expect(useUIStore.getState().open).toBe(true);
      expect(apiMocks.showPanel).toHaveBeenCalledOnce();
    }
  );

  it("任务发送消费 blocked 回执且不改变任务状态", async () => {
    reset("blocked");
    const added = useNotesStore.getState().addTask("review contract");

    const response = await sendTaskToChat(added.id!);

    expect(response?.status).toBe("blocked");
    expect(useNotesStore.getState().tasks[0].status).toBe("todo");
    expect(apiMocks.sendDelivery).toHaveBeenCalledOnce();
    expect(useUIStore.getState().open).toBe(true);
  });

  it("单条与勾选批量都委托同一个 send_delivery 契约", async () => {
    reset("blocked");
    const first = useNotesStore.getState().addNote("one").id!;
    const second = useNotesStore.getState().addNote("two").id!;

    await sendNotesToChat([first]);
    useNotesStore.getState().setChecked([first, second]);
    await sendCheckedToChat();

    expect(apiMocks.sendDelivery).toHaveBeenCalledTimes(2);
    expect(
      apiMocks.sendDelivery.mock.calls.every(
        ([request]) => typeof request.deliveryId === "string" && request.targetToken === "token-1"
      )
    ).toBe(true);
  });

  it.each(["unknown", "refreshing", "blocked"] as const)(
    "目标为 %s 时任务、单条和批量入口都不执行",
    async (status) => {
      const noteId = useNotesStore.getState().addNote("blocked note").id!;
      const taskId = useNotesStore.getState().addTask("blocked task").id!;
      useNotesStore.getState().setChecked([noteId]);
      useTargetStore.setState({ status });

      await sendTaskToChat(taskId);
      await sendNotesToChat([noteId]);
      await sendCheckedToChat();

      expect(apiMocks.refreshTargetSnapshot).not.toHaveBeenCalled();
      expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    }
  );

  it("ready 入口发送前刷新 token，随后仍由 Native send_delivery 二次验证", async () => {
    const noteId = useNotesStore.getState().addNote("double guard").id!;
    apiMocks.refreshTargetSnapshot.mockResolvedValue({ ...target, token: "token-2" });

    await sendNotesToChat([noteId]);

    expect(apiMocks.refreshTargetSnapshot).toHaveBeenCalledOnce();
    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ targetToken: "token-2" })
    );
  });

  it("精确 Profile 同时驱动默认格式、Enter 与 keepPanel", async () => {
    const noteId = useNotesStore.getState().addNote("const answer = 42").id!;
    const settings = useNotesStore.getState().settings;
    useNotesStore.getState().setSettings({
      targetProfiles: [
        {
          id: "codex",
          name: "Codex",
          bundleIds: ["com.openai.codex"],
          promptGroupId: settings.promptGroups[0].id,
          defaultFormat: "code",
          enterPolicy: "allow",
          privacyPolicy: "confirmRaw",
          keepPanel: true,
        },
      ],
      defaultTargetProfileId: "codex",
    });

    await sendNotesToChat([noteId]);

    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("```"),
        pressEnter: true,
        keepPanel: true,
      })
    );
    expect(useUIStore.getState().open).toBe(true);
  });

  it("enterPolicy=confirm 拒绝时不发送，确认后才允许 Enter", async () => {
    const noteId = useNotesStore.getState().addNote("confirm enter").id!;
    const settings = useNotesStore.getState().settings;
    useNotesStore.getState().setSettings({
      targetProfiles: [
        {
          id: "codex",
          name: "Codex",
          bundleIds: ["com.openai.codex"],
          promptGroupId: settings.promptGroups[0].id,
          defaultFormat: "plain",
          enterPolicy: "confirm",
          privacyPolicy: "requireRedaction",
          keepPanel: false,
        },
      ],
      defaultTargetProfileId: "codex",
    });
    dialogMocks.ask.mockResolvedValueOnce(false);

    await expect(sendNotesToChat([noteId])).resolves.toBeNull();
    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();

    dialogMocks.ask.mockResolvedValueOnce(true);
    await sendNotesToChat([noteId]);
    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ pressEnter: true })
    );
  });

  it("未知 bundle 即使默认 Profile 配置高风险值也会安全收紧", async () => {
    const unknown = { ...target, bundleId: "com.example.unknown", revision: 100 };
    applyTargetEvent(unknown);
    apiMocks.refreshTargetSnapshot.mockResolvedValue(unknown);
    const noteId = useNotesStore.getState().addNote("safe fallback").id!;
    const settings = useNotesStore.getState().settings;
    useNotesStore.getState().setSettings({
      targetProfiles: [
        {
          id: "risky-default",
          name: "默认",
          bundleIds: [],
          promptGroupId: settings.promptGroups[0].id,
          defaultFormat: "plain",
          enterPolicy: "allow",
          privacyPolicy: "allowRaw",
          keepPanel: false,
        },
      ],
      defaultTargetProfileId: "risky-default",
    });

    await sendNotesToChat([noteId]);

    expect(apiMocks.sendDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ pressEnter: false })
    );
  });

  it("带临时 Profile 的目标变化在确认前阻止发送并保留选择", async () => {
    const noteId = useNotesStore.getState().addNote("keep override").id!;
    useNotesStore.getState().setChecked([noteId]);
    setTargetProfileOverride("default-safe");
    applyTargetEvent({
      ...target,
      token: "target-b",
      pid: 99,
      bundleId: "com.apple.Terminal",
      appName: "Terminal",
      revision: 100,
    });

    await expect(sendNotesToChat([noteId])).resolves.toBeNull();
    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useNotesStore.getState().checkedIds).toEqual([noteId]);
    expect(tip).toHaveBeenCalledWith(
      "warn",
      "原临时发送方案已暂停，请确认或恢复自动匹配"
    );
  });

  it("A→B→A 发生在 Enter 确认期间仍阻止旧临时 Profile", async () => {
    const noteId = useNotesStore.getState().addNote("race override").id!;
    const settings = useNotesStore.getState().settings;
    useNotesStore.getState().setSettings({
      targetProfiles: [{
        id: "temporary-confirm",
        name: "临时确认",
        bundleIds: [],
        promptGroupId: settings.promptGroups[0].id,
        defaultFormat: "plain",
        enterPolicy: "confirm",
        privacyPolicy: "requireRedaction",
        keepPanel: false,
      }],
      defaultTargetProfileId: "temporary-confirm",
    });
    setTargetProfileOverride("temporary-confirm");
    let resolveAsk!: (confirmed: boolean) => void;
    dialogMocks.ask.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveAsk = resolve;
    }));

    const pending = sendNotesToChat([noteId]);
    await vi.waitFor(() => expect(dialogMocks.ask).toHaveBeenCalledOnce());
    applyTargetEvent({
      ...target,
      token: "target-b",
      pid: 99,
      bundleId: "com.apple.Terminal",
      appName: "Terminal",
      revision: 100,
    });
    const returnedA = { ...target, token: "target-a2", revision: 101 };
    applyTargetEvent(returnedA);
    apiMocks.refreshTargetSnapshot.mockResolvedValue(returnedA);
    resolveAsk(true);

    await expect(pending).resolves.toBeNull();
    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useTargetStore.getState().profileOverrideNeedsConfirmation).toBe(true);
    expect(tip).toHaveBeenCalledWith(
      "warn",
      "原临时发送方案已暂停，请确认或恢复自动匹配"
    );
  });

  it("确认框期间 Profile 策略改变时不沿用旧 Enter 决策", async () => {
    const noteId = useNotesStore.getState().addNote("changed policy").id!;
    const settings = useNotesStore.getState().settings;
    const profile = {
      id: "mutable",
      name: "可变策略",
      bundleIds: ["com.openai.codex"],
      promptGroupId: settings.promptGroups[0].id,
      defaultFormat: "plain" as const,
      enterPolicy: "confirm" as const,
      privacyPolicy: "requireRedaction" as const,
      keepPanel: false,
    };
    useNotesStore.getState().setSettings({
      targetProfiles: [profile],
      defaultTargetProfileId: profile.id,
    });
    let resolveAsk!: (confirmed: boolean) => void;
    dialogMocks.ask.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveAsk = resolve;
    }));

    const pending = sendNotesToChat([noteId]);
    await vi.waitFor(() => expect(dialogMocks.ask).toHaveBeenCalledOnce());
    useNotesStore.getState().setSettings({
      targetProfiles: [{ ...profile, enterPolicy: "never" }],
    });
    resolveAsk(true);

    await expect(pending).resolves.toBeNull();
    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(tip).toHaveBeenCalledWith(
      "warn",
      "发送方案设置已变化，请确认后重试发送"
    );
  });

  it("本次 Profile 仅在成功发送后清除，失败时保留", async () => {
    const first = useNotesStore.getState().addNote("temporary one").id!;
    setTargetProfileOverride("default-safe");
    apiMocks.sendDelivery.mockImplementationOnce(
      async (request: SendDeliveryRequest) => result(request, "blocked")
    );
    await sendNotesToChat([first]);
    expect(useTargetStore.getState().profileOverrideId).toBe("default-safe");

    const second = useNotesStore.getState().addNote("temporary two").id!;
    apiMocks.sendDelivery.mockImplementationOnce(
      async (request: SendDeliveryRequest) => result(request, "sent")
    );
    await sendNotesToChat([second]);
    expect(useTargetStore.getState().profileOverrideId).toBeNull();
  });

  it("Lens 显示 A 时刷新到 B 只更新目标并要求二次确认", async () => {
    const noteId = useNotesStore.getState().addNote("confirm target switch").id!;
    useNotesStore.getState().setChecked([noteId]);
    const targetB: TargetSnapshot = {
      ...target,
      token: "token-b",
      pid: 73,
      bundleId: "com.apple.Terminal",
      appName: "Terminal",
      launchedAtMs: 800,
    };
    apiMocks.refreshTargetSnapshot.mockResolvedValue(targetB);

    await expect(sendNotesToChat([noteId])).resolves.toBeNull();

    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useTargetStore.getState().snapshot).toEqual(targetB);
    expect(useNotesStore.getState().checkedIds).toEqual([noteId]);
    expect(tip).toHaveBeenCalledWith("warn", "发送目标已变化，请确认后重试发送");
  });

  it("A→B→Toskr 小于观察周期且 B 漏采时发送保持 fail-closed", async () => {
    vi.useFakeTimers();
    try {
      const noteId = useNotesStore.getState().addNote("missed target B").id!;
      let resolveObservation!: (value: TargetSnapshot) => void;
      apiMocks.refreshPrevApp.mockReturnValue(
        new Promise<TargetSnapshot>((resolve) => {
          resolveObservation = resolve;
        })
      );

      const observation = observeTargetAfterBlur();
      await vi.advanceTimersByTimeAsync(249);
      await expect(sendNotesToChat([noteId])).resolves.toBeNull();

      expect(apiMocks.refreshTargetSnapshot).not.toHaveBeenCalled();
      expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
      resolveObservation({
        ...target,
        revision: target.revision + 1,
        ready: false,
        reason: "target_not_frontmost",
      });
      await observation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("快速重复发送只允许一个原生发送在途", async () => {
    reset("sent");
    const noteId = useNotesStore.getState().addNote("once").id!;
    useNotesStore.getState().setChecked([noteId]);
    let resolveDelivery!: (value: SendDeliveryResult) => void;
    apiMocks.sendDelivery.mockImplementation(
      () =>
        new Promise<SendDeliveryResult>((resolve) => {
          resolveDelivery = resolve;
        })
    );

    const first = sendNotesToChat([noteId]);
    const duplicate = await sendNotesToChat([noteId]);

    expect(duplicate).toBeNull();
    await vi.waitFor(() => expect(apiMocks.sendDelivery).toHaveBeenCalledOnce());
    const request = apiMocks.sendDelivery.mock.calls[0][0] as SendDeliveryRequest;
    resolveDelivery(result(request, "sent"));
    await expect(first).resolves.toMatchObject({ status: "sent" });
    expect(apiMocks.sendDelivery).toHaveBeenCalledOnce();
    expect(useNotesStore.getState().notes[0].done).toBe(true);
    expect(useNotesStore.getState().checkedIds).toEqual([]);
  });

  it("warnWithPanel 恢复面板可见、警告并落无正文诊断脚注", () => {
    reset("sent");
    useUIStore.setState({ open: false });
    apiMocks.diagNote.mockReset().mockResolvedValue(undefined);

    warnWithPanel("测试警告", "test-code");

    expect(useUIStore.getState().open).toBe(true);
    expect(apiMocks.showPanel).toHaveBeenCalled();
    expect(tip).toHaveBeenCalledWith("warn", "测试警告");
    expect(apiMocks.diagNote).toHaveBeenCalledWith("前端阻断: test-code");
  });

  it("发送闸门拦截（如目标 blocked）时恢复面板而不是静默失败", async () => {
    reset("blocked");
    useUIStore.setState({ open: false });
    applyTargetEvent({
      ...target,
      revision: target.revision + 1,
      ready: false,
      reason: "target_exited",
    });
    const noteId = useNotesStore.getState().addNote("hidden panel").id!;

    const outcome = await sendNotesToChat([noteId]);

    expect(outcome).toBeNull();
    expect(apiMocks.sendDelivery).not.toHaveBeenCalled();
    expect(useUIStore.getState().open).toBe(true);
    expect(apiMocks.showPanel).toHaveBeenCalled();
  });
});

describe("armNoteEditUndo 编辑收尾撤销", () => {
  beforeEach(() => {
    vi.mocked(tip).mockClear();
    vi.mocked(setPendingUndo).mockClear();
    useNotesStore.setState({
      sections: [{ id: INBOX_ID, name: "收件箱" }],
      notes: [],
      tasks: [],
      taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }],
      checkedIds: [],
      settings: defaultSettings(),
      undoStack: [],
    });
  });

  const findNote = (id: string) =>
    useNotesStore.getState().notes.find((n) => n.id === id)!;

  it("出可撤销「已保存」；撤销把正文还原到本次编辑前", () => {
    const id = useNotesStore.getState().addNote("编辑前的原文").id!;
    useNotesStore.getState().updateNoteText(id, "编辑后的新内容");

    armNoteEditUndo(id, { text: "编辑前的原文" });

    expect(tip).toHaveBeenCalledWith("ok", "已保存", true);
    expect(setPendingUndo).toHaveBeenCalledTimes(1);
    const undo = vi.mocked(setPendingUndo).mock.calls[0][0];
    undo();
    expect(findNote(id).text).toBe("编辑前的原文");
    expect(tip).toHaveBeenCalledWith("undone", "已撤销");
  });

  it("flat origin 携带附件清单：撤销一并还原图片集合", () => {
    const id = useNotesStore
      .getState()
      .addNote("组合卡", { attachments: ["a.png", "b.png"] }).id!;
    useNotesStore.getState().updateNoteText(id, "改过的文字", ["a.png"]);
    expect(findNote(id).contentBlocks?.filter((b) => b.type === "image")).toHaveLength(1);

    armNoteEditUndo(id, { text: "组合卡", images: ["a.png", "b.png"] });
    vi.mocked(setPendingUndo).mock.calls[0][0]();

    const restored = findNote(id);
    expect(restored.text).toBe("组合卡");
    expect(
      restored.contentBlocks?.filter((b) => b.type === "image").map((b) =>
        b.type === "image" ? b.file : ""
      )
    ).toEqual(["a.png", "b.png"]);
  });

  it("blocks origin：撤销还原有序图文块", () => {
    const id = useNotesStore.getState().addNote("", {
      contentBlocks: [
        { type: "text", text: "图前" },
        { type: "image", file: "inline.png" },
        { type: "text", text: "图后" },
      ],
    }).id!;
    useNotesStore.getState().updateNoteContent(id, [
      { type: "text", text: "改动后的图前" },
      { type: "image", file: "inline.png" },
      { type: "text", text: "图后" },
    ]);

    armNoteEditUndo(id, {
      contentBlocks: [
        { type: "text", text: "图前" },
        { type: "image", file: "inline.png" },
        { type: "text", text: "图后" },
      ],
    });
    vi.mocked(setPendingUndo).mock.calls[0][0]();

    const blocks = findNote(id).contentBlocks!;
    expect(blocks[0]).toEqual({ type: "text", text: "图前" });
  });
});

describe("富卡逐块处理与剪贴收编（2026-08-20 契约收口）", () => {
  beforeEach(() => {
    vi.mocked(tip).mockClear();
    vi.mocked(setPendingUndo).mockClear();
    useNotesStore.setState({
      sections: [
        { id: CLIPBOARD_ID, name: "剪贴板" },
        { id: INBOX_ID, name: "收件箱" },
      ],
      notes: [],
      checkedIds: [],
      undoStack: [],
      settings: {
        ...defaultSettings(),
        aliasEntitiesEnabled: true,
        aliasEntities: [
          {
            id: "alias-1",
            category: "USER",
            originalText: "小明",
            placeholder: "[USER_01]",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      },
    });
  });

  it("restoreNoteAliasesWithUndo：交错富卡逐块恢复，图片块与交错顺序不变", () => {
    const blocks = [
      { type: "text" as const, text: "你好 [USER_01]" },
      { type: "image" as const, file: "a.png", width: 10, height: 5 },
      { type: "text" as const, text: "再见 [USER_01]" },
      { type: "image" as const, file: "b.png" },
    ];
    const { id } = useNotesStore
      .getState()
      .addNote("占位", { contentBlocks: blocks });

    restoreNoteAliasesWithUndo(id!);

    const note = useNotesStore.getState().notes.find((n) => n.id === id)!;
    expect(note.contentBlocks).toEqual([
      { type: "text", text: "你好 小明" },
      { type: "image", file: "a.png", width: 10, height: 5 },
      { type: "text", text: "再见 小明" },
      { type: "image", file: "b.png" },
    ]);
    expect(note.text).toBe("你好 小明\n再见 小明");
    expect(vi.mocked(tip)).toHaveBeenCalledWith("ok", "已恢复 2 处化名", true);

    // 快照撤销可还原编辑前的完整块结构
    const label = useNotesStore.getState().undo();
    expect(label).toBe("恢复化名");
    expect(
      useNotesStore.getState().notes.find((n) => n.id === id)!.contentBlocks
    ).toEqual(blocks);
  });

  it("mergeCheckedWithUndo 混域勾选：警告提示且不动任何数据", () => {
    useNotesStore.getState().addClipNote("剪贴内容", {});
    const { id: noteId } = useNotesStore.getState().addNote("笔记内容");
    const clip = useNotesStore
      .getState()
      .notes.find((n) => n.sectionId === CLIPBOARD_ID)!;
    useNotesStore.getState().setChecked([clip.id, noteId!]);
    const before = useNotesStore.getState().notes;

    mergeCheckedWithUndo();

    expect(useNotesStore.getState().notes).toEqual(before);
    expect(vi.mocked(tip)).toHaveBeenCalledWith(
      "warn",
      "剪贴卡与笔记不能混合合并"
    );
    expect(vi.mocked(setPendingUndo)).not.toHaveBeenCalled();
  });

  it("moveClipsToNotesWithUndo：移动 + 状态重置 + 可撤销提示", () => {
    useNotesStore.getState().addClipNote("要收编的", {});
    const clip = useNotesStore.getState().notes[0];
    useNotesStore.getState().setDone([clip.id], true);
    useNotesStore.getState().toggleNoteKeep(clip.id);

    moveClipsToNotesWithUndo([clip.id]);

    const moved = useNotesStore.getState().notes.find((n) => n.id === clip.id)!;
    expect(moved.sectionId).toBe(INBOX_ID);
    expect(moved.done).toBe(false);
    expect(moved.keep).toBe(false);
    expect(vi.mocked(tip)).toHaveBeenCalledWith("ok", "已移入笔记", true);
    expect(vi.mocked(setPendingUndo)).toHaveBeenCalled();
  });
});
