import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ResultLinkChoices } from "./ResultLinkDialog";
import type { DeliveryEvent } from "@/lib/deliveryActivityCore";
import { retainExplicitResultSelection } from "@/lib/resultReturn";
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
  text: "这是接口排查回复",
  sectionId: "inbox",
  done: false,
  createdAt: 2_000,
  sourceApp: "Chat",
  sourceBundle: "com.openai.chat",
} satisfies Note;

const sourceNotes: Note[] = [
  {
    id: "source-1",
    text: "请帮我分析登录接口失败原因",
    sectionId: "inbox",
    done: false,
    createdAt: 500,
  },
  {
    id: "source-2",
    kind: "image",
    text: "图片 320×180",
    imageFile: "debug.png",
    imageW: 320,
    imageH: 180,
    sectionId: "inbox",
    done: false,
    createdAt: 600,
  },
];

describe("ResultLinkDialog", () => {
  it("发送候选显示当前本地来源摘要，帮助区分短时间内的多次发送", () => {
    const html = renderToStaticMarkup(
      <ResultLinkChoices
        mode="delivery"
        deliveries={[event, { ...event, eventId: "event-2", deliveryId: "delivery-2", timestampMs: 900 }]}
        notes={[]}
        sourceNotes={sourceNotes}
        selectedId={null}
        onSelect={vi.fn()}
      />
    );
    expect(html).toContain("Chat");
    expect(html).toContain("发送内容：请帮我分析登录接口失败原因，另有 1 项");
    expect(html).toContain("42 字文字 · 1 张图片");
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("text-title");
    expect(html).not.toContain("text-micro");
  });

  it("回复候选展示本地摘要且无候选时直接说明下一步", () => {
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
    expect(list).toContain("这是接口排查回复");
    expect(list).toContain("回复候选 · 8 字");
    expect(list).toContain("text-title");
    expect(list).not.toContain("text-micro");

    const empty = renderToStaticMarkup(
      <ResultLinkChoices mode="delivery" deliveries={[]} notes={[]} selectedId={null} onSelect={vi.fn()} />
    );
    expect(empty).toContain("找不到可对应的发送记录");
  });

  it("候选变化只保留用户明确点选，不自动选择第一项", () => {
    expect(retainExplicitResultSelection(null, ["first"])).toBeNull();
    expect(retainExplicitResultSelection("missing", ["first"])).toBeNull();
    expect(retainExplicitResultSelection("first", ["first", "second"])).toBe("first");
  });
});
