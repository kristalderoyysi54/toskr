import { describe, expect, it } from "vitest";

import {
  aiReady,
  isNoteToTaskResult,
  isSplitResult,
  isTitleResult,
  matchPreset,
  normalizeParsedTask,
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
