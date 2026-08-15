import { create } from "zustand";

import { api, type TargetReason, type TargetSnapshot } from "@/lib/tauri";
import type { AppIconInfo } from "@/lib/icons";
import type { TargetRuleOverrides } from "@/lib/targetProfiles";

export type TargetStatus = "unknown" | "refreshing" | "ready" | "blocked";
export type TargetStateReason = TargetReason | "refresh_failed" | null;

interface TargetState {
  snapshot: TargetSnapshot | null;
  status: TargetStatus;
  reason: TargetStateReason;
  lastUpdatedAt: number | null;
  icon: AppIconInfo | null;
  observationPending: boolean;
  /** 下一次成功发送前的临时 Profile 覆盖；永不持久化。 */
  profileOverrideId: string | null;
  profileOverrideTargetIdentity: string | null;
  profileOverrideNeedsConfirmation: boolean;
  /** 单条规则的本次覆盖（透镜条行内快捷切换）；换目标/换方案即失效，永不持久化。 */
  ruleOverrides: TargetRuleOverrides;
  ruleOverridesTargetIdentity: string | null;
}

const INITIAL_TARGET_STATE: TargetState = {
  snapshot: null,
  status: "unknown",
  reason: null,
  lastUpdatedAt: null,
  icon: null,
  observationPending: false,
  profileOverrideId: null,
  profileOverrideTargetIdentity: null,
  profileOverrideNeedsConfirmation: false,
  ruleOverrides: {},
  ruleOverridesTargetIdentity: null,
};

export const useTargetStore = create<TargetState>()(() => INITIAL_TARGET_STATE);

let refreshGeneration = 0;
let iconGeneration = 0;
let latestTargetRevision = 0;
const iconCache = new Map<string, Promise<AppIconInfo | null>>();

function statusOf(snapshot: TargetSnapshot): TargetStatus {
  return snapshot.ready ? "ready" : "blocked";
}

export function targetProfileIdentity(snapshot: TargetSnapshot | null): string | null {
  if (!snapshot?.bundleId || snapshot.pid === null || snapshot.launchedAtMs === null) {
    return null;
  }
  return `${snapshot.bundleId}:${snapshot.pid}:${snapshot.launchedAtMs}`;
}

/** capturedAt 只是观测时钟；相同目标的重复事件不得制造渲染或图标风暴。 */
function sameTarget(a: TargetSnapshot | null, b: TargetSnapshot): boolean {
  return !!a &&
    a.token === b.token &&
    a.pid === b.pid &&
    a.bundleId === b.bundleId &&
    a.appName === b.appName &&
    a.launchedAtMs === b.launchedAtMs &&
    a.ready === b.ready &&
    a.reason === b.reason &&
    a.windowId === b.windowId;
}

function loadIcon(bundleId: string): Promise<AppIconInfo | null> {
  let pending = iconCache.get(bundleId);
  if (!pending) {
    pending = api.appIcon(bundleId).catch(() => null);
    iconCache.set(bundleId, pending);
    // 只长期缓存成功结果：null（瞬时取不到/IPC 失败）会把该 bundle 的
    // logo 永久钉死在兜底图标上——下一次目标事件应当重试
    void pending.then((loaded) => {
      if (loaded === null && iconCache.get(bundleId) === pending) {
        iconCache.delete(bundleId);
      }
    });
  }
  return pending;
}

