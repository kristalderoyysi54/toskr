import { emitTo } from "@tauri-apps/api/event";
import { ChevronDown, History, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { ApplicationIcon } from "@/components/ApplicationIcon";
import {
  ProfileRuleLedger,
  TargetProfileQuickSwitch,
} from "@/components/TargetProfileQuickSwitch";
import { RecentDeliveryDrawer } from "@/components/RecentDeliveryDrawer";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api, type TargetSnapshot } from "@/lib/tauri";
import {
  applySettingsPatch,
  SETTINGS_SECTION,
} from "@/lib/settingsSync";
import { tip } from "@/lib/tip";
import {
  canPermanentlyAssignTargetProfileOverride,
  DELIVERY_FORMAT_LABEL,
  ENTER_POLICY_STATUS_LABEL,
  hiddenWarningReasons,
  INITIAL_TARGET_LENS_DISCLOSURE_STATE,
  shouldClearOpenQuickSwitchOverride,
  targetLensDetailsExpanded,
  targetLensDisclosureStateAfter,
  type QuickProfileOption,
} from "@/lib/targetLens";
import { cn } from "@/lib/utils";
import {
  assignTargetProfileBundle,
  resolveTargetProfile,
  type DeliveryFormat,
  type EnterPolicy,
  type PromptGroup,
  type TargetProfile,
  type TargetProfileResolutionSource,
} from "@/lib/targetProfiles";
import { useNotesStore } from "@/store/notesStore";
import {
  clearTargetProfileOverride,
  confirmTargetProfileOverride,
  setTargetProfileOverride,
  refreshTarget,
  targetProfileIdentity,
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
  keepPanel: boolean;
  privacyCapabilityActive: boolean;
  profileId: string;
  profileOverrideNeedsConfirmation: boolean;
  profileOverrideId: string | null;
  profileOverrideName: string | null;
  automaticProfileName: string;
  quickProfiles: QuickProfileOption[];
  quickSwitchOpen: boolean;
  canMakePermanent: boolean;
  onRefresh: () => void;
  onConfirmProfile: () => void;
  onSelectProfile: (profileId: string | null) => void;
  onQuickSwitchOpenChange: (open: boolean) => void;
  onMakePermanent: () => void;
  onEditCurrentProfile: () => void;
  onOpenActivity: () => void;
  activityButtonRef?: React.RefObject<HTMLButtonElement>;
}

function toQuickProfile(
  profile: TargetProfile,
  groups: PromptGroup[]
): QuickProfileOption {
  return {
    id: profile.id,
    name: profile.name,
    promptGroupName:
      groups.find((group) => group.id === profile.promptGroupId)?.name ?? "通用",
    defaultFormat: profile.defaultFormat,
    enterPolicy: profile.enterPolicy,
    keepPanel: profile.keepPanel,
  };
}

