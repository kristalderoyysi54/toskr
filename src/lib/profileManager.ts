import {
  resolveTargetProfile,
  type DeliveryFormat,
  type EnterPolicy,
  type PrivacyPolicy,
  type PromptGroup,
  type PromptSnippet,
  type TargetProfile,
  type TargetProfileResolution,
} from "@/lib/targetProfiles";
import type { TargetSnapshot } from "@/lib/tauri";

const TOSKR_BUNDLE_ID = "com.toskr.app";

/**
 * 设置窗口只保留最近一次单调递增的目标观测；较旧 IPC 响应不得覆盖更新事件。
 * Toskr 自身回到前台时保留最近外部应用身份，但立即标记为不可用。
 */
export function settingsTargetAfterObservation(
  previous: TargetSnapshot | null,
  incoming: TargetSnapshot
): TargetSnapshot {
  if (previous && incoming.revision < previous.revision) return previous;
  if (incoming.bundleId && incoming.bundleId !== TOSKR_BUNDLE_ID) return incoming;
  if (!previous?.bundleId) return incoming;
  return {
    ...previous,
    token: incoming.token,
    ready: false,
    reason: incoming.reason ?? "target_missing",
    capturedAtMs: incoming.capturedAtMs,
    revision: incoming.revision,
  };
}

export type ProfilePresetId = "safe" | "ai" | "terminal" | "custom";

export interface ProfilePreset {
  id: ProfilePresetId;
  name: string;
  description: string;
  defaultFormat: DeliveryFormat;
  enterPolicy: EnterPolicy;
  privacyPolicy: PrivacyPolicy;
  keepPanel: boolean;
}

export const PROFILE_PRESETS: readonly ProfilePreset[] = [
  {
    id: "safe",
    name: "稳妥投递",
    description: "纯文本粘贴，不自动按回车",
    defaultFormat: "plain",
    enterPolicy: "never",
    privacyPolicy: "requireRedaction",
    keepPanel: false,
  },
  {
    id: "ai",
    name: "AI 对话",
    description: "纯文本输出，每次确认后再按回车",
    defaultFormat: "plain",
    enterPolicy: "confirm",
    privacyPolicy: "confirmRaw",
    keepPanel: true,
  },
  {
    id: "terminal",
    name: "终端只粘贴",
    description: "代码格式粘贴，绝不自动执行",
    defaultFormat: "code",
    enterPolicy: "never",
    privacyPolicy: "requireRedaction",
    keepPanel: false,
  },
  {
    id: "custom",
    name: "自定义",
    description: "从安全的空白方案开始配置",
    defaultFormat: "plain",
    enterPolicy: "never",
    privacyPolicy: "requireRedaction",
    keepPanel: false,
  },
] as const;

export const DELIVERY_FORMAT_OPTIONS: readonly {
  value: DeliveryFormat;
  label: string;
  description: string;
  example: string;
}[] = [
  {
    value: "plain",
    label: "纯文本",
    description: "保持内容自然排版，适合聊天与文档应用。",
    example: "示例：这是准备投递的内容。",
  },
  {
    value: "code",
    label: "代码块",
    description: "用代码围栏包裹文本，适合开发工具与终端记录。",
    example: "示例：```\ncommand --help\n```",
  },
] as const;

export const ENTER_POLICY_OPTIONS: readonly {
  value: EnterPolicy;
  label: string;
  risk: string;
}[] = [
  {
    value: "never",
    label: "从不按回车",
    risk: "只完成粘贴，由你在目标应用中检查后提交。",
  },
  {
    value: "confirm",
    label: "每次发送前确认",
    risk: "发送前询问；确认后才会在粘贴后模拟回车。",
  },
  {
    value: "allow",
    label: "自动按回车",
    risk: "内容会直接提交或执行，只适合明确可信的目标。",
  },
] as const;

export const PRIVACY_POLICY_OPTIONS: readonly {
  value: PrivacyPolicy;
  label: string;
}[] = [
  { value: "requireRedaction", label: "要求逐项处理" },
  { value: "confirmRaw", label: "提示项原文需确认" },
  { value: "allowRaw", label: "允许原文（高风险二次确认）" },
] as const;

export function shouldShowProfileSearch(profiles: TargetProfile[]): boolean {
  return profiles.length > 8;
}

export function profileListKeyboardIndex(
  key: string,
  currentIndex: number,
  count: number
): number | null {
  if (count <= 0) return null;
  if (key === "ArrowDown") return (currentIndex + 1 + count) % count;
  if (key === "ArrowUp") return (currentIndex - 1 + count) % count;
  return null;
}

export function profileFocusAfterDeleteId(
  visibleProfiles: TargetProfile[],
  deletedProfileId: string
): string | null {
  const index = visibleProfiles.findIndex((profile) => profile.id === deletedProfileId);
  if (index < 0) return null;
  return visibleProfiles[index + 1]?.id ?? visibleProfiles[index - 1]?.id ?? null;
}

export function profileSelectionAfterDelete(input: {
  profiles: TargetProfile[];
  defaultProfileId: string;
  privacyCapabilityActive?: boolean;
  deletedProfileId: string;
  selectedProfileId: string;
  nextVisibleProfileId: string | null;
}): string {
  if (
    input.selectedProfileId !== input.deletedProfileId &&
    input.profiles.some((profile) => profile.id === input.selectedProfileId)
  ) {
    return input.selectedProfileId;
  }
  return input.profiles.find(
    (profile) => profile.id === input.nextVisibleProfileId
  )?.id ?? input.defaultProfileId;
}

export function canReorderProfile(
  profiles: TargetProfile[],
  defaultProfileId: string,
  profileId: string,
  direction: -1 | 1
): boolean {
  return Boolean(
    reorderCandidate(profiles, defaultProfileId, profileId, direction)
  );
}

