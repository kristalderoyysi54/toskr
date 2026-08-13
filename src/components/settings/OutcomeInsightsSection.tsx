import { emitTo, listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Play,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { SimpleSelect } from "@/components/SimpleSelect";
import { SafeDeliveryLearningPath } from "@/components/settings/SafeDeliveryLearningPath";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { TRANSFORM_RECIPES, type TransformRecipeId } from "@/lib/aiTransform";
import {
  DELIVERY_ACTIVITY_CLEARED_EVENT,
  DELIVERY_ACTIVITY_MAX_EVENTS,
  deliveryActivityRecords,
  getRecentDeliveryEvents,
  type DeliveryEvent,
} from "@/lib/deliveryActivity";
import {
  aggregateOutcomeMetrics,
  cancelProblemSession,
  linkProblemSession,
  normalizeOutcomeBaselines,
  solveProblemSession,
  startProblemSession,
  type OutcomeMetrics,
  type OutcomeRange,
} from "@/lib/outcomeIntelligence";
import { onboardingAfter } from "@/lib/onboarding";
import { SETTINGS_START_SAFE_REHEARSAL } from "@/lib/settingsSync";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { useDataOperationStore } from "@/store/dataOperationStore";
import type { Settings } from "@/store/notesStore";

type Props = {
  settings: Settings;
  patch: (patch: Partial<Settings>) => void;
};

const RANGE_OPTIONS = [
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "all", label: "全部保留期" },
] satisfies { value: OutcomeRange; label: string }[];