function targetMatchReason(input: {
  status: TargetStatus;
  reason: TargetStateReason;
  source: TargetProfileResolutionSource;
  appName: string;
  profileName: string;
  overrideNeedsConfirmation: boolean;
}): string {
  if (input.status === "unknown") return "尚未识别发送目标，发送已锁定";
  if (input.status === "refreshing") return "正在重新确认目标与发送方案";
  if (input.status === "blocked") {
    return `目标应用已失效：${targetReasonLabel(input.reason)}`;
  }
  if (input.overrideNeedsConfirmation) {
    return "原临时发送方案已暂停，当前已按目标重新选择";
  }
  switch (input.source) {
    case "temporary":
      return "仅本次手动选择";
    case "conflict":
      return `存在重复应用绑定，当前稳定使用 ${input.profileName}`;
    case "exact":
      return `已为 ${input.appName} 指定`;
    default:
      return "未匹配具体应用，使用默认方案";
  }
}

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
  keepPanel,
  privacyCapabilityActive,
  profileId,
  profileOverrideNeedsConfirmation,
  profileOverrideId,
  profileOverrideName,
  automaticProfileName,
  quickProfiles,
  quickSwitchOpen,
  canMakePermanent,
  onRefresh,
  onConfirmProfile,
  onSelectProfile,
  onQuickSwitchOpenChange,
  onMakePermanent,
  onEditCurrentProfile,
  onOpenActivity,
  activityButtonRef,
}: TargetLensViewProps) {
  const detailsId = useId();
  const [disclosureState, dispatchDisclosure] = useReducer(
    targetLensDisclosureStateAfter,
    INITIAL_TARGET_LENS_DISCLOSURE_STATE
  );
  const detailsExpanded = targetLensDetailsExpanded(disclosureState);
  const appName = snapshot?.appName ?? "未识别目标";
  const profileConfirmationRequired =
    status === "ready" && profileOverrideNeedsConfirmation;
  const statusLabel = profileConfirmationRequired
    ? "需确认"
    : targetStatusLabel(status);
  const enterLabel = ENTER_POLICY_STATUS_LABEL[enterPolicy];
  const privacyLabel = privacyCapabilityActive
    ? "隐私检查：已启用"
    : "隐私检查：尚未启用";
  const matchReason = targetMatchReason({
    status,
    reason,
    source: profileSource,
    appName,
    profileName,
    overrideNeedsConfirmation: profileOverrideNeedsConfirmation,
  });
  const accessibleLabel = [
    `目标 ${appName}，状态 ${statusLabel}，发送方案 ${profileName}`,
    `匹配来源 ${matchReason}`,
    `提示词组 ${promptGroupName}，输出格式 ${DELIVERY_FORMAT_LABEL[defaultFormat]}`,
    `粘贴后动作 ${enterLabel}，发送完成后 ${keepPanel ? "保持打开" : "关闭面板"}，${privacyLabel}`,
  ].join("，");
  const statusTone = profileConfirmationRequired
    ? "text-warning"
    : status === "blocked" || status === "unknown"
      ? "text-destructive"
      : "text-muted-foreground";
  const statusDotTone = profileConfirmationRequired
    ? "bg-warning"
    : status === "ready"
      ? "bg-success"
      : status === "blocked" || status === "unknown"
        ? "bg-destructive"
        : "bg-muted-foreground";
  const reasonTone = status === "blocked" || status === "unknown"
    ? "text-destructive"
    : profileSource === "conflict" || profileOverrideNeedsConfirmation
      ? "text-warning"
      : "text-muted-foreground";
  const showRecoveryAction =
    status === "blocked" || status === "unknown" || status === "refreshing";
  const hasHiddenWarning =
    status === "ready" &&
    (!privacyCapabilityActive ||
      enterPolicy === "allow" ||
      profileSource === "conflict");
  // hover chevron 即见具体风险原因（同时解释右上角警示圆点），不必先展开
  const hiddenWarningDetail = hasHiddenWarning
    ? hiddenWarningReasons({
        privacyCapabilityActive,
        enterPolicy,
        profileSource,
      }).join("、")
    : "";
  const disclosureLabel = detailsExpanded
    ? "收起发送详情"
    : hiddenWarningDetail
      ? `展开发送详情 · ${hiddenWarningDetail}`
      : "展开发送详情";
  const currentQuickProfile = useMemo<QuickProfileOption>(
    () => ({
      id: profileId,
      name: profileName,
      promptGroupName,
      defaultFormat,
      enterPolicy,
      keepPanel,
    }),
    [defaultFormat, enterPolicy, keepPanel, profileId, profileName, promptGroupName]
  );
  const refreshControl = (
    <IconButton
      label="重新识别发送目标"
      withTitle={false}
      size="2xs"
      disabled={status === "refreshing"}
      onClick={onRefresh}
    >
      <RefreshCw
        className={cn(
          "transition-opacity duration-100 motion-reduce:transition-none",
          status === "refreshing" && "opacity-50"
        )}
      />
    </IconButton>
  );

  return (
    <section
      role="region"
      aria-busy={status === "refreshing"}
      aria-label={accessibleLabel}
      className="mx-3 mb-1.5 min-w-0 overflow-hidden px-1 py-1"
    >
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        发送目标 {appName}，{statusLabel}，当前发送方案 {profileName}
      </span>
      <div className="flex min-h-7 min-w-0 items-center gap-1.5">
        <div
          data-target-lens-identity
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
        >
          <ApplicationIcon
            src={icon?.url}
            name={appName}
            className="size-4 shrink-0 rounded-sm"
          />
          <span className="min-w-0 truncate text-label font-semibold" title={appName}>
            {appName}
          </span>
          <span aria-hidden className="shrink-0 text-micro text-muted-foreground/60">
            ·
          </span>
          <span
            role="status"
            aria-live="off"
            aria-label={`目标状态：${statusLabel}`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-micro font-medium",
              statusTone
            )}
          >
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", statusDotTone)}
            />
            {statusLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {showRecoveryAction && refreshControl}
          <IconButton
            ref={activityButtonRef}
            label="打开最近发送"
            size="xs"
            onClick={onOpenActivity}
          >
            <History aria-hidden className="size-3" />
          </IconButton>
          <IconButton
            label={disclosureLabel}
            size="xs"
            aria-expanded={detailsExpanded}
            aria-controls={detailsId}
            onClick={() => dispatchDisclosure({ type: "toggle" })}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !detailsExpanded) return;
              event.preventDefault();
              event.stopPropagation();
              dispatchDisclosure({ type: "dismiss" });
            }}
            className={cn(detailsExpanded && "bg-muted/50 text-foreground")}
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3 transition-transform duration-100 motion-reduce:transition-none",
                detailsExpanded && "rotate-180"
              )}
            />
            {hasHiddenWarning && !detailsExpanded && (
              <span
                aria-hidden
                data-target-lens-warning-indicator
                className="absolute right-0.5 top-0.5 size-1 rounded-full bg-warning ring-1 ring-background"
              />
            )}
          </IconButton>
        </div>
      </div>
      {!detailsExpanded && (status === "blocked" || status === "unknown") && (
        <p
          role="alert"
          className="mt-0.5 line-clamp-2 break-words pl-7 text-micro leading-tight text-destructive"
        >
          {matchReason}
        </p>
      )}
      {profileOverrideNeedsConfirmation && (
        <div
          role="alert"
          className="mt-1 flex min-w-0 items-start gap-1 rounded-sm bg-warning/10 px-1.5 py-1"
        >
          <p className="min-w-0 flex-1 line-clamp-2 break-words text-micro leading-tight text-warning">
            {matchReason}
          </p>
          <button
            type="button"
            onClick={onConfirmProfile}
            className="shrink-0 rounded-sm px-1 text-micro font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            将 {profileOverrideName ?? "原方案"} 用于当前目标
          </button>
        </div>
      )}
      {detailsExpanded && (
        <div
          id={detailsId}
          role="group"
          aria-label="完整发送详情"
          className="mt-1 origin-top rounded-lg bg-muted/30 px-2 py-1.5 animate-in fade-in zoom-in-95 duration-100 motion-reduce:animate-none"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-micro text-muted-foreground">
              方案
            </span>
            <Popover open={quickSwitchOpen} onOpenChange={onQuickSwitchOpenChange}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  tabIndex={0}
                  title={profileName}
                  aria-label={`本次发送方案：${profileName}，点击查看与切换`}
                  className={cn(
                    "flex min-w-0 max-w-40 items-center gap-1 rounded-md border px-1.5 py-0.5 text-label outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary/50",
                    profileOverrideId
                      ? "border-primary/50 text-primary"
                      : "border-border text-foreground"
                  )}
                >
                  <span className="truncate font-medium">{profileName}</span>
                  <ChevronDown
                    aria-hidden
                    className="size-2.5 shrink-0 text-muted-foreground"
                  />
                </button>
              </PopoverTrigger>
              {/* token-exception: viewport clamp prevents overflow in Toskr's 320–380px native panel. */}
              <PopoverContent
                align="end"
                sideOffset={4}
                aria-label={`发送到 ${appName}，快速切换发送方案`}
                className="w-80 max-w-[calc(100vw-1rem)] gap-0 p-2"
              >
                <TargetProfileQuickSwitch
                  appName={appName}
                  icon={icon}
                  status={status}
                  matchReason={matchReason}
                  currentProfile={currentQuickProfile}
                  candidates={quickProfiles}
                  privacyCapabilityActive={privacyCapabilityActive}
                  temporaryProfileId={profileOverrideId}
                  automaticProfileName={automaticProfileName}
                  canMakePermanent={canMakePermanent}
                  onSelectTemporary={onSelectProfile}
                  onRestoreAutomatic={() => onSelectProfile(null)}
                  onMakePermanent={onMakePermanent}
                  onEdit={onEditCurrentProfile}
                  onClose={() => onQuickSwitchOpenChange(false)}
                />
              </PopoverContent>
            </Popover>
            {/* 来源缩注取代整句「匹配来源」：临时指定/自动匹配一词即达 */}
            <span className="shrink-0 text-micro text-muted-foreground/60">
              {profileOverrideId ? "临时指定" : "自动匹配"}
            </span>
            {!showRecoveryAction && <span className="ml-auto">{refreshControl}</span>}
          </div>
          {/* 匹配来源正常态省略（头部状态徽章已表达；「自动匹配/临时指定」缩注在方案行）；
              警示/失效原因仍需完整呈现 */}
          {reasonTone !== "text-muted-foreground" && (
            <p
              className={cn(
                "mt-1 min-w-0 line-clamp-2 break-words text-micro leading-tight",
                reasonTone
              )}
            >
              {matchReason}
            </p>
          )}
          <ProfileRuleLedger
            className="mt-2"
            profile={currentQuickProfile}
            privacyCapabilityActive={privacyCapabilityActive}
          />
        </div>
      )}
    </section>
  );
}

