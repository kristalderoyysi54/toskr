import { describe, expect, it } from "vitest";

import {
  matchingMessageRuleIds,
  mergeMessageCapture,
  messageItemFromCapture,
  normalizeMessageWatchRules,
} from "./messages";

const capture = {
  conversationId: "g-1",
  messageId: "m-1",
  conversationName: "项目发布群",
  senderUid: "u-1",
  senderName: "小王",
  occurredAtMs: 10,
  receivedAtMs: 20,
  mentionedSelf: false,
  followedSender: false,
  matchedRuleIds: ["release"],
  isGroup: true,
  messageType: "text",
  text: "今晚准备发布",
  context: [],
};

describe("message rules", () => {
  it("ORs terms in one dimension and ANDs populated dimensions", () => {
    const rules = normalizeMessageWatchRules([
      {
        id: "release",
        name: "发布关注",
        enabled: true,
        groupTerms: ["项目", "研发"],
        senderTerms: ["小李", "小王"],
        keywords: ["上线", "发布"],
      },
      { id: "empty", name: "空规则", enabled: true },
    ]);
    expect(matchingMessageRuleIds(capture, rules)).toEqual(["release"]);
    expect(matchingMessageRuleIds({ ...capture, senderName: "其他人" }, rules)).toEqual([]);
    expect(rules.map((rule) => rule.id)).not.toContain("empty");
  });
});

describe("message projection", () => {
  it("keeps full text while preserving Toskr workflow fields during replay", () => {
    const first = {
      ...messageItemFromCapture(capture),
      status: "waiting" as const,
      aiDraft: "稍后回复",
    };
    const merged = mergeMessageCapture(first, {
      ...capture,
      text: "今晚准备发布，正文已经补全",
      context: [
        {
          messageId: "m-0",
          senderUid: "u-2",
          senderName: "小李",
          occurredAtMs: 5,
          messageType: "text",
          text: "完整前文",
        },
      ],
    });
    expect(merged.text).toBe("今晚准备发布，正文已经补全");
    expect(merged.context[0].text).toBe("完整前文");
    expect(merged.status).toBe("waiting");
    expect(merged.aiDraft).toBe("稍后回复");
  });
});
