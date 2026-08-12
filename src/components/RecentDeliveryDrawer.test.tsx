import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RecentDeliveryList } from "./RecentDeliveryDrawer";
import {
  deliveryActivityRecords,
  deliveryEventSourceAvailability,
  deliverySourceItems,
  type DeliveryEvent,
} from "@/lib/deliveryActivity";
import type { Note } from "@/store/notesStore";

const counts: DeliveryEvent["firewallCounts"] = {
  privateKey: 0,
  authorization: 0,
  apiKey: 1,
  databaseUrl: 0,
  email: 1,
  phone: 0,
  nationalId: 0,
  bankCard: 0,
  ipAddress: 0,
  cookie: 0,
  session: 0,
};

function event(overrides: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    eventId: "failed-event",
    deliveryId: "delivery-1",
    eventType: "sendFailed",
    timestampMs: 100,
    sourceKind: "note",
    sourceItemIds: ["note-1"],
    targetBundleId: "com.openai.codex",
    targetAppName: "Codex",
    profileId: "safe",
    status: "failed",
    reasonCode: "paste_failed",
    durationMs: 20,
    textCharCount: 88,
    imageCount: 0,
    firewallCounts: counts,
    redactionCount: 2,
    clipboardOutcome: "restoreFailed",
    resultNoteId: null,
    ...overrides,
  };
}

