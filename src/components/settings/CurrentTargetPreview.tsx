import { FlaskConical, Pencil, RefreshCw } from "lucide-react";

import { AppIcon } from "@/components/settings/AppIdentity";
import { DeliveryPolicySummary } from "@/components/settings/DeliveryPolicySummary";
import { useAppIdentity } from "@/components/settings/useAppIdentity";
import { DetailsSummary } from "@/components/ui/disclosure";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { t, useT, type MessageKey } from "@/lib/i18n";
import { TARGET_PROFILE_SOURCE_LABEL } from "@/lib/targetLens";
import type { TargetSnapshot } from "@/lib/tauri";
import type { TargetProfileResolution } from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";
import { profileName } from "@/lib/i18n/builtinNames";

/** 措辞根词统一走 TARGET_PROFILE_SOURCE_LABEL，这里只拼接目标上下文。 */
function targetPreviewReason(
  snapshot: TargetSnapshot | null,
  resolution: TargetProfileResolution
): string {
  if (!snapshot?.bundleId) return t("尚未识别发送目标");
  if (!snapshot.ready) return t("需要重新确认粘贴位置");
  // targetLens 标签表仍是 string；缺英文条目时 t 回落中文原文
  const base = t(TARGET_PROFILE_SOURCE_LABEL[resolution.source] as MessageKey);
  switch (resolution.source) {
    case "conflict":
      return t("{base}，当前稳定使用 {name}", { base, name: profileName(resolution.profile) });
    case "exact":
      return t("{base}：已为 {app} 指定", { base, app: snapshot.appName || snapshot.bundleId });
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
  const t = useT();
  const identity = useAppIdentity(snapshot?.bundleId, snapshot?.appName);
  const appName = identity?.name || snapshot?.appName || snapshot?.bundleId || t("未识别目标");
  const targetStatus = !snapshot?.bundleId
    ? t("尚未识别")
    : snapshot.ready
      ? t("可粘贴")
      : snapshot.reason === "target_exited" ? t("应用已退出") : t("请重新选择输入框");
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
            {t("当前粘贴目标")}
          </p>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
            <h3 className="min-w-0 truncate text-title font-semibold" title={appName}>
              {appName}
            </h3>
            <span
              role="status"
              aria-live="off"
              aria-label={t("目标状态：{status}", { status: targetStatus })}
              className={cn("rounded-sm px-1.5 py-0.5 text-micro font-medium", statusTone)}
            >
              {targetStatus}
            </span>
          </div>
        </div>
        <Button type="button" size="sm" onClick={onEditProfile}>
          <Pencil aria-hidden className="size-3.5" /> {t("调整粘贴规则")}
        </Button>
      </div>

      {!snapshot?.ready && (
        <p className="mt-2 text-label text-muted-foreground">
          {t("请先点目标应用的输入框，再唤出 Toskr。位置未确认前不会粘贴。")}
        </p>
      )}

      <div className="mt-2 rounded-lg bg-muted/35 px-2.5 py-2">
        <DeliveryPolicySummary
          profile={resolution.profile}
          privacyCapabilityActive={resolution.privacyCapabilityActive}
        />
      </div>
      <p className="mt-2 text-micro text-muted-foreground">
        {t("本次临时调整以主面板为准。")}
      </p>

      {resolution.source === "conflict" && (
        <p className="mt-2 text-label text-warning">
          {t("此应用有重复绑定，请在下方选择保留哪套规则。")}
        </p>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {t("当前粘贴目标 {app}，{status}，默认方案 {profile}", { app: appName, status: targetStatus, profile: profileName(resolution.profile) })}
      </p>
      <details className="mt-3 border-t border-border/60 pt-2">
        <DetailsSummary className="text-label text-muted-foreground">{t("规则详情")}</DetailsSummary>
        <p className="mt-2 break-words text-label" title={profileName(resolution.profile)}>
          {t("使用方案：{name}", { name: profileName(resolution.profile) })}
        </p>
        <p className="mt-1 text-label text-muted-foreground">{t("规则来源：{reason}", { reason })}</p>
        <p className="mt-1 text-label text-muted-foreground">
          {t("其他模板优先显示「{group}」组；不会自动套用模板。", { group: resolution.promptGroup.name })}
        </p>
        <div className="mt-2 flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={!snapshot?.bundleId || refreshing}
            onClick={onTest}
            title={t("重新计算此应用的默认规则，不会执行粘贴或回车")}
          >
            <FlaskConical aria-hidden className="size-3.5" /> {t("检查规则")}
          </Button>
          <IconButton label={t("重新识别粘贴目标")} size="sm" disabled={refreshing} onClick={onRefresh}>
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