const REASON_LABEL: Record<string, string> = {
  "target-not-ready": "目标不可用",
  "draft-target-changed": "目标已变化",
  target_exited: "目标已退出",
  paste_failed: "粘贴失败",
  enter_failed: "回车失败",
  restored: "完整恢复",
  restoredPartial: "部分恢复",
  skippedUserChanged: "保留用户新复制内容",
  nothingToRestore: "无需恢复",
  restoreFailed: "恢复失败",
  notOwned: "剪贴板所有权已变化",
};

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (Math.abs(value) < 60_000) return `${Math.round(value / 1_000)} 秒`;
  const minutes = value / 60_000;
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} 分钟`;
}

function MetricCard({ label, value, hint }: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-card px-3 py-2.5">
      <p className="text-label text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-heading font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-micro text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Distribution({ title, values }: {
  title: string;
  values: Record<string, number>;
}) {
  const entries = Object.entries(values).filter(([, count]) => count > 0);
  if (!entries.length) return null;
  return (
    <div className="rounded-xl border border-border/60 bg-card px-3 py-2.5">
      <p className="text-body font-medium">{title}</p>
      <ul className="mt-1.5 space-y-1 text-label text-muted-foreground">
        {entries.map(([key, count]) => (
          <li key={key} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate" title={key}>{REASON_LABEL[key] ?? key}</span>
            <span className="tabular-nums text-foreground">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PrimaryMetric({ label, value, hint }: {
  label: string;
  value: string | number;
  hint: string;
}) {
  return (
    <div className="min-w-0 px-3 py-3">
      <p className="text-label text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-heading font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 truncate text-micro text-muted-foreground" title={hint}>{hint}</p>
    </div>
  );
}

export function OutcomeMetricsSummary({
  metrics,
  hasActivity = true,
  rangeLabel = "所选时间",
  onClearFilters,
}: {
  metrics: OutcomeMetrics;
  hasActivity?: boolean;
  rangeLabel?: string;
  /** 有记录但当前筛选为空时的一键复位（筛选器藏在折叠区里，空态必须给出口）。 */
  onClearFilters?: () => void;
}) {
  if (!metrics.deliveryAttempts) {
    return (
      <section
        aria-label="使用摘要"
        className="rounded-xl border border-border/60 bg-card px-4 py-5"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Send aria-hidden className="size-4" />
          </span>
          <div>
            <h3 className="text-title font-medium">
              {hasActivity ? "当前筛选没有数据" : "还没有可统计的发送"}
            </h3>
            <p className="mt-1 max-w-xl text-body leading-relaxed text-muted-foreground">
              {hasActivity
                ? "换一个时间范围或清除详细筛选后再看。"
                : "完成一次发送后，这里会显示成功率、用时和敏感内容保护情况。"}
            </p>
            {!hasActivity && (
              <p className="mt-2 text-label text-muted-foreground">
                发送第一条内容试试：双击 ⇧ 捕获选中文本，勾选后 ⌘⏎ 发送。
              </p>
            )}
            {hasActivity && onClearFilters && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={onClearFilters}
              >
                清除筛选
              </Button>
            )}
          </div>
        </div>
      </section>
    );
  }

  const unresolved = Math.max(0, metrics.deliveryAttempts - metrics.sentCount);
  const estimate = metrics.estimatedTimeSavedMs === null
    ? null
    : formatDuration(metrics.estimatedTimeSavedMs);
  const summaryNote = estimate
    ? `按你设置的传统用时，累计约节省 ${estimate}。`
    : metrics.actualWorkflowMedianMs !== null
      ? `一次完整流程通常用时 ${formatDuration(metrics.actualWorkflowMedianMs)}。在高级工具中填写传统用时后，可查看节省时间估算。`
      : metrics.insufficientSample
        ? "继续完成几次发送，累计 5 次后会开始显示趋势。"
        : "在高级工具中填写传统用时后，可查看节省时间估算。";

  return (
    <section aria-label="使用摘要" className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2.5">
        <div>
          <h3 className="text-title font-medium">这段时间</h3>
          <p className="mt-0.5 text-micro text-muted-foreground">{rangeLabel}</p>
        </div>
        <span className="text-label text-muted-foreground">共 {metrics.deliveryAttempts} 次尝试</span>
      </div>
      <div className="grid grid-cols-3 divide-x divide-border/50">
        <PrimaryMetric
          label="发送完成"
          value={metrics.sentCount}
          hint={unresolved ? `受阻或失败 ${unresolved} 次` : "全部完成"}
        />
        <PrimaryMetric
          label="成功率"
          value={formatPercent(metrics.successRate)}
          hint={metrics.insufficientSample ? "样本仍较少" : "按当前筛选计算"}
        />
        <PrimaryMetric
          label="已保护敏感内容"
          value={metrics.redactionCount}
          hint={metrics.firewallFindingCount
            ? `共发现 ${metrics.firewallFindingCount} 项`
            : "未发现需替换内容"}
        />
      </div>
      <p className="border-t border-border/50 bg-muted/30 px-3 py-2 text-label text-muted-foreground" role="status">
        {summaryNote}
      </p>
    </section>
  );
}

export function OutcomeMetricsDetails({ metrics }: { metrics: OutcomeMetrics }) {
  const maxAttempts = Math.max(1, ...metrics.dailyTrend.map((item) => item.attempts));
  const distributions = [
    { title: "阻止原因", values: metrics.blockedReasons },
    { title: "失败原因", values: metrics.failedReasons },
    { title: "剪贴板结果", values: metrics.clipboardOutcomes },
  ].filter((item) => Object.values(item.values).some((count) => count > 0));

  return (
    <div aria-label="详细使用数据" className="space-y-3">
      <section aria-labelledby="outcome-process-title">
        <h4 id="outcome-process-title" className="mb-1.5 text-label font-medium text-muted-foreground">发送过程</h4>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <MetricCard label="发送尝试" value={metrics.deliveryAttempts} />
          <MetricCard label="重试次数" value={metrics.retryCount} />
          <MetricCard label="目标变化阻止" value={metrics.targetInvalidationBlocks} />
          <MetricCard
            label="结果核验"
            value={metrics.verificationStatuses.pass + metrics.verificationStatuses.needsReview + metrics.verificationStatuses.blocked}
            hint={`通过 ${metrics.verificationStatuses.pass} · 复核 ${metrics.verificationStatuses.needsReview} · 阻止 ${metrics.verificationStatuses.blocked}`}
          />
        </div>
      </section>

      <section aria-labelledby="outcome-time-title">
        <h4 id="outcome-time-title" className="mb-1.5 text-label font-medium text-muted-foreground">用时</h4>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <MetricCard label="准备到发送（中位）" value={formatDuration(metrics.draftToSendMedianMs)} />
          <MetricCard label="发送到回收（中位）" value={formatDuration(metrics.sendToResultMedianMs)} />
          <MetricCard label="完整流程（中位）" value={formatDuration(metrics.actualWorkflowMedianMs)} />
          {metrics.estimatedTimeSavedMs === null ? (
            <MetricCard label="节省时间估算" value="未设置" hint="可在高级工具中填写传统用时" />
          ) : (
            <MetricCard
              label="估算累计节省"
              value={formatDuration(metrics.estimatedTimeSavedMs)}
              hint={`估算 · ${metrics.estimatedSampleSize} 个传统用时样本`}
            />
          )}
        </div>
      </section>

      <section aria-labelledby="outcome-safety-title">
        <h4 id="outcome-safety-title" className="mb-1.5 text-label font-medium text-muted-foreground">隐私与结果</h4>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          <MetricCard label="发现敏感内容" value={metrics.firewallFindingCount} />
          <MetricCard label="已保护敏感内容" value={metrics.redactionCount} />
          <MetricCard label="问题解决用时（中位）" value={formatDuration(metrics.problemResolutionMedianMs)} hint="仅包含主动计时" />
        </div>
      </section>

      {!!distributions.length && (
        <section aria-labelledby="outcome-reasons-title">
          <h4 id="outcome-reasons-title" className="mb-1.5 text-label font-medium text-muted-foreground">原因与结果</h4>
          <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
            {distributions.map((item) => (
              <Distribution key={item.title} title={item.title} values={item.values} />
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-border/60 bg-card px-3 py-2.5" aria-labelledby="outcome-daily-title">
        <div className="flex items-center justify-between gap-2">
          <h4 id="outcome-daily-title" className="text-body font-medium">每日发送</h4>
          <span className="text-micro text-muted-foreground">样本 {metrics.sampleSize}</span>
        </div>
        {metrics.dailyTrend.length ? (
          <div
            className="mt-2 flex h-20 items-end gap-1"
            role="img"
            aria-label={`每日发送柱状图，共 ${metrics.dailyTrend.length} 天`}
          >
            {metrics.dailyTrend.map((item) => (
              <div
                key={item.day}
                className="group flex min-w-0 flex-1 flex-col items-center justify-end"
                title={`${item.day}：尝试 ${item.attempts}，成功 ${item.sent}`}
              >
                <div
                  className="w-full max-w-5 rounded-t-sm bg-primary/25"
                  style={{ height: `${Math.max(4, item.attempts / maxAttempts * 64)}px` }}
                >
                  <div
                    className="w-full rounded-t-sm bg-primary"
                    style={{ height: `${item.attempts ? item.sent / item.attempts * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-5 text-center text-label text-muted-foreground">暂无样本</p>
        )}
        <p className="mt-1 text-micro text-muted-foreground" role="status">
          {metrics.insufficientSample
            ? "样本少于 5 次，不给出趋势结论。"
            : metrics.trendConclusion === null
              ? "至少需要 2 个有发送的日期才给出趋势结论。"
              : metrics.trendConclusion === "up"
                ? "后半段成功发送数量上升。"
                : metrics.trendConclusion === "down"
                  ? "后半段成功发送数量下降。"
                  : "前后两段成功发送数量持平。"}
        </p>
      </section>
    </div>
  );
}

