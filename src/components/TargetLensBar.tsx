import { AppWindow, ChevronDown, RefreshCw } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { SimpleSelect } from "@/components/SimpleSelect";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api, type TargetSnapshot } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  resolveTargetProfile,
  type DeliveryFormat,
  type EnterPolicy,
  type PrivacyPolicy,
  type TargetProfileResolutionSource,
} from "@/lib/targetProfiles";
import { useNotesStore } from "@/store/notesStore";
import {
  confirmTargetProfileOverride,
  setTargetProfileOverride,
  refreshTarget,
  targetReasonLabel,
  targetStatusLabel,
  useTargetStore,
  type TargetStateReason,
  type TargetStatus,
} from "@/store/targetStore";
import type { AppIconInfo } from "@/lib/icons";

export interface TargetLensViewProps {
  snapshot: TargetSnapshot | null;
  status: TargetStatus;
  reason: TargetStateReason;
  icon: AppIconInfo | null;
  profileName: string;
  promptGroupName: string;
  profileSource: TargetProfileResolutionSource;
  defaultFormat: DeliveryFormat;
  enterPolicy: EnterPolicy;
  privacyPolicy: PrivacyPolicy;
  duplicateBundleProfileIds: string[];
  profileOverrideNeedsConfirmation: boolean;
  profileOverrideId: string | null;
  profileOptions: { id: string; name: string }[];
  onRefresh: () => void;
  onConfirmProfile: () => void;
  onSelectProfile: (profileId: string | null) => void;
  onManageProfiles: () => void;
}

const ENTER_LABEL: Record<EnterPolicy, string> = {
  never: "关闭",
  confirm: "发送前确认",
  allow: "允许",
};
// 脱敏/原文确认的执行链由后续隐私阶段接入；接入前必须标注「未生效」，
// 禁止让用户误信当前发送已有脱敏或确认防护。
const PRIVACY_LABEL: Record<PrivacyPolicy, string> = {
  requireRedaction: "要求脱敏（未生效）",
  confirmRaw: "原文需确认（未生效）",
  allowRaw: "允许原文",
};

