import { AlertTriangle, ArrowDown } from "lucide-react";

import { AppIcon } from "@/components/settings/AppIdentity";
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
  const optionForProfile = (profile: TargetProfile) =>
    DELIVERY_FORMAT_OPTIONS.find(
      (option) => option.value === targetProfileOutputMode(profile)
    ) ?? DELIVERY_FORMAT_OPTIONS[0];
  const configuredFormat = optionForProfile(configuredProfile);
  const previewFormat = optionForProfile(previewResolution.profile);
  const currentFormat = optionForProfile(currentResolution.profile);
  const configuredPrivacy = PRIVACY_POLICY_OPTIONS.find(
    (option) => option.value === configuredProfile.privacyPolicy
  )?.label ?? "未设置";
  const currentPrivacy = PRIVACY_POLICY_OPTIONS.find(
    (option) => option.value === currentResolution.profile.privacyPolicy
  )?.label ?? "未设置";
  const targetStatus = !targetBundleId
    ? "尚未识别，发送已锁定"
    : currentResolution.isTargetReady
      ? "可发送"
      : "目标已失效，发送已锁定";
  const configuredGroup = configuredPromptGroupName ?? "已删除的提示词组";

  return (
    <div
      className="rounded-xl bg-muted/30 p-2.5"
      aria-label={`${configuredProfile.name} 应用到当前测试目标的发送轨道`}
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

      <ol aria-label="配置到生效的发送轨道">
        <TrackCard title="配置值" warning={!configuredPromptGroupName}>
          <p>发送方案：{configuredProfile.name}</p>
          <p className={cn(!configuredPromptGroupName && "text-warning")}>提示词组：{configuredGroup}</p>
          <p>输出格式：{configuredFormat.label}</p>
          <p className={cn(configuredProfile.enterPolicy === "allow" && "text-warning")}>
            粘贴后动作：{ENTER_POLICY_STATUS_LABEL[configuredProfile.enterPolicy]}
          </p>
          <p>发送完成后：{configuredProfile.keepPanel ? "保持打开" : "关闭面板"}</p>
        </TrackCard>
        <Connector />
        <TrackCard
          title="测试预演值（不影响当前发送）"
          warning={!previewResolution.isTargetReady || !configuredPromptGroupName}
        >
          <p>目标应用：{targetName}</p>
          <p>匹配来源：{TARGET_PROFILE_SOURCE_LABEL[previewResolution.source]}</p>
          <p>发送方案：{previewResolution.profile.name}</p>
          <p>提示词组：{previewResolution.promptGroup.name}</p>
          <p>输出格式：{previewFormat.label}</p>
          <p className={cn(previewResolution.profile.enterPolicy === "allow" && "text-warning")}>
            粘贴后动作：{ENTER_POLICY_STATUS_LABEL[previewResolution.profile.enterPolicy]}
          </p>
          <p>发送完成后：{previewResolution.profile.keepPanel ? "保持打开" : "关闭面板"}</p>
        </TrackCard>
        <Connector />
        <TrackCard
          title="当前真实生效值"
          warning={currentResolution.source === "conflict" || !currentResolution.isTargetReady || currentResolution.safetyClamped}
        >
          <p>目标应用：{targetName}</p>
          <p>匹配来源：{TARGET_PROFILE_SOURCE_LABEL[currentResolution.source]}</p>
          <p>发送方案：{currentResolution.profile.name}</p>
          <p>提示词组：{currentResolution.promptGroup.name}</p>
          <p>输出格式：{currentFormat.label}</p>
          <p className={cn(currentResolution.profile.enterPolicy === "allow" && "text-warning")}>
            粘贴后动作：{ENTER_POLICY_STATUS_LABEL[currentResolution.profile.enterPolicy]}
          </p>
          <p>发送完成后：{currentResolution.profile.keepPanel ? "保持打开" : "关闭面板"}</p>
          {currentResolution.safetyClamped && (
            <p className="text-warning">默认回退已收紧为从不按回车。</p>
          )}
        </TrackCard>
        <Connector />
        <TrackCard
          title={currentResolution.privacyCapabilityActive
            ? "发送前隐私门禁"
            : "隐私检查已关闭"}
          warning={!currentResolution.privacyCapabilityActive}
        >
          {!currentResolution.privacyCapabilityActive && (
            <p className="flex items-start gap-1 text-warning">
              <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span>总开关已关闭，本次不会扫描文本</span>
            </p>
          )}
          <p>配置策略：{configuredPrivacy}</p>
          <p>当前生效策略：{currentPrivacy}</p>
        </TrackCard>
      </ol>

    </div>
  );
}
