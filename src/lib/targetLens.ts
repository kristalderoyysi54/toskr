import type {
  DeliveryFormat,
  EnterPolicy,
  TargetProfileResolutionSource,
} from "@/lib/targetProfiles";

export interface TargetLensDisclosureState {
  expanded: boolean;
}

export type TargetLensDisclosureAction =
  | { type: "toggle" }
  | { type: "dismiss" };

export const INITIAL_TARGET_LENS_DISCLOSURE_STATE: TargetLensDisclosureState = {
  expanded: false,
};

export function targetLensDisclosureStateAfter(
  state: TargetLensDisclosureState,
  action: TargetLensDisclosureAction
): TargetLensDisclosureState {
  switch (action.type) {
    case "toggle":
      return { expanded: !state.expanded };
    case "dismiss":
      return INITIAL_TARGET_LENS_DISCLOSURE_STATE;
  }
}

export function targetLensDetailsExpanded(
  state: TargetLensDisclosureState
): boolean {
  return state.expanded;
}

export const DELIVERY_FORMAT_LABEL: Record<DeliveryFormat, string> = {
  plain: "纯文本",
  code: "代码块",
};

export const ENTER_POLICY_LABEL: Record<
  EnterPolicy,
  { action: string; compact: string; summary: string }
> = {
  never: { action: "仅粘贴", compact: "不自动", summary: "不自动回车" },
  confirm: {
    action: "粘贴后询问是否回车",
    compact: "每次确认",
    summary: "回车前确认",
  },
  allow: { action: "粘贴并回车", compact: "自动", summary: "自动回车" },
};

/** 用户界面统一使用的粘贴后动作；自动按回车必须同时暴露风险。 */
export const ENTER_POLICY_STATUS_LABEL: Record<EnterPolicy, string> = {
  never: "从不按回车",
  confirm: "每次发送前确认",
  allow: "自动按回车 · 高风险",
};

/** 折叠态隐藏风险的具体原因；供 chevron 的 title/aria 拼接，解释警示圆点。 */
export function hiddenWarningReasons(input: {
  privacyCapabilityActive: boolean;
  enterPolicy: EnterPolicy;
  profileSource: TargetProfileResolutionSource;
}): string[] {
  const reasons: string[] = [];
  if (!input.privacyCapabilityActive) reasons.push("隐私检查已关闭");
  if (input.enterPolicy === "allow") reasons.push("自动回车已开启");
  if (input.profileSource === "conflict") reasons.push("方案存在重复绑定冲突");
  return reasons;
}

/** 匹配来源的唯一中文措辞（DeliveryTrack 与当前匹配卡共用，消费方可拼接上下文）。 */
export const TARGET_PROFILE_SOURCE_LABEL: Record<
  TargetProfileResolutionSource,
  string
> = {
  temporary: "仅本次手动选择",
  exact: "应用指定",
  fallback: "未识别应用的默认方案",
  conflict: "重复绑定冲突",
};

export interface QuickProfileOption {
  id: string;
  name: string;
  promptGroupId: string;
  promptGroupName: string;
  defaultFormat: DeliveryFormat;
  enterPolicy: EnterPolicy;
  keepPanel: boolean;
}

/**
 * 候选方案相对当前方案的差异摘要（快速切换列表副行）：只报不同的维度，
 * 避免整串参数复读；参数完全一致时返回空数组（渲染层显示「与当前参数相同」）。
 * 自动回车是高风险差异，措辞必须完整携带风险标注。
 */
export function profileDiffSummary(
  profile: QuickProfileOption,
  current: QuickProfileOption
): string[] {
  const diffs: string[] = [];
  if (profile.promptGroupName !== current.promptGroupName) {
    diffs.push(`提示词组改为${profile.promptGroupName}`);
  }
  if (profile.defaultFormat !== current.defaultFormat) {
    diffs.push(`输出改为${DELIVERY_FORMAT_LABEL[profile.defaultFormat]}`);
  }
  if (profile.enterPolicy !== current.enterPolicy) {
    diffs.push(`粘贴后改为${ENTER_POLICY_STATUS_LABEL[profile.enterPolicy]}`);
  }
  if (profile.keepPanel !== current.keepPanel) {
    diffs.push(profile.keepPanel ? "完成后保持打开" : "完成后关闭面板");
  }
  return diffs;
}

export type QuickSwitchKeyboardCommand =
  | { type: "move"; index: number }
  | { type: "select"; index: number }
  | { type: "close" }
  | null;

export function quickSwitchKeyboardCommand(
  key: string,
  activeIndex: number,
  count: number
): QuickSwitchKeyboardCommand {
  if (key === "Escape") return { type: "close" };
  if (count === 0) return null;
  if (key === "ArrowDown") {
    return { type: "move", index: (activeIndex + 1 + count) % count };
  }
  if (key === "ArrowUp") {
    return { type: "move", index: (activeIndex - 1 + count) % count };
  }
  if (key === "Enter") {
    return { type: "select", index: Math.max(0, Math.min(activeIndex, count - 1)) };
  }
  return null;
}

export function shouldClearOpenQuickSwitchOverride(input: {
  open: boolean;
  profileOverrideId: string | null;
  profileOverrideTargetIdentity: string | null;
  targetIdentity: string | null;
  profileOverrideNeedsConfirmation: boolean;
}): boolean {
  return Boolean(
    input.open &&
      input.profileOverrideId &&
      (input.profileOverrideNeedsConfirmation ||
        !input.targetIdentity ||
        input.profileOverrideTargetIdentity !== input.targetIdentity)
  );
}

export function canPermanentlyAssignTargetProfileOverride(input: {
  targetBundleId: string | null;
  targetIdentity: string | null;
  profileOverrideId: string | null;
  profileOverrideTargetIdentity: string | null;
  profileOverrideNeedsConfirmation: boolean;
  resolvedProfileId: string;
  resolvedSource: "temporary" | "exact" | "fallback" | "conflict";
  isTargetReady: boolean;
}): boolean {
  return Boolean(
    input.isTargetReady &&
      input.targetBundleId &&
      input.targetIdentity &&
      input.profileOverrideId &&
      !input.profileOverrideNeedsConfirmation &&
      input.profileOverrideTargetIdentity === input.targetIdentity &&
      input.resolvedSource === "temporary" &&
      input.resolvedProfileId === input.profileOverrideId
  );
}
