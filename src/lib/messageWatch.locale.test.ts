import { afterEach, describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { messageTaskNote, messageTaskTitle, normalizeMessageWatchRules, type MessageItem } from "@/lib/messages";
import { formatMessageWatchNote } from "@/lib/messageWatch";
import type { MessageWatchCapture } from "@/lib/tauri";

const capture: MessageWatchCapture = {
  conversationId: "group-1",
  messageId: "message-1",
  conversationName: null,
  senderUid: "42",
  senderName: null,
  occurredAtMs: 1_765_000_000_000,
  receivedAtMs: 1_765_000_000_100,
  mentionedSelf: true,
  followedSender: false,
  matchedRuleIds: ["rule-1"],
  isGroup: true,
  messageType: "image",
  text: "",
  context: [],
};

describe("消息生成内容跟随界面语言", () => {
  afterEach(() => applyLocale("zh"));

  it("英文界面生成英文笔记摘要", () => {
    applyLocale("en");
    const note = formatMessageWatchNote(capture);
    expect(note.startsWith("[Unknown group]\nUser 42 · @me + Rule · ")).toBe(true);
    expect(note).toContain("[image]");
    expect(note).toContain("Message ID: message-1");
  });

  it("英文界面生成英文任务标题、备注与默认规则名", () => {
    applyLocale("en");
    const message = {
      ...capture,
      id: "m",
      source: "im",
      status: "new",
      senderUid: "",
    } as MessageItem;
    expect(messageTaskTitle(message)).toBe("[Group message] Handle message");
    const note = messageTaskNote(message);
    expect(note).toContain("Source: IM · group-1");
    expect(note).toContain("Sender: Unknown sender");
    expect(note).toContain("Message ID: message-1");
    expect(normalizeMessageWatchRules([{ keywords: ["release"] }])[0].name).toBe("Rule 1");
  });

  it("中文界面保持原文", () => {
    expect(formatMessageWatchNote(capture).startsWith("【未知群组】\n用户 42 · @我 + 组合规则 · ")).toBe(true);
    expect(normalizeMessageWatchRules([{ keywords: ["发布"] }])[0].name).toBe("关注规则 1");
  });
});
