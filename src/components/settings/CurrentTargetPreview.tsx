import { FlaskConical, RefreshCw } from "lucide-react";

import { AppIcon } from "@/components/settings/AppIdentity";
import { DeliveryPolicySummary } from "@/components/settings/DeliveryPolicySummary";
import { useAppIdentity } from "@/components/settings/useAppIdentity";
import { IconButton } from "@/components/ui/icon-button";
import type { TargetSnapshot } from "@/lib/tauri";
import type { TargetProfileResolution } from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";

function targetPreviewReason(
  snapshot: TargetSnapshot | null,
  resolution: TargetProfileResolution
): string {
  if (!snapshot?.bundleId) return "尚未识别发送目标";
  if (!snapshot.ready) return "目标应用已失效";
  switch (resolution.source) {
    case "temporary":
      return "仅本次手动选择";
    case "conflict":
      return `存在重复应用绑定，当前稳定使用 ${resolution.profile.name}`;
    case "exact":
      return `已为 ${snapshot.appName || snapshot.bundleId} 指定`;
    default:
      return "未匹配具体应用，使用默认方案";
  }
}

export function CurrentTargetPreview({
  snapshot,
  resolution,
  refreshing,
  testMessage,
  onRefresh,
  onTest,
}: {
  snapshot: TargetSnapshot | null;
  resolution: TargetProfileResolution;
  refreshing: boolean;
  testMessage: string | null;
  onRefresh: () => void;
  onTest: () => void;
}) {
  const identity = useAppIdentity(snapshot?.bundleId, snapshot?.appName);
  const appName = identity?.name || snapshot?.appName || snapshot?.bundleId || "未识别目标";
  const targetStatus = !snapshot?.bundleId
    ? "尚未识别"
    : snapshot.ready
      ? "可发送"
      : "目标已失效";
  const reason = targetPreviewReason(snapshot, resolution);
  const statusTone = snapshot?.ready
    ? "bg-success/10 text-success"
    : snapshot?.bundleId
      ? "bg-destructive/10 text-destructive"
      : "bg-muted text-muted-foreground";

  return (
    <section
      aria-labelledby="current-target-preview-title"
      className="mb-4 min-w-0 rounded-xl border border-border/70 bg-card p-3"
    >
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <AppIcon bundleId={snapshot?.bundleId ?? null} appName={appName} size="md" />
        <div className="min-w-40 flex-1">
          <p id="current-target-preview-title" className="text-micro font-medium text-muted-foreground">
            当前匹配
          </p>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
            <h3 className="min-w-0 truncate text-title font-semibold" title={appName}>
              {appName}
            </h3>
            <span
              role="status"
              aria-live="off"
              aria-label={`目标状态：${targetStatus}`}
              className={cn("rounded-sm px-1.5 py-0.5 text-micro font-medium", statusTone)}
            >
              {targetStatus}
            </span>
          </div>
          <p className={cn(
            "mt-0.5 line-clamp-2 break-words text-label",
            resolution.source === "conflict" ? "text-warning" : "text-muted-foreground"
          )}>
            匹配来源：{reason}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <IconButton
            label="刷新当前目标"
            size="sm"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw
              className={cn(
                "size-3.5 transition-opacity duration-100 motion-reduce:transition-none",
                refreshing && "opacity-50"
              )}
            />
          </IconButton>
          <button
            type="button"
            disabled={!snapshot?.bundleId || refreshing}
            onClick={onTest}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-body outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-40 dark:hover:bg-white/10"
          >
            <FlaskConical aria-hidden className="size-3.5" />
            测试当前目标
          </button>
        </div>
      </div>

      <div className="mt-2 rounded-lg bg-muted/35 px-2.5 py-2">
        <p className="text-micro text-muted-foreground">解析到的发送方案</p>
        <p className="line-clamp-2 break-words text-body font-semibold" title={resolution.profile.name}>
          {resolution.profile.name}
        </p>
        <DeliveryPolicySummary
          className="mt-1.5"
          profile={resolution.profile}
          promptGroupName={resolution.promptGroup.name}
          privacyCapabilityActive={resolution.privacyCapabilityActive}
        />
      </div>

      {(resolution.source === "conflict" || !snapshot?.ready || !resolution.privacyCapabilityActive) && (
        <div className="mt-2 flex flex-wrap gap-1" aria-label="当前匹配警告">
          {resolution.source === "conflict" && (
            <span className="rounded-sm bg-warning/10 px-1.5 py-0.5 text-micro text-warning">
              重复应用绑定待修复
            </span>
          )}
          {snapshot?.bundleId && !snapshot.ready && (
            <span className="rounded-sm bg-destructive/10 px-1.5 py-0.5 text-micro text-destructive">
              目标失效，发送已锁定
            </span>
          )}
          {!resolution.privacyCapabilityActive && (
            <span className="rounded-sm bg-warning/10 px-1.5 py-0.5 text-micro text-warning">
              隐私检查尚未启用 · 本次未检查
            </span>
          )}
        </div>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        当前目标 {appName}，{targetStatus}，发送方案 {resolution.profile.name}
      </p>
      {testMessage && (
        <p role="status" aria-live="polite" className="mt-2 text-label text-muted-foreground">
          {testMessage}
        </p>
      )}
    </section>
  );
}
