import { FlaskConical, Pencil, RefreshCw } from "lucide-react";

import { AppIcon } from "@/components/settings/AppIdentity";
import { DeliveryPolicySummary } from "@/components/settings/DeliveryPolicySummary";
import { useAppIdentity } from "@/components/settings/useAppIdentity";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { TARGET_PROFILE_SOURCE_LABEL } from "@/lib/targetLens";
import type { TargetSnapshot } from "@/lib/tauri";
import type { TargetProfileResolution } from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";

/** 措辞根词统一走 TARGET_PROFILE_SOURCE_LABEL，这里只拼接目标上下文。 */
function targetPreviewReason(
  snapshot: TargetSnapshot | null,
  resolution: TargetProfileResolution
): string {
  if (!snapshot?.bundleId) return "尚未识别发送目标";
  if (!snapshot.ready) return "需要重新确认粘贴位置";
  const base = TARGET_PROFILE_SOURCE_LABEL[resolution.source];
  switch (resolution.source) {
    case "conflict":
      return `${base}，当前稳定使用 ${resolution.profile.name}`;
    case "exact":
      return `${base}：已为 ${snapshot.appName || snapshot.bundleId} 指定`;
    default:
      return base;
  }
}

export function CurrentTargetPreview({
  snapshot,
  resolution,
  refreshing,
  testMessage,
  onRefresh,
  onTest,
  onEditProfile,
}: {
  snapshot: TargetSnapshot | null;
  resolution: TargetProfileResolution;
  refreshing: boolean;
  testMessage: string | null;
  onRefresh: () => void;
  onTest: () => void;
  /** 直达当前应用的长期方案，并展开规则管理区。 */
  onEditProfile: () => void;
}) {
  const identity = useAppIdentity(snapshot?.bundleId, snapshot?.appName);
  const appName = identity?.name || snapshot?.appName || snapshot?.bundleId || "未识别目标";
  const targetStatus = !snapshot?.bundleId
    ? "尚未识别"
    : snapshot.ready
      ? "可粘贴"
      : snapshot.reason === "target_exited" ? "应用已退出" : "请重新选择输入框";
  const reason = targetPreviewReason(snapshot, resolution);
  const statusTone = snapshot?.ready
    ? "bg-success/10 text-success"
    : snapshot?.reason === "target_exited"
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
            当前粘贴目标
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
        </div>
        <Button type="button" size="sm" onClick={onEditProfile}>
          <Pencil aria-hidden className="size-3.5" /> 调整粘贴规则
        </Button>
      </div>

      {!snapshot?.ready && (
        <p className="mt-2 text-label text-muted-foreground">
          请先点目标应用的输入框，再唤出 Toskr。位置未确认前不会粘贴。
        </p>
      )}

      <div className="mt-2 rounded-lg bg-muted/35 px-2.5 py-2">
        <DeliveryPolicySummary
          profile={resolution.profile}
          privacyCapabilityActive={resolution.privacyCapabilityActive}
        />
      </div>
      <p className="mt-2 text-micro text-muted-foreground">
        这里显示应用默认规则；本次临时调整以主面板为准。
      </p>

      {resolution.source === "conflict" && (
        <p className="mt-2 text-label text-warning">
          此应用有重复绑定，请在下方选择保留哪套规则。
        </p>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        当前粘贴目标 {appName}，{targetStatus}，默认方案 {resolution.profile.name}
      </p>
      <details className="mt-3 border-t border-border/60 pt-2">
        <summary className="cursor-pointer text-label text-muted-foreground">规则详情</summary>
        <p className="mt-2 break-words text-label" title={resolution.profile.name}>
          使用方案：{resolution.profile.name}
        </p>
        <p className="mt-1 text-label text-muted-foreground">规则来源：{reason}</p>
        <p className="mt-1 text-label text-muted-foreground">
          其他模板优先显示「{resolution.promptGroup.name}」组；不会自动套用模板。
        </p>
        <div className="mt-2 flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={!snapshot?.bundleId || refreshing}
            onClick={onTest}
            title="重新计算此应用的默认规则，不会执行粘贴或回车"
          >
            <FlaskConical aria-hidden className="size-3.5" /> 检查规则
          </Button>
          <IconButton label="重新识别粘贴目标" size="sm" disabled={refreshing} onClick={onRefresh}>
            <RefreshCw className={cn("size-3.5", refreshing && "opacity-50")} />
          </IconButton>
        </div>
        {testMessage && (
          <p role="status" aria-live="polite" className="mt-2 text-label text-muted-foreground">
            {testMessage}
          </p>
        )}
      </details>
    </section>
  );
}
