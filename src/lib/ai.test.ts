import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/aiClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/aiClient")>(),
  requestAi: vi.fn(),
}));
vi.mock("@/lib/tip", () => ({ tip: vi.fn() }));
vi.mock("@/lib/actions", () => ({ undoableTip: vi.fn() }));

import { requestAi } from "./aiClient";
import { useNotesStore } from "@/store/notesStore";
import { useDataOperationStore } from "@/store/dataOperationStore";

import {
  aiReady,
  isNoteToTaskResult,
  isSplitResult,
  isTitleResult,
  matchPreset,
  normalizeParsedTask,
  parseTaskInput,
  repairJson,
  stripJsonFence,
  truncateChars,
} from "./ai";

describe("stripJsonFence", () => {
  it("纯 JSON 原样返回", () => {
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });
  it("剥 ```json 围栏", () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("剥无语言标签围栏", () => {
    expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("围栏外带解释文字也能定位对象", () => {
    expect(stripJsonFence('好的，结果是：{"a":1}。以上。')).toBe('{"a":1}');
  });
  it("嵌套对象取到最外层闭合", () => {
    expect(stripJsonFence('前缀 {"a":{"b":2}} 后缀')).toBe('{"a":{"b":2}}');
  });
});

describe("normalizeParsedTask（宽容归一化）", () => {
  const NOW = new Date(2026, 7, 5, 10, 0).getTime();
  it("相对分钟 → now 偏移", () => {
    const r = normalizeParsedTask(
      { title: "关火", due: { minutesFromNow: 20 }, priority: "high", checklist: [] },
      "原文",
      NOW
    )!;
    expect(r.dueAtMs).toBe(NOW + 20 * 60_000);
    expect(r.priority).toBe("high");
  });
  it("日期+钟点 → 本地时间戳；支持斜杠日期与数字字符串分钟", () => {
    const r = normalizeParsedTask(
      { title: "开会", due: { date: "2026/08/05", time: "15:00" }, priority: "none", checklist: [] },
      "原文",
      NOW
    )!;
    expect(r.dueAtMs).toBe(new Date(2026, 7, 5, 15, 0).getTime());
    const r2 = normalizeParsedTask(
      { title: "x", due: { minutesFromNow: "30" }, priority: "none", checklist: [] },
      "原文",
      NOW
    )!;
    expect(r2.dueAtMs).toBe(NOW + 30 * 60_000);
  });
  it("旧式 dueAtMs 兼容：数字字符串与秒级戳自动归一", () => {
    const ms = NOW + 3_600_000;
    expect(normalizeParsedTask({ title: "a", dueAtMs: String(ms), priority: "none" }, "f", NOW)!.dueAtMs).toBe(ms);
    expect(normalizeParsedTask({ title: "a", dueAtMs: Math.floor(ms / 1000), priority: "none" }, "f", NOW)!.dueAtMs).toBe(Math.floor(ms / 1000) * 1000);
  });
  it("过去的绝对时刻丢弃到期；缺标题回退原文；中文优先级归一", () => {
    const r = normalizeParsedTask(
      { due: { date: "2026-08-05", time: "08:00" }, priority: "紧急", checklist: [1, "有效项", " "] },
      "原始输入",
      NOW
    )!;
    expect(r.dueAtMs).toBeNull();
    expect(r.title).toBe("原始输入");
    expect(r.priority).toBe("high");
    expect(r.checklist).toEqual(["有效项"]);
  });
  it.each([
    ["2027-02-29", "09:00"],
    ["2026-09-31", "09:00"],
    ["2026-00-05", "09:00"],
    ["2026-13-05", "09:00"],
    ["2026-08-00", "09:00"],
    ["2026-08-32", "09:00"],
    ["2026-08-06", "24:00"],
    ["2026-08-06", "12:60"],
    ["2026-08-06", "12:30junk"],
    ["2026-08-06", "12:30:59"],
    ["2026-08-06", "12:3"],
    ["2026-08-06", ""],
    ["2026-08-06", 930],
  ])("拒绝无效日期或时间 %s %s，不顺延为其他时刻", (date, time) => {
    const result = normalizeParsedTask({ title: "保留事项", due: { date, time } }, "原文", NOW)!;
    expect(result.title).toBe("保留事项");
    expect(result.dueAtMs).toBeNull();
  });
  it("合法闰日及缺省钟点仍可使用", () => {
    expect(normalizeParsedTask({ due: { date: "2028-02-29", time: "23:59" } }, "原文", NOW)!.dueAtMs)
      .toBe(new Date(2028, 1, 29, 23, 59).getTime());
    expect(normalizeParsedTask({ due: { date: "2026-08-06" } }, "原文", NOW)!.dueAtMs)
      .toBe(new Date(2026, 7, 6, 9).getTime());
  });
  it("拒绝夏令时跳过的本地钟点，不顺延一小时", () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      const result = normalizeParsedTask({ due: { date: "2027-03-14", time: "02:30" } }, "原文", NOW)!;
      expect(result.dueAtMs).toBeNull();
      expect(normalizeParsedTask({ due: { date: "2027-03-14", time: "03:30" } }, "原文", NOW)!.dueAtMs)
        .toBe(new Date(2027, 2, 14, 3, 30).getTime());
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("拒绝超出 Date 范围的相对时长及旧时间戳", () => {
    expect(normalizeParsedTask({ due: { minutesFromNow: 1e300 } }, "原文", NOW)!.dueAtMs).toBeNull();
    expect(normalizeParsedTask({ dueAtMs: 1e300 }, "原文", NOW)!.dueAtMs).toBeNull();
  });
  it("非对象返回 null", () => {
    expect(normalizeParsedTask("字符串", "f", NOW)).toBeNull();
    expect(normalizeParsedTask(null, "f", NOW)).toBeNull();
  });
});

describe("repairJson", () => {
  it("修复尾逗号与中文引号", () => {
    expect(JSON.parse(repairJson('{"a":1,}'))).toEqual({ a: 1 });
    expect(JSON.parse(repairJson('{\u201ca\u201d: \u201cb\u201d}'))).toEqual({ a: "b" });
    expect(JSON.parse(repairJson('{"list":[1,2,],}'))).toEqual({ list: [1, 2] });
  });
});

describe("其余守卫", () => {
  it("isSplitResult / isNoteToTaskResult / isTitleResult", () => {
    expect(isSplitResult({ items: ["a"] })).toBe(true);
    expect(isSplitResult({ items: "a" })).toBe(false);
    expect(isNoteToTaskResult({ title: "t", checklist: [] })).toBe(true);
    expect(isNoteToTaskResult({ title: " ", checklist: [] })).toBe(false);
    expect(isTitleResult({ title: "短标题" })).toBe(true);
    expect(isTitleResult({})).toBe(false);
  });
});

describe("aiReady / matchPreset / truncateChars", () => {
  const full = {
    aiEnabled: true,
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-chat",
  };
  it("启用、地址和模型缺一不可；key 状态由 Rust Keychain 负责", () => {
    expect(aiReady(full)).toBe(true);
    expect(aiReady({ ...full, aiEnabled: false })).toBe(false);
    expect(aiReady({ ...full, aiBaseUrl: " " })).toBe(false);
    expect(aiReady({ ...full, aiModel: "" })).toBe(false);
  });
  it("matchPreset 命中与回退", () => {
    expect(matchPreset("https://api.deepseek.com")).toBe("deepseek");
    expect(matchPreset("https://my.proxy.dev")).toBe("custom");
    expect(matchPreset("")).toBe("custom");
  });
  it("truncateChars 按码点截断，emoji 不劈半", () => {
    expect(truncateChars("abcdef", 3)).toBe("abc");
    expect(truncateChars("你好世界", 2)).toBe("你好");
    expect(truncateChars("🎉🎉🎉", 2)).toBe("🎉🎉");
    expect(truncateChars("  短  ", 10)).toBe("短");
  });
});


describe("任务解析参考时刻", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("跨午夜的慢响应以请求前时刻计算相对期限，并与提示词共享日期", async () => {
    vi.useFakeTimers();
    const reference = new Date(2026, 8, 10, 23, 59).getTime();
    vi.setSystemTime(reference);
    useDataOperationStore.setState({ locked: false, phase: "idle", message: "" });
    useNotesStore.setState({ tasks: [] });
    let respond!: (raw: string) => void;
    vi.mocked(requestAi).mockReturnValue(new Promise((resolve) => { respond = resolve; }));
    const running = parseTaskInput("20分钟后开会");
    expect(requestAi).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringContaining("2026-09-10 23:59"),
    }));
    vi.setSystemTime(reference + 5 * 60_000);
    respond(JSON.stringify({ title: "开会", due: { minutesFromNow: 20 } }));
    await running;
    expect(useNotesStore.getState().tasks[0].dueAt).toBe(reference + 20 * 60_000);
  });
});
