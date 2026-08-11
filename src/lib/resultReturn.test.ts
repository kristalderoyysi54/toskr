import { beforeEach, describe, expect, it } from "vitest";

import type { DeliveryEvent } from "./deliveryActivityCore";
import {
  RESULT_ASSOCIATION_WINDOW_MS,
  clearDeliveryRedactionSessions,
  deliveryCandidatesForCapturedNote,
  deliveryPlaceholderCounts,
  deliveryRedactionMapAvailable,
  previewRestoredPlaceholders,
  rememberDeliveryRedactionMap,
  resultAssociationState,
  resultCapturedEvent,
  resultNoteCandidatesForDelivery,
} from "./resultReturn";
import type { Note } from "@/store/notesStore";

const counts: DeliveryEvent["firewallCounts"] = {
  privateKey: 0,
  authorization: 0,
  apiKey: 0,
  databaseUrl: 0,
  email: 0,
  phone: 0,
  nationalId: 0,
  bankCard: 0,
  ipAddress: 0,
  cookie: 0,
  session: 0,
};

function sent(overrides: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    eventId: "event-sent",
    deliveryId: "delivery-1",
    eventType: "sendSent",
    timestampMs: 1_000,
    sourceKind: "note",
    sourceItemIds: ["source-1"],
    targetBundleId: "com.openai.chat",
    targetAppName: "Chat",
    profileId: "safe",
    status: "sent",
    reasonCode: null,
    durationMs: 20,
    textCharCount: 30,
    imageCount: 0,
    firewallCounts: counts,
    redactionCount: 1,
    clipboardOutcome: "restored",
    resultNoteId: null,
    ...overrides,
  };
}

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "result-1",
    text: "answer [EMAIL_01]",
    sectionId: "inbox",
    done: false,
    createdAt: 2_000,
    sourceApp: "Chat",
    sourceBundle: "com.openai.chat",
    ...overrides,
  };
}

describe("result return", () => {
  beforeEach(clearDeliveryRedactionSessions);

  it("只解析 30 分钟内、bundle 精确一致的成功投递，且纯解析不会自动关联", () => {
    const captured = note({ createdAt: 1_000 + RESULT_ASSOCIATION_WINDOW_MS });
    const candidates = deliveryCandidatesForCapturedNote(captured, [
      sent(),
      sent({ eventId: "blocked", deliveryId: "blocked", status: "blocked", eventType: "sendBlocked" }),
      sent({ eventId: "other", deliveryId: "other", targetBundleId: "com.other" }),
      sent({ eventId: "old", deliveryId: "old", timestampMs: 999 }),
    ]);

    expect(candidates.map((item) => item.deliveryId)).toEqual(["delivery-1"]);
    expect(captured.provenance).toBeUndefined();
  });

  it("单候选、多候选和无候选保持稳定排序", () => {
    const captured = note({ createdAt: 5_000 });
    expect(deliveryCandidatesForCapturedNote(captured, [sent()])).toHaveLength(1);
    expect(
      deliveryCandidatesForCapturedNote(captured, [
        sent({ eventId: "one", deliveryId: "one", timestampMs: 2_000 }),
        sent({ eventId: "two", deliveryId: "two", timestampMs: 4_000 }),
      ]).map((item) => item.deliveryId)
    ).toEqual(["two", "one"]);
    expect(deliveryCandidatesForCapturedNote(note({ sourceBundle: undefined }), [sent()])).toEqual([]);
  });

  it("从投递侧只列出其后 30 分钟内同 bundle 的现有 Note", () => {
    const event = sent();
    expect(
      resultNoteCandidatesForDelivery(event, [
        note({ id: "before", createdAt: 999 }),
        note({ id: "match", createdAt: 1_001 }),
        note({ id: "late", createdAt: 1_001 + RESULT_ASSOCIATION_WINDOW_MS }),
        note({ id: "other", createdAt: 1_002, sourceBundle: "com.other" }),
      ]).map((item) => item.id)
    ).toEqual(["match"]);
  });

  it("resultCaptured 只增加 resultNoteId 元数据，不复制结果正文", () => {
    const event = resultCapturedEvent(
      { ...sent(), rawText: "must-not-spread" } as DeliveryEvent,
      "result-1",
      2_000
    );
    expect(event).toMatchObject({
      eventType: "resultCaptured",
      status: "captured",
      resultNoteId: "result-1",
    });
    const serialized = JSON.stringify(event);
    expect(Object.keys(event).sort()).toEqual([
      "clipboardOutcome", "deliveryId", "durationMs", "eventId", "eventType",
      "firewallCounts", "imageCount", "metricsEligible", "metricsEpoch", "profileId", "reasonCode", "redactionCount",
      "resultNoteId", "sourceItemIds", "sourceKind", "status", "targetAppName",
      "targetBundleId", "textCharCount", "timestampMs", "transformRecipeId", "verificationCheckCount",
      "verificationIssueCount", "verificationStatus",
    ].sort());
    expect(serialized).not.toContain("answer [EMAIL_01]");
    expect(serialized).not.toContain("must-not-spread");
  });

  it("区分已关联、已解除和结果卡已删除", () => {
    const linked = note({ provenance: {
      kind: "deliveryResult",
      deliveryId: "delivery-1",
      capturedAtMs: 2_000,
      sourceBundle: "com.openai.chat",
      sourceItemIds: ["source-1"],
    } });
    const activity = sent({ resultNoteId: "result-1" });
    expect(resultAssociationState(activity, [linked])).toBe("linked");
    expect(resultAssociationState(activity, [note()])).toBe("unlinked");
    expect(resultAssociationState(activity, [])).toBe("missing");
    expect(resultAssociationState(sent(), [])).toBe("none");
  });

  it("占位符恢复只存在于有界会话内，清理后不可用", () => {
    rememberDeliveryRedactionMap("delivery-1", {
      "alice@example.com": "[EMAIL_01]",
    }, "Hi [EMAIL_01] and [EMAIL_01]");
    expect(deliveryRedactionMapAvailable("delivery-1")).toBe(true);
    expect(deliveryPlaceholderCounts("delivery-1")).toEqual({ "[EMAIL_01]": 2 });
    expect(previewRestoredPlaceholders("delivery-1", "Hi [EMAIL_01]")).toEqual({
      text: "Hi alice@example.com",
      replacedCount: 1,
    });
    clearDeliveryRedactionSessions();
    expect(deliveryRedactionMapAvailable("delivery-1")).toBe(false);
    expect(previewRestoredPlaceholders("delivery-1", "Hi [EMAIL_01]")).toBeNull();
  });

  it("会话映射最多保留 32 个 delivery，淘汰最旧项", () => {
    for (let index = 0; index < 33; index += 1) {
      rememberDeliveryRedactionMap(`delivery-${index}`, {
        [`source-${index}`]: `[VALUE_${index}]`,
      });
    }
    expect(deliveryRedactionMapAvailable("delivery-0")).toBe(false);
    expect(deliveryRedactionMapAvailable("delivery-1")).toBe(true);
    expect(deliveryRedactionMapAvailable("delivery-32")).toBe(true);
  });
});