function ProgressiveSection({ title, description, children }: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <details className="group mt-3 overflow-hidden rounded-xl border border-border/60 bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-title font-medium">{title}</span>
          <span className="mt-0.5 block text-label text-muted-foreground">{description}</span>
        </span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-100 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="border-t border-border/50 p-3">{children}</div>
    </details>
  );
}

function nextSessionId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `problem-${Date.now().toString(36)}`;
}

export function OutcomeInsightsSection({ settings, patch }: Props) {
  const dataLocked = useDataOperationStore((state) => state.locked);
  const [events, setEvents] = useState<DeliveryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<OutcomeRange>("30d");
  const [profileId, setProfileId] = useState("all");
  const [recipeId, setRecipeId] = useState("all");
  const [baselineScope, setBaselineScope] = useState(
    settings.targetProfiles[0] ? `profile:${settings.targetProfiles[0].id}` : "recipe:summarize"
  );
  const [baselineMinutes, setBaselineMinutes] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEvents(await getRecentDeliveryEvents(
        DELIVERY_ACTIVITY_MAX_EVENTS,
        settings.outcomeRetentionDays
      ));
    } catch {
      setError("使用记录读取失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, [settings.outcomeRetentionDays]);

  useEffect(() => {
    if (dataLocked) return;
    void load();
    const clearListener = listen(DELIVERY_ACTIVITY_CLEARED_EVENT, () => setEvents([]));
    return () => { void clearListener.then((stop) => stop()); };
  }, [dataLocked, load]);

  const metrics = useMemo(() => aggregateOutcomeMetrics(
    events,
    settings.outcomeProblemSessions,
    settings.outcomeBaselines,
    {
      range,
      nowMs: Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      profileId: profileId === "all" ? null : profileId,
      recipeId: recipeId === "all" ? null : recipeId as TransformRecipeId,
      metricsEpoch: settings.outcomeMetricsEpoch,
    }
  ), [
    events,
    profileId,
    range,
    recipeId,
    settings.outcomeBaselines,
    settings.outcomeMetricsEpoch,
    settings.outcomeProblemSessions,
  ]);

  const records = useMemo(
    () => deliveryActivityRecords(events.filter((event) =>
      event.metricsEligible !== false &&
      (event.metricsEpoch ?? 0) === settings.outcomeMetricsEpoch
    )).filter((event) => event.status === "sent"),
    [events, settings.outcomeMetricsEpoch]
  );
  const activeSession = [...settings.outcomeProblemSessions]
    .reverse()
    .find((session) => session.solvedAtMs === null && session.cancelledAtMs === null) ?? null;
  const activeRecord = activeSession?.deliveryId
    ? records.find((record) => record.deliveryId === activeSession.deliveryId) ?? null
    : null;

  const addBaseline = () => {
    const minutes = Number(baselineMinutes);
    const separator = baselineScope.indexOf(":");
    const scope = baselineScope.slice(0, separator);
    const scopeId = baselineScope.slice(separator + 1);
    const validScope = scope === "profile"
      ? settings.targetProfiles.some((profile) => profile.id === scopeId)
      : scope === "recipe" && TRANSFORM_RECIPES.some((recipe) => recipe.id === scopeId);
    if (!validScope || !Number.isFinite(minutes) || minutes <= 0 || minutes > 10_080) {
      tip("warn", "请输入大于 0 的传统流程分钟数");
      return;
    }
    const next = normalizeOutcomeBaselines([
      ...settings.outcomeBaselines,
      { scope: scope as "profile" | "recipe", scopeId, minutes },
    ]);
    patch({ outcomeBaselines: next });
    setBaselineMinutes("");
  };

  const clearMetrics = async () => {
    const confirmed = await ask(
      "清除使用统计和问题计时？最近发送记录、卡片、任务、附件及传统用时设置不会改变。",
      { title: "清除使用统计", kind: "warning" }
    );
    if (!confirmed) return;
    if (settings.outcomeMetricsEpoch >= Number.MAX_SAFE_INTEGER) {
      tip("warn", "使用统计已达到安全上限，请先导出诊断后联系支持");
      return;
    }
    patch({
      outcomeMetricsEpoch: settings.outcomeMetricsEpoch + 1,
      outcomeProblemSessions: [],
    });
    tip("ok", "使用统计已清除；最近发送记录仍保留");
  };

  const baselineOptions = [
    ...settings.targetProfiles.map((profile) => ({
      value: `profile:${profile.id}`,
      label: `发送方案 · ${profile.name}`,
    })),
    ...TRANSFORM_RECIPES.map((recipe) => ({
      value: `recipe:${recipe.id}`,
      label: `AI 处理 · ${recipe.label}`,
    })),
  ];

  return (
    <div>
      <div className="mb-1 flex items-start justify-between gap-3">
        <h2 className="text-heading font-semibold">使用概览</h2>
        <Button type="button" size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin motion-reduce:animate-none")} />
          刷新
        </Button>
      </div>

      <SafeDeliveryLearningPath
        onboarding={settings.onboarding}
        onRunRehearsal={(mode) => {
          void emitTo("main", SETTINGS_START_SAFE_REHEARSAL, { mode });
        }}
        onCompleteRecoveryTutorial={() => patch({
          onboarding: onboardingAfter(
            settings.onboarding,
            { type: "recoveryTutorialCompleted" }
          ),
        })}
      />

      {error && !events.length ? (
        <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-4">
          <div className="flex items-start gap-3">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <h3 className="text-title font-medium">暂时读不到使用记录</h3>
              <p className="mt-1 text-body text-muted-foreground">
                这不会影响发送和最近发送记录。可以稍后再试，或现在重新读取。
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
              再试一次
            </Button>
          </div>
          <span className="sr-only">{error}</span>
        </div>
      ) : (
        <>
          {error && (
            <div role="status" className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-warning/10 px-3 py-2 text-body text-warning">
              <span>本次刷新失败，下面仍显示上次读取的结果。</span>
              <Button type="button" size="xs" variant="ghost" onClick={() => void load()} disabled={loading}>再试一次</Button>
            </div>
          )}
          {loading && !events.length ? (
            <p role="status" className="rounded-xl border border-border/60 bg-card py-10 text-center text-body text-muted-foreground">
              正在读取使用记录…
            </p>
          ) : (
            <>
              {!!events.length && (
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-label text-muted-foreground">查看范围</p>
                  <Segmented ariaLabel="使用概览范围" value={range} options={RANGE_OPTIONS} onChange={setRange} />
                </div>
              )}
              <OutcomeMetricsSummary
                metrics={metrics}
                hasActivity={!!events.length}
                rangeLabel={RANGE_OPTIONS.find((option) => option.value === range)?.label}
                onClearFilters={() => {
                  setProfileId("all");
                  setRecipeId("all");
                  // 「清除」要真的放宽到最大范围；回默认 30 天可能仍然为空
                  setRange("all");
                }}
              />
              {!!events.length && (
                <ProgressiveSection
                  title="趋势和详细数据"
                  description="查看发送原因、用时、结果和每日变化"
                >
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <SimpleSelect
                      ariaLabel="按发送方案筛选"
                      className="w-40"
                      value={profileId}
                      options={[
                        { value: "all", label: "全部发送方案" },
                        ...settings.targetProfiles.map((profile) => ({ value: profile.id, label: profile.name })),
                      ]}
                      onChange={setProfileId}
                    />
                    <SimpleSelect
                      ariaLabel="按 AI 处理筛选"
                      className="w-36"
                      value={recipeId}
                      options={[
                        { value: "all", label: "全部 AI 处理" },
                        ...TRANSFORM_RECIPES.map((recipe) => ({ value: recipe.id, label: recipe.label })),
                      ]}
                      onChange={setRecipeId}
                    />
                  </div>
                  <OutcomeMetricsDetails metrics={metrics} />
                </ProgressiveSection>
              )}
            </>
          )}
        </>
      )}

      <ProgressiveSection
        title="高级工具"
        description="估算节省时间，或记录一次完整的问题处理用时"
      >
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-xl border border-border/60 bg-card p-3" aria-labelledby="outcome-baseline-title">
          <div className="flex items-start gap-2">
            <Clock3 className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
            <div>
              <h3 id="outcome-baseline-title" className="text-title font-medium">传统用时（可选）</h3>
              <p className="mt-0.5 text-label text-muted-foreground">填写不用 Toskr 时完成同类工作的分钟数，用来估算节省时间。</p>
            </div>
          </div>
          <div className="mt-2 flex gap-2">
            <SimpleSelect ariaLabel="传统用时适用范围" className="min-w-0 flex-1" value={baselineScope} options={baselineOptions} onChange={setBaselineScope} />
            <input
              type="number"
              min={0.1}
              max={10_080}
              step={0.5}
              aria-label="传统流程分钟数"
              value={baselineMinutes}
              onChange={(event) => setBaselineMinutes(event.target.value)}
              placeholder="分钟"
              className="h-8 w-24 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            />
            <Button type="button" size="sm" onClick={addBaseline}>保存</Button>
          </div>
          <ul className="mt-2 space-y-1">
            {settings.outcomeBaselines.map((baseline) => {
              const key = `${baseline.scope}:${baseline.scopeId}`;
              const label = baselineOptions.find((option) => option.value === key)?.label ?? baseline.scopeId;
              return (
                <li key={key} className="flex items-center gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-label">
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className="tabular-nums">{baseline.minutes} 分钟</span>
                  <button
                    type="button"
                    aria-label={`删除传统用时 ${label}`}
                    onClick={() => patch({ outcomeBaselines: settings.outcomeBaselines.filter((item) => `${item.scope}:${item.scopeId}` !== key) })}
                    className="rounded-sm p-0.5 text-muted-foreground hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  ><X className="size-3.5" /></button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="rounded-xl border border-border/60 bg-card p-3" aria-labelledby="problem-session-title">
          <div className="flex items-start gap-2">
            <Play className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <h3 id="problem-session-title" className="text-title font-medium">完整问题用时（可选）</h3>
              <p className="mt-0.5 text-label text-muted-foreground">从开始处理到解决，只记录时间和关联发送，不记录问题内容。</p>
            </div>
          </div>
          {!activeSession ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-3"
              disabled={!settings.outcomeMetricsEnabled}
              onClick={() => patch({
                outcomeProblemSessions: startProblemSession(
                  settings.outcomeProblemSessions,
                  { id: nextSessionId(), startedAtMs: Date.now() }
                ),
              })}
            >
              <Play className="size-3.5" /> 开始计时
            </Button>
          ) : (
            <div className="mt-3 space-y-2">
              <p className="text-label text-muted-foreground">
                开始于 {new Date(activeSession.startedAtMs).toLocaleString("zh-CN", { hour12: false })}
              </p>
              <SimpleSelect
                ariaLabel="关联问题会话到最近发送"
                value={activeSession.deliveryId ?? "none"}
                options={[
                  { value: "none", label: "尚未关联发送" },
                  ...records.map((record) => ({
                    value: record.deliveryId,
                    label: `${record.targetAppName || record.targetBundleId || "未识别目标"} · ${new Date(record.timestampMs).toLocaleString("zh-CN", { hour12: false })}`,
                  })),
                ]}
                onChange={(deliveryId) => {
                  if (deliveryId === "none") return;
                  patch({ outcomeProblemSessions: linkProblemSession(
                    settings.outcomeProblemSessions,
                    activeSession.id,
                    deliveryId,
                    Date.now(),
                    records.find((record) => record.deliveryId === deliveryId)?.resultNoteId ?? null
                  ) });
                }}
              />
              {activeSession.deliveryId && (
                <div className="flex items-center justify-between gap-2 text-label text-muted-foreground">
                  <span>
                    {activeSession.resultNoteId
                      ? "已关联发送与结果"
                      : "已关联发送，结果尚未回收"}
                  </span>
                  {activeRecord?.resultNoteId && activeRecord.resultNoteId !== activeSession.resultNoteId && (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => patch({ outcomeProblemSessions: linkProblemSession(
                        settings.outcomeProblemSessions,
                        activeSession.id,
                        activeRecord.deliveryId,
                        Date.now(),
                        activeRecord.resultNoteId
                      ) })}
                    >同步结果关联</Button>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => patch({ outcomeProblemSessions: solveProblemSession(
                    settings.outcomeProblemSessions,
                    activeSession.id,
                    Date.now()
                  ) })}
                ><CheckCircle2 className="size-3.5" /> 标记解决</Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => patch({ outcomeProblemSessions: cancelProblemSession(
                    settings.outcomeProblemSessions,
                    activeSession.id,
                    Date.now()
                  ) })}
                ><X className="size-3.5" /> 取消计时</Button>
              </div>
            </div>
          )}
        </section>
      </div>
      </ProgressiveSection>

      <ProgressiveSection
        title="数据与隐私"
        description="设置保留时间，查看记录范围或清除统计"
      >
        <div className="divide-y divide-border/50 rounded-xl border border-border/60">
          <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
            <div className="min-w-0">
              <p className="text-title">本机使用统计</p>
              <p className="mt-0.5 text-label text-muted-foreground">
                {settings.outcomeMetricsEnabled ? "已开启" : "已暂停"} ·
                只记录次数、时间和状态，不保存卡片正文、Prompt 或密钥
              </p>
            </div>
            <Switch
              aria-label="本机使用统计"
              checked={settings.outcomeMetricsEnabled}
              onCheckedChange={(checked) => patch({
                outcomeMetricsEnabled: checked,
                ...(!checked && activeSession ? {
                  outcomeProblemSessions: cancelProblemSession(
                    settings.outcomeProblemSessions,
                    activeSession.id,
                    Date.now()
                  ),
                } : {}),
              })}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
            <div>
              <p className="text-title">统计保留时间</p>
              <p className="mt-0.5 text-label text-muted-foreground">最多保留 500 条，到期后自动清理。</p>
            </div>
            <SimpleSelect
              ariaLabel="统计保留时间"
              className="w-28"
              value={String(settings.outcomeRetentionDays)}
              options={[
                { value: "7", label: "7 天" },
                { value: "30", label: "30 天" },
                { value: "90", label: "90 天" },
              ]}
              onChange={(value) => patch({ outcomeRetentionDays: Number(value) as 7 | 30 | 90 })}
            />
          </div>
          <div className="px-3.5 py-2.5">
            <p className="text-title">会记录什么</p>
            <p className="mt-1 text-label leading-relaxed text-muted-foreground">
              只记录时间、目标应用、发送方案、状态、数量和处理结果。不会保存正文、Prompt、API Key、目标 token 或脱敏对应关系。
            </p>
          </div>
          <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
            <div className="min-w-0">
              <p className="text-title">清除使用统计</p>
              <p className="mt-0.5 text-label text-muted-foreground">不会删除卡片、任务、附件或最近发送记录。</p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => void clearMetrics()}>
              <Trash2 className="size-3.5" /> 清除统计
            </Button>
          </div>
        </div>
      </ProgressiveSection>
    </div>
  );
}
