import { describe, expect, it } from "vitest";

import {
  lessonAfterCapture,
  lessonAfterChecked,
  lessonAfterDelivery,
  lessonSamplesReady,
  privacyLessonReply,
  startLesson,
} from "@/lib/lessons";

describe("进阶课状态机", () => {
  it("合并课：放入示例 → 两张都勾选 → 一次发送两张才完成", () => {
    let progress = lessonSamplesReady(startLesson("merge"), ["a", "b"]);
    expect(progress.step).toBe(1);
    expect(lessonAfterChecked(progress, ["a"]).step).toBe(1);
    progress = lessonAfterChecked(progress, ["a", "b", "user-card"]);
    expect(progress.step).toBe(2);
    expect(lessonAfterDelivery(progress, ["a"]).step).toBe(2);
    expect(lessonAfterDelivery(progress, ["a", "b"]).step).toBe(3);
  });

  it("合并课：直接用 ⌘⏎ 发送两张示例也算完成（跳过勾选提示）", () => {
    const progress = lessonSamplesReady(startLesson("merge"), ["a", "b"]);
    expect(lessonAfterDelivery(progress, ["b", "a"]).step).toBe(3);
  });

  it("还原课：发送示例卡后进入收回步骤，捕获时还原至少一处才完成", () => {
    let progress = lessonSamplesReady(startLesson("privacy"), ["sample"], "alias-1");
    expect(progress.aliasId).toBe("alias-1");
    expect(lessonAfterCapture(progress, "reply", 1).step).toBe(1);
    progress = lessonAfterDelivery(progress, ["other"]);
    expect(progress.step).toBe(1);
    progress = lessonAfterDelivery(progress, ["sample"]);
    expect(progress.step).toBe(2);
    expect(lessonAfterCapture(progress, "reply", 0).step).toBe(2);
    expect(lessonAfterCapture(progress, "reply", null).step).toBe(2);
    const done = lessonAfterCapture(progress, "reply", 1);
    expect(done.step).toBe(3);
    expect(done.replyNoteId).toBe("reply");
  });

  it("未准备示例或课程不匹配时不前进，返回原对象", () => {
    const merge = startLesson("merge");
    expect(lessonAfterChecked(merge, [])).toBe(merge);
    expect(lessonAfterDelivery(merge, ["a", "b"])).toBe(merge);
    const privacy = lessonSamplesReady(startLesson("privacy"), ["s"]);
    expect(lessonAfterChecked(privacy, ["s"])).toBe(privacy);
  });

  it("模拟回复带占位符，交给捕获时的词典还原", () => {
    expect(privacyLessonReply("[USER_02]")).toContain("[USER_02]");
  });
});