export interface ProfileReorderAvailability {
  id: string;
  up: boolean;
  down: boolean;
}

/** 列表一次计算全部排序状态，避免搜索、选择等重渲染逐行重复解析冲突。 */
export function profileReorderAvailability(
  profiles: TargetProfile[],
  defaultProfileId: string
): ProfileReorderAvailability[] {
  return profiles.map((profile) => ({
    id: profile.id,
    up: canReorderProfile(profiles, defaultProfileId, profile.id, -1),
    down: canReorderProfile(profiles, defaultProfileId, profile.id, 1),
  }));
}

function duplicateOwnerOrderIsStable(
  before: TargetProfile[],
  after: TargetProfile[]
): boolean {
  const bundleIds = new Set(before.flatMap((profile) => profile.bundleIds));
  for (const bundleId of bundleIds) {
    const previousOwners = before
      .filter((profile) => profile.bundleIds.includes(bundleId))
      .map((profile) => profile.id);
    if (previousOwners.length < 2) continue;
    const nextOwners = after
      .filter((profile) => profile.bundleIds.includes(bundleId))
      .map((profile) => profile.id);
    if (previousOwners.some((profileId, index) => nextOwners[index] !== profileId)) {
      return false;
    }
  }
  return true;
}

function reorderCandidate(
  profiles: TargetProfile[],
  defaultProfileId: string,
  profileId: string,
  direction: -1 | 1
): TargetProfile[] | null {
  if (profileId === defaultProfileId) return null;
  const movable = profiles.filter((profile) => profile.id !== defaultProfileId);
  const index = movable.findIndex((profile) => profile.id === profileId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= movable.length) return null;
  [movable[index], movable[targetIndex]] = [movable[targetIndex], movable[index]];
  let movableIndex = 0;
  const candidate = profiles.map((profile) =>
    profile.id === defaultProfileId ? profile : movable[movableIndex++]
  );
  return duplicateOwnerOrderIsStable(profiles, candidate) ? candidate : null;
}

/** 保留默认方案的存储位置；历史冲突 owner 不得通过排序改变稳定 winner。 */
export function reorderProfilesKeepingDefault(
  profiles: TargetProfile[],
  defaultProfileId: string,
  profileId: string,
  direction: -1 | 1
): TargetProfile[] {
  return reorderCandidate(
    profiles,
    defaultProfileId,
    profileId,
    direction
  ) ?? profiles;
}

/** 默认项仅在管理器视图中固定置顶；不重排持久化数组，保持历史冲突 winner。 */
export function filterAndPinProfiles(
  profiles: TargetProfile[],
  defaultProfileId: string,
  query: string
): TargetProfile[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = normalizedQuery
    ? profiles.filter((profile) =>
        [profile.name, ...profile.bundleIds].some((value) =>
          value.toLocaleLowerCase().includes(normalizedQuery)
        )
      )
    : profiles;
  const defaultProfile = visible.find((profile) => profile.id === defaultProfileId);
  if (!defaultProfile) return visible;
  return [defaultProfile, ...visible.filter((profile) => profile.id !== defaultProfileId)];
}

export function createProfileFromPreset(input: {
  id: string;
  presetId: ProfilePresetId;
  name: string;
  promptGroupId: string;
  bundleId?: string | null;
}): TargetProfile {
  const preset = PROFILE_PRESETS.find((item) => item.id === input.presetId) ?? PROFILE_PRESETS[3];
  const bundleId = input.bundleId?.trim();
  return {
    id: input.id,
    name: input.name.trim() || preset.name,
    bundleIds: bundleId ? [bundleId] : [],
    promptGroupId: input.promptGroupId,
    defaultFormat: preset.defaultFormat,
    enterPolicy: preset.enterPolicy,
    privacyPolicy: preset.privacyPolicy,
    keepPanel: preset.keepPanel,
  };
}

export interface PromptGroupOptionSummary {
  value: string;
  label: string;
  count: number;
  summary: string;
}

export function formatPromptGroupOption(
  group: PromptGroup,
  snippets: PromptSnippet[]
): PromptGroupOptionSummary {
  const matching = snippets.filter((snippet) => snippet.groupId === group.id);
  const summary = matching
    .slice(0, 2)
    .map((snippet) => snippet.label.trim() || snippet.text.trim())
    .filter(Boolean)
    .join("、") || "暂无提示词";
  return {
    value: group.id,
    label: `${group.name} · ${matching.length} 条 · ${summary}`,
    count: matching.length,
    summary,
  };
}

/** 编辑器效果预览使用临时覆盖契约，解析优先级仍完全由唯一 resolver 决定。 */
export function previewSelectedProfile(input: {
  bundleId: string | null;
  isTargetReady: boolean;
  selectedProfileId: string;
  profiles: TargetProfile[];
  groups: PromptGroup[];
  defaultProfileId: string;
  privacyCapabilityActive?: boolean;
}): TargetProfileResolution {
  const targetIdentity = `settings-preview:${input.bundleId ?? "missing"}`;
  return resolveTargetProfile({
    bundleId: input.bundleId,
    isTargetReady: input.isTargetReady,
    targetIdentity,
    groups: input.groups,
    profiles: input.profiles,
    defaultProfileId: input.defaultProfileId,
    temporaryProfileId: input.selectedProfileId,
    temporaryTargetIdentity: targetIdentity,
    privacyCapabilityActive: input.privacyCapabilityActive,
  });
}

export function buildAppMoveQuestion(
  appName: string,
  sourceProfileName: string,
  targetProfileName: string
): string {
  return `${appName} 当前属于“${sourceProfileName}”，是否移动到“${targetProfileName}”？`;
}