export function TargetLensView({
  snapshot,
  status,
  reason,
  icon,
  profileName,
  promptGroupName,
  profileSource,
  defaultFormat,
  enterPolicy,
  privacyPolicy,
  duplicateBundleProfileIds,
  profileOverrideNeedsConfirmation,
  profileOverrideId,
  profileOptions,
  onRefresh,
  onConfirmProfile,
  onSelectProfile,
  onManageProfiles,
}: TargetLensViewProps) {
  const appName = snapshot?.appName ?? "未识别目标";
  const statusLabel = targetStatusLabel(status);
  const enterLabel = ENTER_LABEL[enterPolicy];
  const privacyLabel = PRIVACY_LABEL[privacyPolicy];
  const blockedReason = status === "blocked" || status === "unknown"
    ? targetReasonLabel(reason)
    : null;
  const accessibleLabel = [
    `目标 ${appName}，状态 ${statusLabel}，Profile ${profileName}，Prompt 分组 ${promptGroupName}，格式${defaultFormat === "code" ? "代码" : "纯文本"}，自动回车${enterLabel}，隐私${privacyLabel}`,
    profileSource === "temporary" ? "本次使用临时 Profile" : null,
    profileOverrideNeedsConfirmation ? "目标已变化，请确认 Profile" : null,
    duplicateBundleProfileIds.length > 1
      ? `多个 Profile 命中，按列表顺序使用 ${profileName}`
      : null,
    blockedReason ? `原因 ${blockedReason}` : null,
  ]
    .filter(Boolean)
    .join("，");

  return (
    <section
      role="status"
      aria-live="polite"
      aria-busy={status === "refreshing"}
      aria-label={accessibleLabel}
      className="mx-3 mb-1.5 border-y border-border/70 px-1 py-0.5"
    >
      <div className="flex min-h-6 items-center gap-1.5">
        {icon ? (
          <img src={icon.url} alt="" className="size-4 shrink-0 rounded-sm" />
        ) : (
          <span
            data-target-icon="fallback"
            aria-hidden="true"
            className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground"
          >
            <AppWindow className="size-3" />
          </span>
        )}

        <span className="min-w-0 truncate text-label font-medium" title={appName}>
          {appName}
        </span>
        <span aria-hidden className="text-muted-foreground/50">·</span>
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status === "ready" && "bg-success",
            status === "refreshing" && "motion-safe:animate-pulse bg-warning",
            status === "blocked" && "bg-destructive",
            status === "unknown" && "bg-muted-foreground/50"
          )}
        />
        <span className="shrink-0 text-micro text-muted-foreground">{statusLabel}</span>
        <span className="flex-1" />
        {enterPolicy !== "never" && (
          <span className="shrink-0 rounded-sm bg-warning/15 px-1 text-micro font-medium text-warning">
            回车：{enterPolicy === "confirm" ? "需确认" : "自动"}
          </span>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              title={profileName}
              aria-label={`本次投递 Profile：${profileName}，点击查看与切换`}
              className={cn(
                "flex max-w-32 shrink-0 items-center gap-0.5 rounded-sm border px-1 py-0.5 text-micro outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary/50",
                profileOverrideId
                  ? "border-primary/50 text-primary"
                  : "border-border text-muted-foreground"
              )}
            >
              <span className="truncate">{profileName}</span>
              <ChevronDown aria-hidden className="size-2.5 shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={4} className="w-60 gap-1.5 p-2">
            <TargetLensProfileDetails
              profileName={profileName}
              promptGroupName={promptGroupName}
              defaultFormat={defaultFormat}
              enterPolicy={enterPolicy}
              privacyPolicy={privacyPolicy}
              selectDisabled={status !== "ready"}
              profileOverrideId={profileOverrideId}
              profileOptions={profileOptions}
              onSelectProfile={onSelectProfile}
              onManageProfiles={onManageProfiles}
            />
          </PopoverContent>
        </Popover>
        {status === "blocked" || status === "unknown" ? (
          <button
            type="button"
            tabIndex={0}
            aria-label="重新识别投递目标"
            onClick={onRefresh}
            className="flex shrink-0 items-center gap-0.5 rounded-sm px-0.5 text-micro font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <RefreshCw className="size-3" />
            重新识别
          </button>
        ) : (
          <IconButton
            label="重新识别投递目标"
            withTitle={false}
            size="2xs"
            disabled={status === "refreshing"}
            onClick={onRefresh}
          >
            <RefreshCw className={cn(status === "refreshing" && "motion-safe:animate-spin")} />
          </IconButton>
        )}
      </div>
      {profileOverrideNeedsConfirmation && (
        <div className="flex items-center justify-between gap-2 pb-0.5 pl-5 text-micro text-warning" role="alert">
          <span>目标已变化，请确认 Profile</span>
          <button
            type="button"
            onClick={onConfirmProfile}
            className="shrink-0 rounded-sm px-1 font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            确认本次 Profile
          </button>
        </div>
      )}
      {duplicateBundleProfileIds.length > 1 && (
        <p className="truncate pb-0.5 pl-5 text-micro text-warning" role="alert">
          多个 Profile 命中；按列表顺序使用 {profileName}
        </p>
      )}
      {blockedReason && (
        <p
          className={cn(
            "truncate pb-0.5 pl-5 text-micro",
            status === "blocked" ? "text-destructive" : "text-muted-foreground"
          )}
          title={blockedReason}
        >
          {blockedReason}
        </p>
      )}
    </section>
  );
}

export interface TargetLensProfileDetailsProps {
  profileName: string;
  promptGroupName: string;
  defaultFormat: DeliveryFormat;
  enterPolicy: EnterPolicy;
  privacyPolicy: PrivacyPolicy;
  selectDisabled: boolean;
  profileOverrideId: string | null;
  profileOptions: { id: string; name: string }[];
  onSelectProfile: (profileId: string | null) => void;
  onManageProfiles: () => void;
}

