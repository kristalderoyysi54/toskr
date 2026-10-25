import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/aiClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/aiClient")>(),
  requestAi: vi.fn(),
}));
vi.mock("@/lib/tip", () => ({ tip: vi.fn() }));
vi.mock("@/lib/actions", () => ({ undoableTip: vi.fn() }));

import { requestAi } from "./aiClient";
import { applyLocale } from "./i18n";
import { tip } from "./tip";
import { useNotesStore } from "@/store/notesStore";
import { useDataOperationStore } from "@/store/dataOperationStore";
import { parseTaskDraft, testAiConnection } from "./ai";

describe("AI 提示词跟随界面语言", () => {
  afterEach(() => {
    applyLocale("zh");
    vi.clearAllMocks();
  });

  it("英文界面用英文任务解析提示词，解析与中文分组名匹配不变", async () => {
    applyLocale("en");
    useDataOperationStore.setState({ locked: false, phase: "idle", message: "" });
    const base = useNotesStore.getState().taskSections[0];
    useNotesStore.setState({ taskSections: [{ ...base, id: "work", name: "工作" }] });
    vi.mocked(requestAi).mockResolvedValue(
      JSON.stringify({
        title: "Weekly report",
        due: { minutesFromNow: 30 },
        priority: "high",
        checklist: ["Draft", "Send"],
        recurrence: { freq: "weekly", weekdays: [1] },
        section: "工作",
      })
    );
    const draft = await parseTaskDraft("weekly report in 30 minutes, put it in 工作");
    const request = vi.mocked(requestAi).mock.calls[0][0];
    expect(request.system).toContain("You are a task parser");
    expect(request.system).toContain("Existing groups: 工作");
    expect(request.system).not.toContain("你是任务解析助手");
    expect(draft).toMatchObject({
      title: "Weekly report",
      priority: "high",
      checklist: ["Draft", "Send"],
      recurrence: { freq: "weekly", weekdays: [1] },
      sectionId: "work",
    });
  });

  it("中文界面仍用原中文提示词", async () => {
    vi.mocked(requestAi).mockResolvedValue('{"title":"开会","due":null,"priority":"none","checklist":[]}');
    await parseTaskDraft("开会");
    expect(vi.mocked(requestAi).mock.calls[0][0].system).toContain("你是任务解析助手");
  });

  it("英文界面的失败提示与连通性测试提示词为英文", async () => {
    applyLocale("en");
    vi.mocked(requestAi).mockResolvedValue("not json");
    useNotesStore.setState({ tasks: [] });
    await parseTaskDraft("call mom");
    expect(tip).toHaveBeenCalledWith(
      "warn",
      "Couldn't parse the AI response · created the task from your text"
    );
    vi.mocked(requestAi).mockResolvedValue("OK");
    await testAiConnection("https://api.example.test", "model");
    expect(vi.mocked(requestAi).mock.calls[1][0]).toMatchObject({
      system: "You are a connectivity test assistant.",
      user: "If you receive this, reply only: OK",
    });
  });
});