export function TargetLensBar() {
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const activityButtonRef = useRef<HTMLButtonElement>(null);
  const snapshot = useTargetStore((state) => state.snapshot);
  const status = useTargetStore((state) => state.status);
  const reason = useTargetStore((state) => state.reason);
  const icon = useTargetStore((state) => state.icon);
  const promptGroups = useNotesStore((state) => state.settings.promptGroups);
  const targetProfiles = useNotesStore((state) => state.settings.targetProfiles);
  const defaultTargetProfileId = useNotesStore(
    (state) => state.settings.defaultTargetProfileId
  );
  const firewallEnabled = useNotesStore(
    (state) => state.settings.firewallEnabled
  );
  const profileOverrideId = useTargetStore((state) => state.profileOverrideId);
  const profileOverrideTargetIdentity = useTargetStore(
    (state) => state.profileOverrideTargetIdentity
  );
  const profileOverrideNeedsConfirmation = useTargetStore(
    (state) => state.profileOverrideNeedsConfirmation
  );
  const targetIdentity = useMemo(() => targetProfileIdentity(snapshot), [snapshot]);

  useEffect(() => {
    if (
      shouldClearOpenQuickSwitchOverride({
        open: quickSwitchOpen,
        profileOverrideId,
        profileOverrideTargetIdentity,
        targetIdentity,
        profileOverrideNeedsConfirmation,
      })
    ) {
      clearTargetProfileOverride();
    }
  }, [
    profileOverrideId,
    profileOverrideNeedsConfirmation,
    profileOverrideTargetIdentity,
    quickSwitchOpen,
    targetIdentity,
  ]);

  const resolution = useMemo(
    () =>
      resolveTargetProfile({
        bundleId: snapshot?.bundleId,
        isTargetReady: status === "ready",
        targetIdentity,
        groups: promptGroups,
        profiles: targetProfiles,
        defaultProfileId: defaultTargetProfileId,
        temporaryProfileId: profileOverrideId,
        temporaryTargetIdentity: profileOverrideTargetIdentity,
        temporaryNeedsConfirmation: profileOverrideNeedsConfirmation,
        privacyCapabilityActive: firewallEnabled,
      }),
    [
      defaultTargetProfileId,
      firewallEnabled,
      profileOverrideId,
      profileOverrideTargetIdentity,
      profileOverrideNeedsConfirmation,
      promptGroups,
      snapshot?.bundleId,
      status,
      targetIdentity,
      targetProfiles,
    ]
  );
  const automaticResolution = useMemo(
    () =>
      resolveTargetProfile({
        bundleId: snapshot?.bundleId,
        isTargetReady: status === "ready",
        targetIdentity,
        groups: promptGroups,
        profiles: targetProfiles,
        defaultProfileId: defaultTargetProfileId,
        privacyCapabilityActive: firewallEnabled,
      }),
    [
      defaultTargetProfileId,
      firewallEnabled,
      promptGroups,
      snapshot?.bundleId,
      status,
      targetIdentity,
      targetProfiles,
    ]
  );
  const profileOverrideName = useMemo(
    () =>
      targetProfiles.find((profile) => profile.id === profileOverrideId)?.name ?? null,
    [profileOverrideId, targetProfiles]
  );
  const quickProfiles = useMemo(() => {
    const seen = new Set<string>();
    return [
      resolution.profile,
      automaticResolution.profile,
      ...targetProfiles,
    ]
      .filter((profile) => {
        if (seen.has(profile.id)) return false;
        seen.add(profile.id);
        return true;
      })
      .slice(0, 3)
      .map((profile) => toQuickProfile(profile, promptGroups));
  }, [
    automaticResolution.profile,
    promptGroups,
    resolution.profile,
    targetProfiles,
  ]);
  const makePermanent = useCallback(() => {
    const targetState = useTargetStore.getState();
    const settings = useNotesStore.getState().settings;
    const liveTargetIdentity = targetProfileIdentity(targetState.snapshot);
    const liveResolution = resolveTargetProfile({
      bundleId: targetState.snapshot?.bundleId,
      isTargetReady: targetState.status === "ready",
      targetIdentity: liveTargetIdentity,
      groups: settings.promptGroups,
      profiles: settings.targetProfiles,
      defaultProfileId: settings.defaultTargetProfileId,
      temporaryProfileId: targetState.profileOverrideId,
      temporaryTargetIdentity: targetState.profileOverrideTargetIdentity,
      temporaryNeedsConfirmation:
        targetState.profileOverrideNeedsConfirmation,
      privacyCapabilityActive: settings.firewallEnabled,
    });
    if (
      !canPermanentlyAssignTargetProfileOverride({
        targetBundleId: liveResolution.targetBundleId,
        targetIdentity: liveTargetIdentity,
        profileOverrideId: targetState.profileOverrideId,
        profileOverrideTargetIdentity:
          targetState.profileOverrideTargetIdentity,
        profileOverrideNeedsConfirmation:
          targetState.profileOverrideNeedsConfirmation,
        resolvedProfileId: liveResolution.profileId,
        resolvedSource: liveResolution.source,
        isTargetReady: liveResolution.isTargetReady,
      })
    ) {
      return;
    }

    const bundleId = liveResolution.targetBundleId;
    const overrideId = targetState.profileOverrideId;
    if (!bundleId || !overrideId) return;
    const selectedProfile = settings.targetProfiles.find(
      (profile) => profile.id === overrideId
    );
    if (!selectedProfile) return;

    applySettingsPatch({
      targetProfiles: assignTargetProfileBundle(
        settings.targetProfiles,
        bundleId,
        overrideId
      ),
    });
    const appliedProfiles = useNotesStore.getState().settings.targetProfiles;
    const appliedOwner = appliedProfiles.find(
      (profile) => profile.id === overrideId
    );
    const assignmentApplied = Boolean(
      appliedOwner?.bundleIds.includes(bundleId) &&
        appliedProfiles.every(
          (profile) =>
            profile.id === overrideId ||
            !profile.bundleIds.includes(bundleId)
        )
    );
    if (!assignmentApplied) return;

    clearTargetProfileOverride();
    tip(
      "ok",
      `以后发给 ${targetState.snapshot?.appName ?? "当前应用"} 将使用 ${selectedProfile.name}`
    );
  }, []);
  const editCurrentProfile = useCallback(() => {
    void api.openSettingsWindow();
    void emitTo("settings", SETTINGS_SECTION, {
      section: "target",
      targetProfileId: resolution.profileId,
    });
  }, [resolution.profileId]);

  return (
    <>
      <TargetLensView
        snapshot={snapshot}
        status={status}
        reason={reason}
        icon={icon}
        profileName={resolution.profile.name}
        promptGroupName={resolution.promptGroup.name}
        profileSource={resolution.source}
        profileId={resolution.profileId}
        defaultFormat={resolution.profile.defaultFormat}
        enterPolicy={resolution.profile.enterPolicy}
        keepPanel={resolution.profile.keepPanel}
        privacyCapabilityActive={resolution.privacyCapabilityActive}
        profileOverrideNeedsConfirmation={profileOverrideNeedsConfirmation}
        profileOverrideId={profileOverrideId}
        profileOverrideName={profileOverrideName}
        automaticProfileName={automaticResolution.profile.name}
        quickProfiles={quickProfiles}
        quickSwitchOpen={quickSwitchOpen}
        canMakePermanent={canPermanentlyAssignTargetProfileOverride({
          targetBundleId: resolution.targetBundleId,
          targetIdentity,
          profileOverrideId,
          profileOverrideTargetIdentity,
          profileOverrideNeedsConfirmation,
          resolvedProfileId: resolution.profileId,
          resolvedSource: resolution.source,
          isTargetReady: resolution.isTargetReady,
        })}
        onRefresh={() => void refreshTarget()}
        onConfirmProfile={confirmTargetProfileOverride}
        onSelectProfile={setTargetProfileOverride}
        onQuickSwitchOpenChange={setQuickSwitchOpen}
        onMakePermanent={makePermanent}
        onEditCurrentProfile={editCurrentProfile}
        onOpenActivity={() => setActivityOpen(true)}
        activityButtonRef={activityButtonRef}
      />
      <RecentDeliveryDrawer
        open={activityOpen}
        onOpenChange={setActivityOpen}
        returnFocusRef={activityButtonRef}
      />
    </>
  );
}