/** Profile 徽章弹层：本次临时覆盖选择 + 当前生效策略明细（只读）。 */
export function TargetLensProfileDetails({
  profileName,
  promptGroupName,
  defaultFormat,
  enterPolicy,
  privacyPolicy,
  selectDisabled,
  profileOverrideId,
  profileOptions,
  onSelectProfile,
  onManageProfiles,
}: TargetLensProfileDetailsProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {/* 不用 <label> 包裹：label 会把点击转发给触发钮，而转发前的 pointerdown
          落在菜单根节点外，先触发外点关闭再被转发点击重开——闪烁竞态（SimpleMenu
          的既有坑）。文案独立成行，a11y 走触发钮的 aria-label */}
      <div className="flex flex-col gap-0.5 text-micro text-muted-foreground">
        本次投递 Profile
        <SimpleSelect
          ariaLabel="本次投递 Profile"
          size="micro"
          disabled={selectDisabled}
          value={profileOverrideId ?? "__auto__"}
          options={[
            { value: "__auto__", label: `自动：${profileName}` },
            ...profileOptions.map((profile) => ({
              value: profile.id,
              label: profile.name,
            })),
          ]}
          onChange={(next) => onSelectProfile(next === "__auto__" ? null : next)}
        />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-micro">
        <dt className="text-muted-foreground">模板分组</dt>
        <dd className="truncate">{promptGroupName}</dd>
        <dt className="text-muted-foreground">默认格式</dt>
        <dd>{defaultFormat === "code" ? "代码块" : "纯文本"}</dd>
        <dt className="text-muted-foreground">自动回车</dt>
        <dd>{ENTER_LABEL[enterPolicy]}</dd>
        <dt className="text-muted-foreground">隐私策略</dt>
        <dd>{PRIVACY_LABEL[privacyPolicy]}</dd>
      </dl>
      <button
        type="button"
        onClick={onManageProfiles}
        className="self-start rounded-sm text-micro text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        管理 Profile 与模板…
      </button>
    </div>
  );
}

export function TargetLensBar() {
  const snapshot = useTargetStore((state) => state.snapshot);
  const status = useTargetStore((state) => state.status);
  const reason = useTargetStore((state) => state.reason);
  const icon = useTargetStore((state) => state.icon);
  const promptGroups = useNotesStore((state) => state.settings.promptGroups);
  const targetProfiles = useNotesStore((state) => state.settings.targetProfiles);
  const defaultTargetProfileId = useNotesStore(
    (state) => state.settings.defaultTargetProfileId
  );
  const profileOverrideId = useTargetStore((state) => state.profileOverrideId);
  const profileOverrideNeedsConfirmation = useTargetStore(
    (state) => state.profileOverrideNeedsConfirmation
  );
  const resolution = resolveTargetProfile({
    bundleId: snapshot?.bundleId,
    groups: promptGroups,
    profiles: targetProfiles,
    defaultProfileId: defaultTargetProfileId,
    temporaryProfileId: profileOverrideId,
  });

  return (
    <TargetLensView
      snapshot={snapshot}
      status={status}
      reason={reason}
      icon={icon}
      profileName={resolution.profile.name}
      promptGroupName={resolution.promptGroup.name}
      profileSource={resolution.source}
      defaultFormat={resolution.profile.defaultFormat}
      enterPolicy={resolution.profile.enterPolicy}
      privacyPolicy={resolution.profile.privacyPolicy}
      duplicateBundleProfileIds={resolution.duplicateBundleProfileIds}
      profileOverrideNeedsConfirmation={profileOverrideNeedsConfirmation}
      profileOverrideId={profileOverrideId}
      profileOptions={targetProfiles.map(({ id, name }) => ({ id, name }))}
      onRefresh={() => void refreshTarget()}
      onConfirmProfile={confirmTargetProfileOverride}
      onSelectProfile={setTargetProfileOverride}
      onManageProfiles={() => void api.openSettingsWindow()}
    />
  );
}
