import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAiKeyStatus: vi.fn(),
  aiChat: vi.fn(),
  tip: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  api: {
    getAiKeyStatus: mocks.getAiKeyStatus,
    aiChat: mocks.aiChat,
  },
}));
vi.mock("@/lib/tip", () => ({ tip: mocks.tip }));
vi.mock("@/lib/actions", () => ({ undoableTip: vi.fn() }));

import { parseTaskInput } from "./ai";
import { defaultSettings, useNotesStore } from "@/store/notesStore";
import { useDataOperationStore } from "@/store/dataOperationStore";

function configureAi() {
  useNotesStore.setState({
    tasks: [],
    settings: {
      ...defaultSettings(),
      aiEnabled: true,
      aiBaseUrl: "https://api.example.com",
      aiModel: "test-model",
    },
  });
}

describe("AI task input failure fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDataOperationStore.setState({ locked: false, phase: "idle", message: "" });
    configureAi();
  });

  it("未配置或删除 Keychain key 时按原文创建普通任务", async () => {
    mocks.getAiKeyStatus.mockResolvedValue({
      configured: false,
      updatedAtMs: null,
    });

    await parseTaskInput("删除密钥后仍要留下这句输入");

    expect(useNotesStore.getState().tasks[0].text).toBe(
      "删除密钥后仍要留下这句输入"
    );
    expect(mocks.aiChat).not.toHaveBeenCalled();
  });

  it.each([
    ["network", () => Promise.reject(new Error("offline"))],
    ["parse", () => Promise.resolve("not-json")],
  ])("%s 失败时不丢输入", async (_kind, response) => {
    mocks.getAiKeyStatus.mockResolvedValue({ configured: true, updatedAtMs: 1 });
    mocks.aiChat.mockImplementation(response);

    await parseTaskInput("网络或解析失败也必须保留");

    expect(useNotesStore.getState().tasks[0].text).toBe(
      "网络或解析失败也必须保留"
    );
    expect(mocks.tip).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("已按原文创建任务")
    );
  });
});
