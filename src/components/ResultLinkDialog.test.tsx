import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ResultLinkChoices } from "./ResultLinkDialog";
import type { DeliveryEvent } from "@/lib/deliveryActivityCore";
import type { Note } from "@/store/notesStore";

const event = {
  eventId: "event-1",
  deliveryId: "delivery-1",
  eventType: "sendSent",
  timestampMs: 1_000,
  sourceKind: "note",
  sourceItemIds: ["source-1", "source-2"],
  targetBundleId: "com.openai.chat",
  targetAppName: "Chat",
  profileId: "safe",
  status: "sent",
  reasonCode: null,
  durationMs: 10,
  textCharCount: 42,
  imageCount: 1,
  firewallCounts: {
    privateKey: 0, authorization: 0, apiKey: 0, databaseUrl: 0, email: 0,
    phone: 0, nationalId: 0, bankCard: 0, ipAddress: 0, cookie: 0, session: 0,
  },
  redactionCount: 0,
  clipboardOutcome: "restored",
  resultNoteId: null,
} satisfies DeliveryEvent;

const note = {
  id: "result-1",
  text: "answer secret body",
  sectionId: "inbox",
  done: false,
  createdAt: 2_000,
  sourceApp: "Chat",
  sourceBundle: "com.openai.chat",
} satisfies Note;

describe("ResultLinkDialog", () => {
  it("投递候选只显示时间、目标和来源计数，不显示正文", () => {
    const html = renderToStaticMarkup(
      <ResultLinkChoices
        mode="delivery"
        deliveries={[event, { ...event, eventId: "event-2", deliveryId: "delivery-2", timestampMs: 900 }]}
        notes={[]}
        selectedId="delivery-1"
        onSelect={vi.fn()}
      />
    );
    expect(html).toContain("Chat");
    expect(html).toContain("来源 2 项");
    expect(html).toContain("42 字符 · 1 图");
    expect(html).not.toContain("secret");
  });

  it("现有卡片候选不展示结果正文，无候选有明确状态", () => {
    const list = renderToStaticMarkup(
      <ResultLinkChoices
        mode="note"
        deliveries={[]}
        notes={[note]}
        selectedId="result-1"
        onSelect={vi.fn()}
      />
    );
    expect(list).toContain("Chat");
    expect(list).toContain("18 字符");
    expect(list).not.toContain("answer secret body");

    const empty = renderToStaticMarkup(
      <ResultLinkChoices mode="delivery" deliveries={[]} notes={[]} selectedId={null} onSelect={vi.fn()} />
    );
    expect(empty).toContain("没有符合条件的最近投递");
  });
});
