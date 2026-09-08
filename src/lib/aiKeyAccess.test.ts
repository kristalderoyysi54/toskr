import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  setKey: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, listener);
    return () => { mocks.listeners.delete(name); };
  }),
  emitTo: vi.fn(async (_window: string, name: string, payload: unknown) => {
    mocks.listeners.get(name)?.({ payload });
  }),
}));
vi.mock("@/lib/tauri", () => ({
  api: { getAiKeyStatus: mocks.getStatus, setAiApiKey: mocks.setKey },
  isAiKeyStatus: (status: unknown) => typeof status === "object" && status !== null &&
    "configured" in status && typeof status.configured === "boolean",
}));
vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { emitTo } from "@tauri-apps/api/event";
import {
  getAiKeyStatusForUse,
  installAiKeyAccessHost,
  requestAiKeyStatusForSettings,
} from "./aiKeyAccess";
import { advanceDataGeneration } from "./dataGeneration";
import { defaultSettings, useNotesStore, type Settings } from "@/store/notesStore";
import { useDataOperationStore } from "@/store/dataOperationStore";

const configured = { configured: true, updatedAtMs: 12 };

function setLegacy(key = "test-legacy-key") {
  useNotesStore.setState({ settings: { ...defaultSettings(), aiApiKey: key } as Settings });
}

describe("AI 按需密钥访问", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    advanceDataGeneration();
    useDataOperationStore.setState({ locked: false, phase: "idle", message: "" });
    setLegacy();
    mocks.getStatus.mockResolvedValue({ configured: false, updatedAtMs: null });
    mocks.setKey.mockResolvedValue(configured);
  });

  it("启动只安装请求监听，不读取或迁移密钥", async () => {
    const stop = await installAiKeyAccessHost();
    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(mocks.setKey).not.toHaveBeenCalled();
    stop();
  });

  it("并发首次使用只迁移一次，成功后保留在途修改的其他设置", async () => {
    let finish!: (value: typeof configured) => void;
    mocks.setKey.mockReturnValue(new Promise<typeof configured>((resolve) => { finish = resolve; }));
    const first = getAiKeyStatusForUse();
    const second = getAiKeyStatusForUse();
    await vi.waitFor(() => expect(mocks.setKey).toHaveBeenCalledTimes(1));
    useNotesStore.setState((state) => ({ settings: { ...state.settings, aiModel: "new-model" } }));
    finish(configured);

    expect(first).toBe(second);
    await expect(first).resolves.toEqual(configured);
    expect(mocks.setKey).toHaveBeenCalledWith("test-legacy-key", false);
    expect(useNotesStore.getState().settings).not.toHaveProperty("aiApiKey");
    expect(useNotesStore.getState().settings.aiModel).toBe("new-model");
  });

  it.each(["generation", "locked", "replacement"])("迁移在途发生 %s 变化不清理当前旧副本", async (change) => {
    let finish!: (value: typeof configured) => void;
    mocks.setKey.mockReturnValue(new Promise<typeof configured>((resolve) => { finish = resolve; }));
    const access = getAiKeyStatusForUse();
    // 先附加拒绝处理，避免上下文失效时产生未处理 rejection。
    const settled = access.catch(() => null);
    await vi.waitFor(() => expect(mocks.setKey).toHaveBeenCalledTimes(1));
    if (change === "generation") advanceDataGeneration();
    if (change === "locked") useDataOperationStore.setState({ locked: true });
    if (change === "replacement") setLegacy("replacement-key");
    finish(configured);
    await settled;
    expect(useNotesStore.getState().settings).toHaveProperty(
      "aiApiKey", change === "replacement" ? "replacement-key" : "test-legacy-key"
    );
  });

  it("授权取消后不再发起迁移写入，并保留旧副本", async () => {
    mocks.getStatus.mockRejectedValue(new Error("authorization cancelled"));
    await expect(getAiKeyStatusForUse()).rejects.toThrow("authorization cancelled");
    expect(mocks.setKey).not.toHaveBeenCalled();
    expect(useNotesStore.getState().settings).toHaveProperty("aiApiKey", "test-legacy-key");
  });

  it("已有不同密钥仍可使用，迁移失败不覆盖或清理旧副本", async () => {
    mocks.getStatus.mockResolvedValue(configured);
    mocks.setKey.mockRejectedValue(new Error("already configured differently"));
    await expect(getAiKeyStatusForUse()).resolves.toEqual(configured);
    expect(mocks.setKey).toHaveBeenCalledWith("test-legacy-key", false);
    expect(useNotesStore.getState().settings).toHaveProperty("aiApiKey");
  });

  it("删除 tombstone 拒绝旧副本回迁后不会尝试覆盖", async () => {
    mocks.setKey.mockRejectedValue(new Error("deleted tombstone"));
    await expect(getAiKeyStatusForUse()).rejects.toThrow("AI 密钥迁移失败");
    expect(mocks.setKey.mock.calls).toEqual([["test-legacy-key", false]]);
    expect(useNotesStore.getState().settings).toHaveProperty("aiApiKey");
  });

  it("只读状态下不发起任何钥匙串访问", async () => {
    useDataOperationStore.setState({ locked: true });
    await expect(getAiKeyStatusForUse()).rejects.toThrow("数据操作进行中");
    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(mocks.setKey).not.toHaveBeenCalled();
  });

  it("AI 设置入口由主窗口迁移，跨窗口事件只携带请求 ID 和状态", async () => {
    const stop = await installAiKeyAccessHost();
    await expect(requestAiKeyStatusForSettings()).resolves.toEqual(configured);
    expect(mocks.setKey).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(emitTo).mock.calls)).not.toContain("test-legacy-key");
    expect(mocks.listeners.has("toskr://ai-key-access-result")).toBe(false);
    stop();
  });
});
