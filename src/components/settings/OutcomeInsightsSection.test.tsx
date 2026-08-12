import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { defaultSettings } from "@/store/notesStore";
import type { OutcomeMetrics } from "@/lib/outcomeIntelligence";
import {
  OutcomeInsightsSection,
  OutcomeMetricsDetails,
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
  it("首页只给三项易懂摘要，详细数据仍区分实测与估算", () => {
    const html = renderToStaticMarkup(
      <OutcomeMetricsSummary metrics={metrics()} rangeLabel="近 30 天" />
    );

    expect(html).toContain("发送完成");
    expect(html).toContain("共 3 次尝试");
    expect(html).toContain("成功率");
    expect(html).toContain("已保护敏感内容");
    expect(html).toContain("累计约节省 4.0 分钟");
    expect(html).toContain("近 30 天");
    expect(html).toContain("aria-label=\"使用摘要\"");
    expect(html).not.toContain("重试次数");
    expect(html).not.toContain("role=\"img\"");
    expect(html).not.toContain("卡片正文");

    const details = renderToStaticMarkup(<OutcomeMetricsDetails metrics={metrics()} />);
    expect(details).toContain("完整流程（中位）");
    expect(details).toContain("估算累计节省");
    expect(details).toContain("估算 · 2 个传统用时样本");
    expect(details).toContain("样本少于 5 次，不给出趋势结论");
    expect(details).toContain("aria-label=\"详细使用数据\"");
    expect(details).toContain("role=\"img\"");

    const withoutBaseline = renderToStaticMarkup(<OutcomeMetricsDetails metrics={metrics({
        estimatedTimeSavedMs: null,
        estimatedSampleSize: 0,
      })} />);
    expect(withoutBaseline).not.toContain("估算累计节省");
    expect(withoutBaseline).toContain("节省时间估算");
    expect(withoutBaseline).toContain("未设置");

    const oneDay = renderToStaticMarkup(
      <OutcomeMetricsDetails metrics={metrics({
        sampleSize: 5,
        insufficientSample: false,
        trendConclusion: null,
      })} />
    );
    expect(oneDay).toContain("至少需要 2 个有发送的日期");
    expect(oneDay).not.toContain("前后两段成功发送数量持平");
  });

  it("无数据时给出行动说明，不渲染一整屏零值", () => {
    const empty = metrics({
      deliveryAttempts: 0,
      sentCount: 0,
      successRate: null,
      firewallFindingCount: 0,
      redactionCount: 0,
      estimatedTimeSavedMs: null,
      estimatedSampleSize: 0,
      sampleSize: 0,
      dailyTrend: [],
    });
    const firstUse = renderToStaticMarkup(
      <OutcomeMetricsSummary metrics={empty} hasActivity={false} />
    );
    expect(firstUse).toContain("还没有可统计的发送");
    expect(firstUse).toContain("完成一次发送后");
    expect(firstUse).toContain("发送第一条内容试试");
    expect(firstUse).not.toContain("发送完成");

    const filtered = renderToStaticMarkup(
      <OutcomeMetricsSummary metrics={empty} hasActivity />
    );
    expect(filtered).toContain("当前筛选没有数据");
    expect(filtered).toContain("换一个时间范围");
    // 没传 onClearFilters 时不渲染按钮
    expect(filtered).not.toContain("清除筛选");

    const filteredWithClear = renderToStaticMarkup(
      <OutcomeMetricsSummary metrics={empty} hasActivity onClearFilters={vi.fn()} />
    );
    expect(filteredWithClear).toContain("清除筛选");

    // 零记录场景「清除筛选」没有意义，防止条件写反
    const neverUsed = renderToStaticMarkup(
      <OutcomeMetricsSummary metrics={empty} hasActivity={false} onClearFilters={vi.fn()} />
    );
    expect(neverUsed).not.toContain("清除筛选");
  });

  it("设置页优先展示使用概览，高级工具和隐私控制默认折叠", () => {
    const settings = { ...defaultSettings(), outcomeMetricsEnabled: false };
    const html = renderToStaticMarkup(
      <OutcomeInsightsSection settings={settings} patch={vi.fn()} />
    );

    expect(html).toContain("使用概览");
    expect(html).not.toContain("成效与隐私");
    expect(html).toContain("开始使用 Toskr");
    expect(html).toContain("安全发送入门");
    expect(html).toContain("体验安全发送");
    expect(html).toContain("恢复脱敏结果");
    expect(html).toContain("aria-label=\"本机使用统计\"");
    expect(html).toContain("aria-label=\"统计保留时间\"");
    expect(html).toContain("高级工具");
    expect(html).toContain("数据与隐私");
    expect(html).toContain("清除统计");
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).not.toContain("<details open");
    expect(html).toContain("开始计时");
    expect(html).toContain("disabled");
    // 统计开关已下沉进「数据与隐私」折叠区（details 收起时内容仍在 DOM）
    expect(html.indexOf("数据与隐私")).toBeLessThan(
      html.indexOf('aria-label="本机使用统计"')
    );
  });
});
