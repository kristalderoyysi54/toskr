import { AlertTriangle, ArrowDown } from "lucide-react";

import { AppIcon } from "@/components/settings/AppIdentity";
import { useT, type MessageKey } from "@/lib/i18n";
import {
  DELIVERY_FORMAT_OPTIONS,
  PRIVACY_POLICY_OPTIONS,
} from "@/lib/profileManager";
import {
  ENTER_POLICY_STATUS_LABEL,
  TARGET_PROFILE_SOURCE_LABEL,
} from "@/lib/targetLens";
import {
  targetProfileOutputMode,
  type TargetProfile,
  type TargetProfileResolution,
} from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";
import { profileName } from "@/lib/i18n/builtinNames";

function TrackCard({
  title,
  warning = false,
  children,
}: {
  title: string;
  warning?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "min-w-0 rounded-xl border p-2.5 transition-transform duration-100 motion-reduce:transition-none",
        warning
          ? "border-warning/40 bg-warning/10"
          : "border-border/70 bg-card"
      )}
    >
      <p className={cn("text-label font-semibold", warning ? "text-warning" : "text-foreground")}>{title}</p>
      <div className="mt-1 space-y-0.5 text-label text-muted-foreground">{children}</div>
    </li>
  );
}

function Connector() {
  return (
    <li aria-hidden className="flex h-4 items-center pl-3 text-muted-foreground">
      <ArrowDown className="size-3" />
    </li>
  );
}

export function DeliveryTrack({
  configuredProfile,
  configuredPromptGroupName,
  previewResolution,
  currentResolution,
  targetBundleId,
  targetName,
}: {
  configuredProfile: TargetProfile;
  configuredPromptGroupName: string | null;
  previewResolution: TargetProfileResolution;
  currentResolution: TargetProfileResolution;
  targetBundleId: string | null;
  targetName: string;
}) {
  const t = useT();
  // targetLens 标签表仍是 string；缺英文条目时 t 回落中文原文
  const enterLabel = (profile: TargetProfile) => t(ENTER_POLICY_STATUS_LABEL[profile.enterPolicy] as MessageKey);
  const sourceLabel = (resolution: TargetProfileResolution) => t(TARGET_PROFILE_SOURCE_LABEL[resolution.source] as MessageKey);
  const panelLabel = (profile: TargetProfile) => profile.keepPanel ? t("保持打开") : t("关闭面板");
  const optionForProfile = (profile: TargetProfile) =>
    DELIVERY_FORMAT_OPTIONS.find(
      (option) => option.value === targetProfileOutputMode(profile)
    ) ?? DELIVERY_FORMAT_OPTIONS[0];
  const configuredFormat = optionForProfile(configuredProfile);
  const previewFormat = optionForProfile(previewResolution.profile);
  const currentFormat = optionForProfile(currentResolution.profile);
  const configuredPrivacy = t(PRIVACY_POLICY_OPTIONS.find(
    (option) => option.value === configuredProfile.privacyPolicy
  )?.label ?? "未设置");
  const currentPrivacy = t(PRIVACY_POLICY_OPTIONS.find(
    (option) => option.value === currentResolution.profile.privacyPolicy
  )?.label ?? "未设置");
  const targetStatus = !targetBundleId
    ? t("尚未识别，发送已锁定")
    : currentResolution.isTargetReady
      ? t("可发送")
      : t("目标已失效，发送已锁定");
  const configuredGroup = configuredPromptGroupName ?? t("已删除的提示词组");

  return (
    <div
      className="rounded-xl bg-muted/30 p-2.5"
      aria-label={t("{name} 应用到当前测试目标的发送轨道", { name: configuredProfile.name })}
    >
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <AppIcon bundleId={targetBundleId} appName={targetName} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-semibold" title={targetName}>{targetName}</p>
          <p className={cn(
            "text-micro",
            currentResolution.isTargetReady
              ? "text-success"
              : targetBundleId
                ? "text-destructive"
                : "text-muted-foreground"
          )}>
            {targetStatus}
          </p>
        </div>
      </div>

      <ol aria-label={t("配置到生效的发送轨道")}>
        <TrackCard title={t("配置值")} warning={!configuredPromptGroupName}>
          <p>{t("发送方案：{value}", { value: profileName(configuredProfile) })}</p>
          <p className={cn(!configuredPromptGroupName && "text-warning")}>{t("提示词组：{value}", { value: configuredGroup })}</p>
          <p>{t("输出格式：{value}", { value: t(configuredFormat.label) })}</p>
          <p className={cn(configuredProfile.enterPolicy === "allow" && "text-warning")}>
            {t("粘贴后动作：{value}", { value: enterLabel(configuredProfile) })}
          </p>
          <p>{t("发送完成后：{value}", { value: panelLabel(configuredProfile) })}</p>
        </TrackCard>
        <Connector />
        <TrackCard
          title={t("测试预演值（不影响当前发送）")}
          warning={!previewResolution.isTargetReady || !configuredPromptGroupName}
        >
          <p>{t("目标应用：{value}", { value: targetName })}</p>
          <p>{t("匹配来源：{value}", { value: sourceLabel(previewResolution) })}</p>
          <p>{t("发送方案：{value}", { value: profileName(previewResolution.profile) })}</p>
          <p>{t("提示词组：{value}", { value: previewResolution.promptGroup.name })}</p>
          <p>{t("输出格式：{value}", { value: t(previewFormat.label) })}</p>
          <p className={cn(previewResolution.profile.enterPolicy === "allow" && "text-warning")}>
            {t("粘贴后动作：{value}", { value: enterLabel(previewResolution.profile) })}
          </p>
          <p>{t("发送完成后：{value}", { value: panelLabel(previewResolution.profile) })}</p>
        </TrackCard>
        <Connector />
        <TrackCard
          title={t("应用默认生效值")}
          warning={currentResolution.source === "conflict" || !currentResolution.isTargetReady || currentResolution.safetyClamped}
        >
          <p>{t("目标应用：{value}", { value: targetName })}</p>
          <p>{t("匹配来源：{value}", { value: sourceLabel(currentResolution) })}</p>
          <p>{t("发送方案：{value}", { value: profileName(currentResolution.profile) })}</p>
          <p>{t("提示词组：{value}", { value: currentResolution.promptGroup.name })}</p>
          <p>{t("输出格式：{value}", { value: t(currentFormat.label) })}</p>
          <p className={cn(currentResolution.profile.enterPolicy === "allow" && "text-warning")}>
            {t("粘贴后动作：{value}", { value: enterLabel(currentResolution.profile) })}
          </p>
          <p>{t("发送完成后：{value}", { value: panelLabel(currentResolution.profile) })}</p>
          {currentResolution.safetyClamped && (
            <p className="text-warning">{t("默认回退已收紧为从不按回车。")}</p>
          )}
        </TrackCard>
        <Connector />
        <TrackCard
          title={currentResolution.privacyCapabilityActive
            ? t("发送前隐私门禁")
            : t("隐私检查已关闭")}
          warning={!currentResolution.privacyCapabilityActive}
        >
          {!currentResolution.privacyCapabilityActive && (
            <p className="flex items-start gap-1 text-warning">
              <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span>{t("总开关已关闭，本次不会扫描文本")}</span>
            </p>
          )}
          <p>{t("配置策略：{value}", { value: configuredPrivacy })}</p>
          <p>{t("当前生效策略：{value}", { value: currentPrivacy })}</p>
        </TrackCard>
      </ol>

    </div>
  );
}
