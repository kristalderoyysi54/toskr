import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAiKeyStatus: vi.fn(),
  aiChat: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  api: {
    getAiKeyStatus: mocks.getAiKeyStatus,
    aiChat: mocks.aiChat,
  },
}));
vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
  AiError,
  describeAiClient,
  requestAi,
  startAiRequest,
} from "./aiClient";
import { defaultSettings, useNotesStore } from "@/store/notesStore";

describe("aiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotesStore.setState({
      settings: {
        ...defaultSettings(),
        aiEnabled: true,
        aiBaseUrl: "https://api.deepseek.com",
        aiModel: "deepseek-chat",
      },
    });
    mocks.getAiKeyStatus.mockResolvedValue({ configured: true, updatedAtMs: 1 });
  });

  it("旧 AI 与转换共用同一 Keychain + 进程内 transport", async () => {
    mocks.aiChat.mockResolvedValue("完成");

    await expect(requestAi({
      system: "系统",
      user: "正文",
      maxTokens: 300,
    })).resolves.toBe("完成");

    expect(mocks.getAiKeyStatus).toHaveBeenCalledTimes(1);
    expect(mocks.aiChat).toHaveBeenCalledWith(
      "https://api.deepseek.com",
      "deepseek-chat",
      "系统",
      "正文",
      300
    );
    expect(describeAiClient()).toMatchObject({
      provider: "DeepSeek",
      model: "deepseek-chat",
      ready: true,
    });
  });

  it("本地取消立即释放结果等待，底层迟到响应不可重新完成", async () => {
    let resolveTransport!: (value: string) => void;
    mocks.aiChat.mockReturnValue(new Promise<string>((resolve) => {
      resolveTransport = resolve;
    }));
    const handle = startAiRequest({
      system: "系统",
      user: "正文",
      maxTokens: 300,
    });
    await vi.waitFor(() => expect(mocks.aiChat).toHaveBeenCalledTimes(1));

    handle.cancel();
    await expect(handle.result).rejects.toMatchObject({
      kind: "cancelled",
    } satisfies Partial<AiError>);

    resolveTransport("迟到结果");
    await handle.transportSettled;
    await expect(handle.result).rejects.toMatchObject({ kind: "cancelled" });
  });
});