function commitSnapshot(snapshot: TargetSnapshot): boolean {
  if (snapshot.revision < latestTargetRevision) return false;
  latestTargetRevision = Math.max(latestTargetRevision, snapshot.revision);
  const current = useTargetStore.getState();
  const status = statusOf(snapshot);
  const reason = snapshot.reason;
  if (
    sameTarget(current.snapshot, snapshot) &&
    current.status === status &&
    current.reason === reason
  ) {
    return false;
  }

  const sameBundle = current.snapshot?.bundleId === snapshot.bundleId;
  const icon = sameBundle ? current.icon : null;
  const nextProfileTargetIdentity = targetProfileIdentity(snapshot);
  const profileTargetChanged =
    !!current.profileOverrideId &&
    current.profileOverrideTargetIdentity !== null &&
    current.profileOverrideTargetIdentity !== nextProfileTargetIdentity;
  useTargetStore.setState({
    snapshot,
    status,
    reason,
    lastUpdatedAt: Date.now(),
    icon,
    observationPending:
      !snapshot.ready && snapshot.reason === "target_not_frontmost",
    profileOverrideNeedsConfirmation:
      current.profileOverrideNeedsConfirmation || profileTargetChanged,
  });

  const bundleId = snapshot.bundleId;
  const generation = ++iconGeneration;
  if (!bundleId || (sameBundle && current.icon)) return true;
  void loadIcon(bundleId).then((loaded) => {
    const latest = useTargetStore.getState();
    if (
      generation !== iconGeneration ||
      latest.snapshot?.bundleId !== bundleId ||
      latest.icon === loaded
    ) {
      return;
    }
    useTargetStore.setState({ icon: loaded });
  });
  return true;
}

/** Rust 目标变化事件入口。事件比在途 IPC 更新，故先作废旧刷新。 */
export function applyTargetEvent(snapshot: TargetSnapshot): boolean {
  if (snapshot.revision < latestTargetRevision) return false;
  refreshGeneration += 1;
  return commitSnapshot(snapshot);
}

/** blur handler 同步调用；在任何 IPC/计时器运行前先阻止所有发送入口。 */
export function beginTargetBlurObservation(): void {
  refreshGeneration += 1;
  useTargetStore.setState({
    status: "refreshing",
    reason: null,
    observationPending: true,
    lastUpdatedAt: Date.now(),
  });
}

/**
 * 面板失焦即同步进入 fail-closed；Native 会在同一命令中采样 frontmost。
 * 若采样已经回到 Toskr，自身 pending 会一直保留到更晚的非自身 observation。
 */
export async function observeTargetAfterBlur(): Promise<TargetSnapshot | null> {
  const generation = ++refreshGeneration;
  useTargetStore.setState({
    status: "refreshing",
    reason: null,
    observationPending: true,
    lastUpdatedAt: Date.now(),
  });
  try {
    const snapshot = await api.refreshPrevApp();
    if (generation !== refreshGeneration) return null;
    if (snapshot.revision < latestTargetRevision) return null;
    commitSnapshot(snapshot);
    return snapshot;
  } catch {
    if (generation !== refreshGeneration) return null;
    useTargetStore.setState({
      status: "blocked",
      reason: "refresh_failed",
      observationPending: true,
      lastUpdatedAt: Date.now(),
    });
    return null;
  }
}

/** 独立窗口只读同步：受同一代际保护，但绝不轮换 Native target token。 */
export async function readTarget(): Promise<TargetSnapshot | null> {
  const generation = ++refreshGeneration;
  useTargetStore.setState({ status: "refreshing", reason: null });
  try {
    const snapshot = await api.getTargetSnapshot();
    if (generation !== refreshGeneration) return null;
    if (snapshot.revision < latestTargetRevision) return null;
    commitSnapshot(snapshot);
    return snapshot;
  } catch {
    if (generation !== refreshGeneration) return null;
    useTargetStore.setState({
      status: "blocked",
      reason: "refresh_failed",
      lastUpdatedAt: Date.now(),
    });
    return null;
  }
}

/** 面板打开、恢复、重新识别和发送前共用；乱序响应只允许最新一次落地。 */
export async function refreshTarget(): Promise<TargetSnapshot | null> {
  if (targetObservationPending()) return observeTargetAfterBlur();
  const generation = ++refreshGeneration;
  useTargetStore.setState({ status: "refreshing", reason: null });
  try {
    const snapshot = await api.refreshTargetSnapshot();
    if (generation !== refreshGeneration) return null;
    if (snapshot.revision < latestTargetRevision) return null;
    commitSnapshot(snapshot);
    return snapshot;
  } catch {
    if (generation !== refreshGeneration) return null;
    useTargetStore.setState({
      status: "blocked",
      reason: "refresh_failed",
      lastUpdatedAt: Date.now(),
    });
    return null;
  }
}

