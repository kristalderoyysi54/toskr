import type { DeliveryFormat, EnterPolicy } from "@/lib/targetProfiles";

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

export interface QuickProfileOption {
  id: string;
  name: string;
  promptGroupName: string;
  defaultFormat: DeliveryFormat;
  enterPolicy: EnterPolicy;
  keepPanel: boolean;
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
