import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RecentDeliveryList } from "./RecentDeliveryDrawer";
import {
  deliveryActivityRecords,
  deliveryEventSourceAvailability,
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
        records={[event()]}
        notes={[]}
        tasks={[]}
        busyEventId={null}
        onReprepare={vi.fn()}
      />
    );
    expect(html).toContain("Codex");
    expect(html).toContain("发送失败");
    expect(html).toContain("已脱敏 2 项");
    expect(html).toContain("来源已不存在");
    expect(html).toContain("重新准备");
    expect(html).toContain("disabled");
    expect(html).not.toContain("重试发送");
    expect(html).not.toContain("当前正文不会进入活动组件");
  });

  it("结果事件折叠到原投递，结果存在时提供来源与结果入口", () => {
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
        qualityFeedback={[{
          deliveryId: "delivery-1",
          resultNoteId: "result-1",
          quality: "minorEdit",
          updatedAtMs: 140,
        }]}
        qualityMetricsEpoch={0}
        onQuality={vi.fn()}
      />
    );
    expect(html).toContain("打开来源");
    expect(html).toContain("打开结果");
    expect(html).not.toContain("打开结果 ×2");
    expect(html).toContain("核验结果");
    expect(html).toContain("核验 7 项 · 问题 2");
    expect(html).toContain("关联现有卡片");
    expect(html).toContain("结果质量（可选）");
    expect(html).toContain("直接使用");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).not.toContain("结果正文不进入活动行");
    expect(html).not.toContain("原始正文不进入活动行");
    expect(html).not.toContain("派生报告正文也不进入活动行");

    const afterMetricsClear = renderToStaticMarkup(
      <RecentDeliveryList
        records={records}
        notes={[source, result]}
        tasks={[]}
        busyEventId={null}
        onReprepare={vi.fn()}
        qualityMetricsEpoch={1}
        onQuality={vi.fn()}
      />
    );
    expect(afterMetricsClear).not.toContain("结果质量（可选）");
  });
});
