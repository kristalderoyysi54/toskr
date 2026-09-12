import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAiKeyStatus: vi.fn(),
  aiChat: vi.fn(),
  beginAiRequest: vi.fn(),
  authorizeAiRequest: vi.fn(),
  cancelAiRequest: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  api: {
    getAiKeyStatus: mocks.getAiKeyStatus,
    aiChat: mocks.aiChat,
    beginAiRequest: mocks.beginAiRequest,
    authorizeAiRequest: mocks.authorizeAiRequest,
    cancelAiRequest: mocks.cancelAiRequest,
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
import { useDataOperationStore } from "@/store/dataOperationStore";

describe("aiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.beginAiRequest.mockResolvedValue("native-request-1");
    mocks.authorizeAiRequest.mockResolvedValue(undefined);
    mocks.cancelAiRequest.mockResolvedValue(undefined);
    useDataOperationStore.setState({ locked: false, phase: "idle", message: "" });
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

  afterEach(() => vi.useRealTimers());

  it("旧 AI 与转换共用同一 Keychain + 进程内 transport", async () => {
    mocks.aiChat.mockResolvedValue("完成");

    await expect(requestAi({
      purpose: "summarize",
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
      300,
      "native-request-1",
      "summarize"
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
      purpose: "summarize",
      system: "系统",
      user: "正文",
      maxTokens: 300,
    });
    await vi.waitFor(() => expect(mocks.aiChat).toHaveBeenCalledTimes(1));

    handle.cancel();
    await expect(handle.result).rejects.toMatchObject({
      kind: "cancelled",
    } satisfies Partial<AiError>);

    expect(mocks.cancelAiRequest).toHaveBeenCalledExactlyOnceWith("native-request-1");
    handle.cancel();
    expect(mocks.cancelAiRequest).toHaveBeenCalledTimes(1);
    resolveTransport("迟到结果");
    await handle.transportSettled;
    await expect(handle.result).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("原生登记未回执时取消，登记返回后撤销且不提交 HTTP", async () => {
    let registered!: (id: string) => void;
    mocks.beginAiRequest.mockReturnValue(new Promise<string>((resolve) => { registered = resolve; }));
    const handle = startAiRequest({ purpose: "summarize", system: "系统", user: "正文", maxTokens: 300 });
    await vi.waitFor(() => expect(mocks.beginAiRequest).toHaveBeenCalledTimes(1));
    handle.cancel();
    await expect(handle.result).rejects.toMatchObject({ kind: "cancelled" });
    registered("native-delayed");
    await handle.transportSettled;
    expect(mocks.cancelAiRequest).toHaveBeenCalledExactlyOnceWith("native-delayed");
    expect(mocks.aiChat).not.toHaveBeenCalled();
  });

  it("预先取消的 signal 不读取密钥或登记请求", async () => {
    const controller = new AbortController();
    controller.abort();
    const handle = startAiRequest({ purpose: "summarize", system: "系统", user: "正文", maxTokens: 300, signal: controller.signal });
    await expect(handle.result).rejects.toMatchObject({ kind: "cancelled" });
    await handle.transportSettled;
    expect(mocks.getAiKeyStatus).not.toHaveBeenCalled();
    expect(mocks.beginAiRequest).not.toHaveBeenCalled();
  });

  it("超时通知原生取消，并等底层结束才释放 transport", async () => {
    vi.useFakeTimers();
    let rejectTransport!: (reason: string) => void;
    mocks.aiChat.mockReturnValue(new Promise<string>((_resolve, reject) => { rejectTransport = reject; }));
    const handle = startAiRequest({ purpose: "summarize", system: "系统", user: "正文", maxTokens: 300, timeoutMs: 100 });
    const rejection = expect(handle.result).rejects.toMatchObject({ kind: "network", message: "AI 请求超时" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.aiChat).toHaveBeenCalledTimes(1);
    let settled = false;
    void handle.transportSettled.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(mocks.cancelAiRequest).toHaveBeenCalledExactlyOnceWith("native-request-1");
    expect(settled).toBe(false);
    rejectTransport("AI 请求已取消");
    await handle.transportSettled;
    expect(settled).toBe(true);
  });
  it("最终 system/user 与用途先原生授权，拒绝时 aiChat 调用为零", async () => {
    mocks.authorizeAiRequest.mockRejectedValue("已取消向 AI 发送敏感原文");
    const handle = startAiRequest({ purpose: "message-draft", system: "系统敏感内容", user: "原始消息", maxTokens: 300 });
    await expect(handle.result).rejects.toMatchObject({ message: "已取消向 AI 发送敏感原文" });
    await handle.transportSettled;
    expect(mocks.authorizeAiRequest).toHaveBeenCalledExactlyOnceWith("native-request-1", {
      baseUrl: "https://api.deepseek.com", model: "deepseek-chat", purpose: "message-draft",
      system: "系统敏感内容", user: "原始消息", maxTokens: 300,
    });
    expect(mocks.aiChat).not.toHaveBeenCalled();
  });

  it("授权等待中取消，迟到批准不进入原生 AI 请求", async () => {
    let approve!: () => void;
    mocks.authorizeAiRequest.mockReturnValue(new Promise<void>((resolve) => { approve = resolve; }));
    const handle = startAiRequest({ purpose: "summarize", system: "系统", user: "正文", maxTokens: 300 });
    await vi.waitFor(() => expect(mocks.authorizeAiRequest).toHaveBeenCalledTimes(1));
    handle.cancel();
    await expect(handle.result).rejects.toMatchObject({ kind: "cancelled" });
    approve();
    await handle.transportSettled;
    expect(mocks.aiChat).not.toHaveBeenCalled();
    expect(mocks.cancelAiRequest).toHaveBeenCalledExactlyOnceWith("native-request-1");
  });

  it("请求开始即固定载荷，授权等待期间调用者改对象不改变待发送文本", async () => {
    let approve!: () => void;
    mocks.authorizeAiRequest.mockReturnValue(new Promise<void>((resolve) => { approve = resolve; }));
    mocks.aiChat.mockResolvedValue("结果");
    const input = { purpose: "summarize" as const, system: "系统", user: "原文", maxTokens: 300 };
    const handle = startAiRequest(input);
    await vi.waitFor(() => expect(mocks.authorizeAiRequest).toHaveBeenCalledTimes(1));
    input.user = "替换敏感正文";
    approve();
    await expect(handle.result).resolves.toBe("结果");
    expect(mocks.aiChat).toHaveBeenCalledWith(
      "https://api.deepseek.com", "deepseek-chat", "系统", "原文", 300, "native-request-1", "summarize"
    );
    expect(mocks.cancelAiRequest).not.toHaveBeenCalled();
  });

});
