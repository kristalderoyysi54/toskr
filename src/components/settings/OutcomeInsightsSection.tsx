import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  Clock3,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SimpleSelect } from "@/components/SimpleSelect";
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
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
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
  directUse: "直接使用",
  minorEdit: "小改后使用",
  majorEdit: "大改后使用",
  discarded: "未采用",
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
  return (
    <div className="rounded-xl border border-border/60 bg-card px-3 py-2.5">
      <p className="text-body font-medium">{title}</p>
      {entries.length ? (
        <ul className="mt-1.5 space-y-1 text-label text-muted-foreground">
          {entries.map(([key, count]) => (
            <li key={key} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate" title={key}>{REASON_LABEL[key] ?? key}</span>
              <span className="tabular-nums text-foreground">{count}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-label text-muted-foreground">暂无</p>
      )}
    </div>
  );
}

export function OutcomeMetricsSummary({ metrics }: { metrics: OutcomeMetrics }) {
  const maxAttempts = Math.max(1, ...metrics.dailyTrend.map((item) => item.attempts));
  const estimate = metrics.estimatedTimeSavedMs === null
    ? "—"
    : formatDuration(metrics.estimatedTimeSavedMs);
  return (
    <div aria-label="本机成效摘要">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MetricCard label="投递尝试" value={metrics.deliveryAttempts} />
        <MetricCard label="成功率" value={formatPercent(metrics.successRate)} />
        <MetricCard label="重试次数" value={metrics.retryCount} />
        <MetricCard label="目标失效阻止" value={metrics.targetInvalidationBlocks} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MetricCard label="草稿 → 发送（中位）" value={formatDuration(metrics.draftToSendMedianMs)} />
        <MetricCard label="发送 → 回收（中位）" value={formatDuration(metrics.sendToResultMedianMs)} />
        <MetricCard label="实测流程耗时（中位）" value={formatDuration(metrics.actualWorkflowMedianMs)} />
        {metrics.estimatedTimeSavedMs === null ? (
          <MetricCard label="人工基线" value="未设置" hint="设置后才显示节省时间估算" />
        ) : (
          <MetricCard
            label="估算累计节省"
            value={estimate}
            hint={`估算 · ${metrics.estimatedSampleSize} 个有人工基线样本`}
          />
        )}
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-4">
        <Distribution title="阻止原因" values={metrics.blockedReasons} />
        <Distribution title="失败原因" values={metrics.failedReasons} />
        <Distribution title="剪贴板结果" values={metrics.clipboardOutcomes} />
        <Distribution title="结果质量" values={metrics.qualityFeedback} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MetricCard label="Firewall 命中" value={metrics.firewallFindingCount} />
        <MetricCard label="已替换敏感项" value={metrics.redactionCount} />
        <MetricCard
          label="结果核验"
          value={metrics.verificationStatuses.pass + metrics.verificationStatuses.needsReview + metrics.verificationStatuses.blocked}
          hint={`通过 ${metrics.verificationStatuses.pass} · 复核 ${metrics.verificationStatuses.needsReview} · 阻止 ${metrics.verificationStatuses.blocked}`}
        />
        <MetricCard label="问题解决耗时（中位）" value={formatDuration(metrics.problemResolutionMedianMs)} hint="仅主动计时会话" />
      </div>
      <div className="mt-2 rounded-xl border border-border/60 bg-card px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-body font-medium">每日投递</p>
          <span className="text-micro text-muted-foreground">
            样本 {metrics.sampleSize}
          </span>
        </div>
        {metrics.dailyTrend.length ? (
          <div
            className="mt-2 flex h-20 items-end gap-1"
            role="img"
            aria-label={`每日投递柱状图，共 ${metrics.dailyTrend.length} 天`}
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
              ? "至少需要 2 个有投递的日期才给出趋势结论。"
            : metrics.trendConclusion === "up"
              ? "后半段成功投递数量上升。"
              : metrics.trendConclusion === "down"
                ? "后半段成功投递数量下降。"
                : "前后两段成功投递数量持平。"}
        </p>
      </div>
    </div>
  );
}

function nextSessionId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `problem-${Date.now().toString(36)}`;
}

export function OutcomeInsightsSection({ settings, patch }: Props) {
  const [events, setEvents] = useState<DeliveryEvent[]>([]);
  const [loading, setLoading] = useState(false);
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
      setError("本地投递元数据读取失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, [settings.outcomeRetentionDays]);

  useEffect(() => {
    void load();
    const clearListener = listen(DELIVERY_ACTIVITY_CLEARED_EVENT, () => setEvents([]));
    return () => { void clearListener.then((stop) => stop()); };
  }, [load]);

  const metrics = useMemo(() => aggregateOutcomeMetrics(
    events,
    settings.outcomeQualityFeedback,
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
    settings.outcomeQualityFeedback,
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
      "清除成效统计、结果质量反馈和问题计时？最近投递恢复记录、卡片、任务、附件及人工基线不会改变。",
      { title: "清除成效历史", kind: "warning" }
    );
    if (!confirmed) return;
    if (settings.outcomeMetricsEpoch >= Number.MAX_SAFE_INTEGER) {
      tip("warn", "成效历史代次已达安全上限，请先导出诊断后联系支持");
      return;
    }
    patch({
      outcomeMetricsEpoch: settings.outcomeMetricsEpoch + 1,
      outcomeQualityFeedback: [],
      outcomeProblemSessions: [],
    });
    tip("ok", "成效历史已清除；最近投递记录仍保留");
  };

  const baselineOptions = [
    ...settings.targetProfiles.map((profile) => ({
      value: `profile:${profile.id}`,
      label: `方案 · ${profile.name}`,
    })),
    ...TRANSFORM_RECIPES.map((recipe) => ({
      value: `recipe:${recipe.id}`,
      label: `配方 · ${recipe.label}`,
    })),
  ];

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-heading font-semibold">成效与隐私</h2>
          <p className="mt-1 text-body text-muted-foreground">
            只在本机按元数据聚合，不上传、不读取卡片正文，也不计算金额或自动 ROI。
          </p>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin motion-reduce:animate-none")} />
          刷新
        </Button>
      </div>

      <div className="mb-4 divide-y divide-border/50 rounded-xl border border-border/60 bg-card">
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-title">本机成效度量</p>
            <p className="mt-0.5 text-label text-muted-foreground">
              关闭后新投递仍写入最近投递恢复账本，但明确排除在成效聚合之外。
            </p>
          </div>
          <Switch
            aria-label="本机成效度量"
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
            <p className="text-title">元数据保留期</p>
            <p className="mt-0.5 text-label text-muted-foreground">最多仍为 500 条；缩短后下次读取即压实。</p>
          </div>
          <SimpleSelect
            ariaLabel="元数据保留期"
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
        <details className="px-3.5 py-2.5 text-label text-muted-foreground">
          <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/50">具体记录什么</summary>
          <p className="mt-1.5 leading-relaxed">
            时间、目标应用、投递方案、已应用配方、状态/原因、字符与图片数量、Firewall/脱敏计数、剪贴板结果、结果卡 ID 与核验计数。绝不保存正文、Prompt、API Key、目标 token 或脱敏映射。
          </p>
        </details>
      </div>

      {!settings.outcomeMetricsEnabled && (
        <p role="status" className="mb-3 rounded-xl bg-warning/10 px-3 py-2 text-body text-warning">
          成效度量已暂停；既有本机历史仍保留，可单独清除。
        </p>
      )}
      {error && <p role="alert" className="mb-3 rounded-xl bg-destructive/10 px-3 py-2 text-body text-destructive">{error}</p>}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented ariaLabel="成效统计范围" value={range} options={RANGE_OPTIONS} onChange={setRange} />
        <SimpleSelect
          ariaLabel="按投递方案筛选"
          className="w-40"
          value={profileId}
          options={[
            { value: "all", label: "全部投递方案" },
            ...settings.targetProfiles.map((profile) => ({ value: profile.id, label: profile.name })),
          ]}
          onChange={setProfileId}
        />
        <SimpleSelect
          ariaLabel="按 AI 配方筛选"
          className="w-36"
          value={recipeId}
          options={[
            { value: "all", label: "全部配方" },
            ...TRANSFORM_RECIPES.map((recipe) => ({ value: recipe.id, label: recipe.label })),
          ]}
          onChange={setRecipeId}
        />
      </div>

      {loading && !events.length
        ? <p role="status" className="py-12 text-center text-body text-muted-foreground">正在读取本机元数据…</p>
        : <OutcomeMetricsSummary metrics={metrics} />}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <section className="rounded-xl border border-border/60 bg-card p-3" aria-labelledby="outcome-baseline-title">
          <div className="flex items-start gap-2">
            <Clock3 className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
            <div>
              <h3 id="outcome-baseline-title" className="text-title font-medium">人工基线</h3>
              <p className="mt-0.5 text-label text-muted-foreground">填写不用 Toskr 时完成同类流程的分钟数；只用于标注为“估算”的时间差。</p>
            </div>
          </div>
          <div className="mt-2 flex gap-2">
            <SimpleSelect ariaLabel="基线适用范围" className="min-w-0 flex-1" value={baselineScope} options={baselineOptions} onChange={setBaselineScope} />
            <input
              type="number"
              min={0.1}
              max={10_080}
              step={0.5}
              aria-label="传统流程分钟数"
              value={baselineMinutes}
              onChange={(event) => setBaselineMinutes(event.target.value)}
              placeholder="分钟"
              className="h-8 w-24 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
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
                    aria-label={`删除基线 ${label}`}
                    onClick={() => patch({ outcomeBaselines: settings.outcomeBaselines.filter((item) => `${item.scope}:${item.scopeId}` !== key) })}
                    className="rounded-sm p-0.5 text-muted-foreground hover:text-destructive focus-visible:ring-2 focus-visible:ring-primary/50"
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
              <h3 id="problem-session-title" className="text-title font-medium">问题处理计时（可选）</h3>
              <p className="mt-0.5 text-label text-muted-foreground">只记录开始、关联投递、解决/取消时间，不记录问题内容。</p>
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
                ariaLabel="关联问题会话到最近投递"
                value={activeSession.deliveryId ?? "none"}
                options={[
                  { value: "none", label: "尚未关联投递" },
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
                      ? "已关联投递与结果"
                      : "已关联投递，结果尚未回收"}
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

      <div className="mt-4 rounded-xl border border-border/60 bg-card p-3">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 text-success" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-title font-medium">数据控制</p>
            <p className="mt-0.5 text-label text-muted-foreground">结果质量可在“最近投递”中选填。清除只推进统计时间边界，不删除恢复记录或业务内容。</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => void clearMetrics()}>
            <Trash2 className="size-3.5" /> 清除成效历史
          </Button>
        </div>
      </div>
    </div>
  );
}