export function targetSendDisabled(): boolean {
  return useTargetStore.getState().status !== "ready";
}

export function targetObservationPending(): boolean {
  return useTargetStore.getState().observationPending;
}

export function setTargetProfileOverride(profileId: string | null): void {
  const snapshot = useTargetStore.getState().snapshot;
  useTargetStore.setState({
    profileOverrideId: profileId,
    profileOverrideTargetIdentity: profileId
      ? targetProfileIdentity(snapshot)
      : null,
    profileOverrideNeedsConfirmation: false,
    // 换整套方案 = 从该方案的默认规则重新开始，行内单条覆盖一并清空
    ruleOverrides: {},
    ruleOverridesTargetIdentity: null,
  });
}

/** 行内快捷切换单条规则：与解析基线相同的值由解析层自动视为未覆盖。 */
export function setTargetRuleOverride(patch: TargetRuleOverrides): void {
  const current = useTargetStore.getState();
  const identity = targetProfileIdentity(current.snapshot);
  if (!identity) return;
  const base =
    current.ruleOverridesTargetIdentity === identity ? current.ruleOverrides : {};
  useTargetStore.setState({
    ruleOverrides: { ...base, ...patch },
    ruleOverridesTargetIdentity: identity,
  });
}

export function clearTargetRuleOverrides(): void {
  useTargetStore.setState({ ruleOverrides: {}, ruleOverridesTargetIdentity: null });
}

export function clearTargetProfileOverride(): void {
  setTargetProfileOverride(null);
}

export function confirmTargetProfileOverride(): void {
  const current = useTargetStore.getState();
  if (!current.profileOverrideId) return;
  useTargetStore.setState({
    profileOverrideTargetIdentity: targetProfileIdentity(current.snapshot),
    profileOverrideNeedsConfirmation: false,
  });
}

/** token 可在同一目标刷新时变化；用户确认边界只比较实际进程/窗口身份。 */
export function sameTargetIdentity(
  visible: TargetSnapshot | null,
  refreshed: TargetSnapshot
): boolean {
  return !!visible &&
    visible.pid === refreshed.pid &&
    visible.bundleId === refreshed.bundleId &&
    visible.launchedAtMs === refreshed.launchedAtMs &&
    visible.windowId === refreshed.windowId;
}

export function targetStatusLabel(status: TargetStatus): string {
  switch (status) {
    case "refreshing":
      return "正在确认";
    case "ready":
      return "可发送";
    case "blocked":
      return "目标已失效";
    default:
      return "尚未识别";
  }
}

export function targetReasonLabel(reason: TargetStateReason): string {
  switch (reason) {
    case "target_token_missing":
    case "target_token_stale":
      return "目标凭据已过期，请重新识别";
    case "target_exited":
      return "目标应用已退出，请重新识别";
    case "target_bundle_mismatch":
    case "target_process_mismatch":
      return "目标应用身份已变化，请重新识别";
    case "target_identity_unavailable":
      return "无法验证目标身份，请切回目标后重试";
    case "target_not_frontmost":
      return "目标应用已不在前台，请重新识别";
    case "refresh_failed":
      return "目标确认失败，请重新识别";
    case "target_missing":
    default:
      return "尚未识别发送目标，请先重新识别";
  }
}

export function targetBlockMessage(
  status: TargetStatus,
  reason: TargetStateReason
): string {
  if (status === "refreshing") return "正在确认发送目标，请稍候";
  return targetReasonLabel(reason);
}

export function currentTargetBlockMessage(): string {
  const { status, reason } = useTargetStore.getState();
  return targetBlockMessage(status, reason);
}

/** 会话边界重置；不落盘，不触碰选择、草稿或停靠设置。 */
export function resetTargetState(): void {
  refreshGeneration += 1;
  iconGeneration += 1;
  latestTargetRevision = 0;
  iconCache.clear();
  useTargetStore.setState(INITIAL_TARGET_STATE, true);
}
