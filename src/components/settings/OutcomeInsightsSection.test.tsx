import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { defaultSettings } from "@/store/notesStore";
import type { OutcomeMetrics } from "@/lib/outcomeIntelligence";
import {
  OutcomeInsightsSection,
  OutcomeMetricsSummary,
} from "./OutcomeInsightsSection";

function metrics(overrides: Partial<OutcomeMetrics> = {}): OutcomeMetrics {
  return {
    deliveryAttempts: 3,
    sentCount: 2,
    successRate: 2 / 3,
    blockedReasons: { "target-not-ready": 1 },
    failedReasons: {},
    targetInvalidationBlocks: 1,
    firewallFindingCount: 2,
    redactionCount: 1,
    clipboardOutcomes: { restored: 2 },
    draftToSendMedianMs: 2_000,
    sendToResultMedianMs: 60_000,
    actualWorkflowMedianMs: 120_000,
    retryCount: 1,
    verificationStatuses: { pass: 1, needsReview: 1, blocked: 0 },
    qualityFeedback: { directUse: 1, minorEdit: 1, majorEdit: 0, discarded: 0 },
    problemResolutionMedianMs: 180_000,
    estimatedTimeSavedMs: 240_000,
    estimatedSampleSize: 2,
    sampleSize: 3,
    insufficientSample: true,
    dailyTrend: [{ day: "2026-08-11", attempts: 3, sent: 2 }],
    trendConclusion: null,
    ...overrides,
  };
}

describe("OutcomeInsightsSection", () => {
  it("把实测与估算分开，并在小样本时不制造趋势结论", () => {
    const html = renderToStaticMarkup(<OutcomeMetricsSummary metrics={metrics()} />);

    expect(html).toContain("实测流程耗时（中位）");
    expect(html).toContain("估算累计节省");
    expect(html).toContain("估算 · 2 个有人工基线样本");
    expect(html).toContain("样本少于 5 次，不给出趋势结论");
    expect(html).toContain("aria-label=\"本机成效摘要\"");
    expect(html).toContain("role=\"img\"");
    expect(html).not.toContain("卡片正文");

    const withoutBaseline = renderToStaticMarkup(
      <OutcomeMetricsSummary metrics={metrics({
        estimatedTimeSavedMs: null,
        estimatedSampleSize: 0,
      })} />
    );
    expect(withoutBaseline).not.toContain("估算累计节省");
    expect(withoutBaseline).toContain("人工基线");
    expect(withoutBaseline).toContain("未设置");

    const oneDay = renderToStaticMarkup(
      <OutcomeMetricsSummary metrics={metrics({
        sampleSize: 5,
        insufficientSample: false,
        trendConclusion: null,
      })} />
    );
    expect(oneDay).toContain("至少需要 2 个有投递的日期");
    expect(oneDay).not.toContain("前后两段成功投递数量持平");
  });

  it("设置页提供可访问的范围、保留期、开关与清除控制，不新增主页面签", () => {
    const settings = { ...defaultSettings(), outcomeMetricsEnabled: false };
    const html = renderToStaticMarkup(
      <OutcomeInsightsSection settings={settings} patch={vi.fn()} />
    );

    expect(html).toContain("成效与隐私");
    expect(html).toContain("aria-label=\"本机成效度量\"");
    expect(html).toContain("aria-label=\"元数据保留期\"");
    expect(html).toContain("aria-label=\"成效统计范围\"");
    expect(html).toContain("清除成效历史");
    expect(html).toContain("成效度量已暂停");
    expect(html).toContain("开始计时");
    expect(html).toContain("disabled");
  });
});
