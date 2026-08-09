import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  refreshTargetSnapshot: vi.fn(),
  refreshPrevApp: vi.fn(),
  sendDelivery: vi.fn(),
  showPanel: vi.fn(),
  appIcon: vi.fn(),
  diagNote: vi.fn(),
}));
const dialogMocks = vi.hoisted(() => ({ ask: vi.fn() }));

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: vi.fn() },
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
  sendCheckedToChat,
  sendNotesToChat,
  sendTaskToChat,
  warnWithPanel,
} from "./actions";
import { tip } from "./tip";
import type {
  DeliveryStatus,
  SendDeliveryRequest,
  SendDeliveryResult,
  TargetSnapshot,
} from "./tauri";
import {
  defaultSettings,
  INBOX_ID,
  TASK_INBOX_ID,
  useNotesStore,
} from "../store/notesStore";
import { useUIStore } from "../store/uiStore";
import { useDataOperationStore } from "../store/dataOperationStore";
import {
  applyTargetEvent,
  setTargetProfileOverride,
  observeTargetAfterBlur,
  resetTargetState,
  useTargetStore,
} from "../store/targetStore";

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
  useUIStore.setState({ open: true, pinned: false });
  apiMocks.appIcon.mockReset().mockResolvedValue(null);
  resetTargetState();
  applyTargetEvent(target);
  apiMocks.refreshTargetSnapshot.mockReset().mockResolvedValue(target);
  apiMocks.refreshPrevApp.mockReset();
  apiMocks.showPanel.mockReset().mockResolvedValue(undefined);
  apiMocks.sendDelivery
    .mockReset()
    .mockImplementation(async (request: SendDeliveryRequest) => result(request, status));
  dialogMocks.ask.mockReset().mockResolvedValue(true);
  vi.mocked(tip).mockClear();
}

describe("结构化发送结果的 store 副作用", () => {
  beforeEach(() => reset("sent"));

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

  it("enterPolicy=confirm 拒绝时不投递，确认后才允许 Enter", async () => {
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
    expect(tip).toHaveBeenCalledWith("warn", "目标已变化，请在面板确认 Profile 后重试");
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
    expect(tip).toHaveBeenCalledWith("warn", "目标已变化，请在面板确认 Profile 后重试");
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
      "Profile 设置已变化，请确认后重试发送"
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
    expect(tip).toHaveBeenCalledWith("warn", "投递目标已变化，请确认后重试发送");
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

  it("快速重复发送只允许一个原生投递在途", async () => {
    reset("blocked");
    const noteId = useNotesStore.getState().addNote("once").id!;
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
    resolveDelivery(result(request, "blocked"));
    await first;
    expect(apiMocks.sendDelivery).toHaveBeenCalledOnce();
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