describe("RecentDeliveryDrawer", () => {
  it("合并发送的查看入口保留全部来源及图片附件", () => {
    const notes: Note[] = [
      {
        id: "text-1",
        text: "问题背景",
        sectionId: "inbox",
        done: false,
        createdAt: 1,
      },
      {
        id: "image-1",
        text: "图片 1200×800",
        sectionId: "inbox",
        done: false,
        createdAt: 2,
        kind: "image",
        imageFile: "first.png",
      },
      {
        id: "image-2",
        text: "图片 900×600",
        sectionId: "inbox",
        done: false,
        createdAt: 3,
        kind: "image",
        imageFile: "second.png",
      },
    ];

    const sources = deliverySourceItems(event({
      sourceItemIds: notes.map((note) => note.id),
      imageCount: 2,
    }), notes, []);

    expect(sources.notes.map((note) => note.id)).toEqual([
      "text-1",
      "image-1",
      "image-2",
    ]);
  });

  it("把同一 delivery 的生命周期折叠为一条，并保留剪贴板结果", () => {
    const records = deliveryActivityRecords([
      event({
        eventId: "clipboard",
        eventType: "clipboardSkipped",
        status: "skipped",
        timestampMs: 110,
      }),
      event(),
      event({
        eventId: "start",
        eventType: "sendStarted",
        status: "started",
        timestampMs: 90,
        clipboardOutcome: null,
      }),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      eventType: "sendFailed",
      status: "failed",
      clipboardOutcome: "restoreFailed",
      timestampMs: 100,
      lastActivityAtMs: 110,
      resultLinkedAtMs: null,
      verificationAtMs: null,
    });
  });

  it("后续保存或检查回复不覆盖真实发送时间，也不会把旧发送顶到最前", () => {
    const records = deliveryActivityRecords([
      event({
        eventId: "old-sent",
        deliveryId: "old",
        eventType: "sendSent",
        status: "sent",
        timestampMs: 100,
      }),
      event({
        eventId: "old-verified",
        deliveryId: "old",
        eventType: "resultVerified",
        status: "verified",
        timestampMs: 300,
        resultNoteId: "result-old",
        verificationStatus: "needsReview",
      }),
      event({
        eventId: "new-sent",
        deliveryId: "new",
        eventType: "sendSent",
        status: "sent",
        timestampMs: 200,
      }),
    ]);

    expect(records.map((record) => record.deliveryId)).toEqual(["new", "old"]);
    expect(records[1]).toMatchObject({
      timestampMs: 100,
      lastActivityAtMs: 300,
      verificationAtMs: 300,
    });
  });

  it("来源存在性只按当前 ID 判断，缺失时禁用重新准备", () => {
    const current: Note = {
      id: "note-1",
      text: "当前正文不会进入活动组件",
      sectionId: "inbox",
      done: false,
      createdAt: 1,
    };
    expect(deliveryEventSourceAvailability(event(), [current], [])).toBe("available");
    expect(deliveryEventSourceAvailability(event(), [], [])).toBe("missing");

    const html = renderToStaticMarkup(
      <RecentDeliveryList
        records={deliveryActivityRecords([event()])}
        notes={[]}
        tasks={[]}
        busyEventId={null}
        onReprepare={vi.fn()}
      />
    );
    expect(html).toContain("Codex");
    expect(html).toContain("发送失败");
    expect(html).toContain("查看发送内容");
    expect(html).toContain("原内容已删除");
    expect(html).toContain("发送前隐藏了 2 项敏感内容");
    expect(html).toContain("更多信息");
    expect(html).toContain("重新准备");
    expect(html).toContain("disabled");
    expect(html).not.toContain("重试发送");
    // 摘要只来自传入的存活卡片；未传入的正文绝不出现
    expect(html).not.toContain("当前正文不会进入活动组件");
  });

  it("结果事件折叠到原发送，结果存在时提供来源与结果入口", () => {
    const records = deliveryActivityRecords([
      event({
        eventId: "verified",
        eventType: "resultVerified",
        status: "verified",
        timestampMs: 130,
        resultNoteId: "result-1",
        verificationStatus: "needsReview",
        verificationCheckCount: 7,
        verificationIssueCount: 2,
      }),
      event({
        eventId: "captured",
        eventType: "resultCaptured",
        status: "captured",
        timestampMs: 120,
        resultNoteId: "result-1",
      }),
      event({
        eventId: "verified-older",
        eventType: "resultVerified",
        status: "verified",
        timestampMs: 125,
        resultNoteId: "result-old",
        verificationStatus: "pass",
        verificationCheckCount: 1,
        verificationIssueCount: 0,
      }),
      event({
        eventId: "sent",
        eventType: "sendSent",
        status: "sent",
        timestampMs: 100,
        resultNoteId: null,
      }),
    ]);
    const result: Note = {
      id: "result-1",
      text: "结果正文不进入活动行",
      sectionId: "inbox",
      done: false,
      createdAt: 120,
      provenance: {
        kind: "deliveryResult",
        deliveryId: "delivery-1",
        capturedAtMs: 120,
        sourceBundle: "com.openai.codex",
        sourceItemIds: ["note-1"],
      },
    };
    const source: Note = {
      id: "note-1",
      text: "原始正文不进入活动行",
      sectionId: "inbox",
      done: false,
      createdAt: 80,
    };
    const derivedReport: Note = {
      ...result,
      id: "report-1",
      text: "派生报告正文也不进入活动行",
      title: "结果核验报告",
      createdAt: 140,
    };
    expect(records[0]).toMatchObject({
      status: "sent",
      timestampMs: 100,
      lastActivityAtMs: 130,
      resultLinkedAtMs: 120,
      verificationAtMs: 130,
      resultNoteId: "result-1",
      verificationStatus: "needsReview",
      verificationCheckCount: 7,
      verificationIssueCount: 2,
    });
    const html = renderToStaticMarkup(
      <RecentDeliveryList
        records={records}
        notes={[derivedReport, source, result]}
        tasks={[]}
        busyEventId={null}
        onReprepare={vi.fn()}
        onOpenSource={vi.fn()}
        onOpenResult={vi.fn()}
        onVerify={vi.fn()}
        onAssociate={vi.fn()}
        onUnlink={vi.fn()}
      />
    );
    expect(html).toContain("发送于");
    expect(html).toContain("已收到回复");
    expect(html).toContain("打开回复");
    expect(html).toContain("检查发现 2 个问题");
    expect(html).toContain("检查回复");
    expect(html).toContain("更换回复");
    expect(html).toContain("这不是对应回复");
    // 出站摘要来自存活来源卡（显示级重建，账本事件仍不存正文——见 resultReturn 白名单测试）
    expect(html).toContain("原始正文不进入活动行");
    // 回复与派生报告的正文不在抽屉渲染，只提供「打开回复」入口
    expect(html).not.toContain("结果正文不进入活动行");
    expect(html).not.toContain("派生报告正文也不进入活动行");
  });

  it("回复改绑后只展示当前关系，旧时间明确标为曾保存", () => {
    const records = deliveryActivityRecords([
      event({
        eventId: "captured",
        eventType: "resultCaptured",
        status: "captured",
        timestampMs: 120,
        resultNoteId: "result-1",
      }),
      event({
        eventId: "sent",
        eventType: "sendSent",
        status: "sent",
        timestampMs: 100,
      }),
    ]);
    const source: Note = {
      id: "note-1",
      text: "来源",
      sectionId: "inbox",
      done: false,
      createdAt: 80,
    };
    const reboundResult: Note = {
      id: "result-1",
      text: "已经改绑到另一条发送",
      sectionId: "inbox",
      done: false,
      createdAt: 120,
      provenance: {
        kind: "deliveryResult",
        deliveryId: "delivery-2",
        capturedAtMs: 120,
        sourceBundle: "com.openai.codex",
        sourceItemIds: ["note-2"],
      },
    };

    const html = renderToStaticMarkup(
      <RecentDeliveryList
        records={records}
        notes={[source, reboundResult]}
        tasks={[]}
        busyEventId={null}
        onReprepare={vi.fn()}
        onAssociate={vi.fn()}
      />
    );

    // 改绑后回到等待态：等待区组头给划词引导 + 卡脚手动选择兜底；历史痕迹只在更多明细里
    expect(html).toContain("等待回复");
    expect(html).toContain("自动带回");
    expect(html).toContain("手动选择");
    expect(html).toContain("曾保存，现已取消或更换");
    expect(html).toContain("曾保存回复");
    expect(html).not.toContain("已收到回复");
    expect(html).not.toContain("打开回复");
  });

  it("进行中的半次发送不进主列表，折叠为未发出的记录", () => {
    const html = renderToStaticMarkup(
      <RecentDeliveryList
        records={deliveryActivityRecords([
          event({
            eventId: "opened",
            deliveryId: "half",
            eventType: "preflightOpened",
            status: "opened",
            timestampMs: 200,
            clipboardOutcome: null,
          }),
          event({
            eventId: "sent-ok",
            deliveryId: "done",
            eventType: "sendSent",
            status: "sent",
            timestampMs: 100,
          }),
        ])}
        notes={[]}
        tasks={[]}
        busyEventId={null}
        onReprepare={vi.fn()}
      />
    );
    expect(html).toContain("未发出的记录 1 条");
    expect(html).toContain("预检未完成");
    expect(html).toContain("等待回复");
    // 主列表行不出现「下一步」以外的占位噪音；未发出行只有一行式条目
    expect(html).not.toContain("发送成功后才能保存");
  });
});
