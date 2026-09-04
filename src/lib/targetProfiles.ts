export type DeliveryFormat = "plain" | "code";
export type MarkdownSendMode = "preserve" | "strip";
/** 设置页的三态视图；底层仍保持格式包装与 Markdown 转换两个正交字段。 */
export type DeliveryOutputMode = DeliveryFormat | "strip-markdown";
export type EnterPolicy = "never" | "confirm" | "allow";
export type PrivacyPolicy = "requireRedaction" | "confirmRaw" | "allowRaw";

export interface PromptGroup {
  id: string;
  name: string;
  order: number;
}

export interface PromptSnippet {
  id: string;
  label: string;
  text: string;
  groupId: string;
}

export interface TargetProfile {
  id: string;
  name: string;
  bundleIds: string[];
  promptGroupId: string;
  defaultFormat: DeliveryFormat;
  defaultMarkdownMode: MarkdownSendMode;
  enterPolicy: EnterPolicy;
  privacyPolicy: PrivacyPolicy;
  keepPanel: boolean;
}

export const GENERAL_PROMPT_GROUP_ID = "general";
export const SAFETY_PROFILE_ID = "default-safe";
export const TERMINAL_PROFILE_ID = "terminal-safe";

/** 只复用仓库原有伴随列表中的明确终端 bundle，不推测第三方标识。 */
export const TERMINAL_BUNDLE_IDS = [
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "com.github.wez.wezterm",
  "net.kovidgoyal.kitty",
  "io.alacritty",
  "com.mitchellh.ghostty",
] as const;

const SAFETY_PROFILE: TargetProfile = {
  id: SAFETY_PROFILE_ID,
  name: "稳妥发送",
  bundleIds: [],
  promptGroupId: GENERAL_PROMPT_GROUP_ID,
  defaultFormat: "plain",
  defaultMarkdownMode: "preserve",
  enterPolicy: "never",
  privacyPolicy: "requireRedaction",
  keepPanel: false,
};

export function createDefaultPromptGroups(): PromptGroup[] {
  return [{ id: GENERAL_PROMPT_GROUP_ID, name: "通用", order: 0 }];
}

export function createDefaultTargetProfiles(
  legacyAutoEnter = false
): TargetProfile[] {
  return [
    {
      ...SAFETY_PROFILE,
      enterPolicy: legacyAutoEnter ? "confirm" : "never",
    },
    {
      id: TERMINAL_PROFILE_ID,
      name: "终端（安全）",
      bundleIds: [...TERMINAL_BUNDLE_IDS],
      promptGroupId: GENERAL_PROMPT_GROUP_ID,
      defaultFormat: "code",
      defaultMarkdownMode: "preserve",
      enterPolicy: "never",
      privacyPolicy: "requireRedaction",
      keepPanel: false,
    },
  ];
}

export type TargetProfileResolutionSource =
  | "temporary"
  | "exact"
  | "fallback"
  | "conflict";

export type TargetProfileResolutionReason =
  | "temporary_override"
  | "temporary_target_changed"
  | "exact_bundle_match"
  | "duplicate_bundle_conflict"
  | "fallback_default"
  | "target_missing"
  | "target_unavailable";

/**
 * 单条规则的本次覆盖（叠加于解析出的方案之上）：透镜条「本次生效规则」行内
 * 快捷切换写入，换目标即失效，永不持久化。隐私策略不在覆盖范围（高风险项
 * 不做一键降级，仍走「编辑方案」）。
 */
export interface TargetRuleOverrides {
  promptGroupId?: string;
  defaultOutputMode?: DeliveryOutputMode;
  enterPolicy?: EnterPolicy;
  keepPanel?: boolean;
}

export type TargetRuleOverrideKey = keyof TargetRuleOverrides;

export function targetProfileOutputMode(
  profile: Pick<TargetProfile, "defaultFormat" | "defaultMarkdownMode">
): DeliveryOutputMode {
  return profile.defaultFormat === "plain" && profile.defaultMarkdownMode === "strip"
    ? "strip-markdown"
    : profile.defaultFormat;
}

export function targetProfileOutputPatch(
  mode: DeliveryOutputMode
): Pick<TargetProfile, "defaultFormat" | "defaultMarkdownMode"> {
  if (mode === "strip-markdown") {
    return { defaultFormat: "plain", defaultMarkdownMode: "strip" };
  }
  return { defaultFormat: mode, defaultMarkdownMode: "preserve" };
}

export interface TargetProfileResolution {
  profileId: string;
  profile: TargetProfile;
  promptGroup: PromptGroup;
  source: TargetProfileResolutionSource;
  targetBundleId: string | null;
  reason: TargetProfileResolutionReason;
  isTargetReady: boolean;
  privacyCapabilityActive: boolean;
  safetyClamped: boolean;
  duplicateBundleProfileIds: string[];
  /** 实际生效的规则覆盖键（与基线不同才计入）；空数组 = 无覆盖。 */
  ruleOverriddenKeys: TargetRuleOverrideKey[];
}

export function resolveTargetProfile(input: {
  bundleId: string | null | undefined;
  isTargetReady: boolean;
  targetIdentity?: string | null;
  groups: PromptGroup[];
  profiles: TargetProfile[];
  defaultProfileId: string;
  temporaryProfileId?: string | null;
  temporaryTargetIdentity?: string | null;
  temporaryNeedsConfirmation?: boolean;
  privacyCapabilityActive?: boolean;
  /** 规则级本次覆盖；身份与 targetIdentity 不一致时整组忽略。 */
  ruleOverrides?: TargetRuleOverrides | null;
  ruleOverridesTargetIdentity?: string | null;
}): TargetProfileResolution {
  const targetBundleId = input.bundleId ?? null;
  const isTargetReady = Boolean(
    input.isTargetReady && targetBundleId
  );
  const requestedTemporary = input.temporaryProfileId
    ? input.profiles.find((item) => item.id === input.temporaryProfileId)
    : undefined;
  const temporaryTargetMatches = Boolean(
    requestedTemporary &&
      !input.temporaryNeedsConfirmation &&
      input.targetIdentity &&
      input.temporaryTargetIdentity &&
      input.targetIdentity === input.temporaryTargetIdentity
  );
  const temporary = temporaryTargetMatches ? requestedTemporary : undefined;
  const bundleMatches = targetBundleId
    ? input.profiles.filter((item) => item.bundleIds.includes(targetBundleId))
    : [];
  const configuredDefault = input.profiles.find(
    (item) => item.id === input.defaultProfileId
  );

  let source: TargetProfileResolutionSource = "fallback";
  let reason: TargetProfileResolutionReason = targetBundleId
    ? "fallback_default"
    : "target_missing";
  let profile = SAFETY_PROFILE;
  if (temporary) {
    source = "temporary";
    reason = "temporary_override";
    profile = temporary;
  } else if (bundleMatches[0]) {
    source = bundleMatches.length > 1 ? "conflict" : "exact";
    reason = bundleMatches.length > 1
      ? "duplicate_bundle_conflict"
      : "exact_bundle_match";
    profile = bundleMatches[0];
  } else if (configuredDefault) {
    profile = configuredDefault;
  }
  if (requestedTemporary && !temporaryTargetMatches) {
    reason = "temporary_target_changed";
  }

  // 未命中明确 bundle 时，默认 Profile 仍可提供分组/格式，但不得自动放宽
  // 粘贴后动作或隐私预设。只有用户本次显式覆盖才允许高风险值生效。
  const safetyClamped =
    source === "fallback" &&
    (profile.enterPolicy !== "never" ||
      profile.privacyPolicy !== "requireRedaction");
  if (source === "fallback") {
    profile = {
      ...profile,
      enterPolicy: "never",
      privacyPolicy: "requireRedaction",
    };
  }

  // 规则级本次覆盖：在安全钳制之后应用——钳制注释言明「只有用户本次显式覆盖
  // 才允许高风险值生效」，行内快捷切换正是该显式覆盖。身份不符整组失效。
  const ruleOverriddenKeys: TargetRuleOverrideKey[] = [];
  const rules =
    input.ruleOverrides &&
    input.targetIdentity &&
    input.ruleOverridesTargetIdentity === input.targetIdentity
      ? input.ruleOverrides
      : null;
  if (rules) {
    if (
      rules.promptGroupId !== undefined &&
      rules.promptGroupId !== profile.promptGroupId &&
      input.groups.some((item) => item.id === rules.promptGroupId)
    ) {
      profile = { ...profile, promptGroupId: rules.promptGroupId };
      ruleOverriddenKeys.push("promptGroupId");
    }
    if (
      rules.defaultOutputMode !== undefined &&
      rules.defaultOutputMode !== targetProfileOutputMode(profile)
    ) {
      profile = { ...profile, ...targetProfileOutputPatch(rules.defaultOutputMode) };
      ruleOverriddenKeys.push("defaultOutputMode");
    }
    if (
      rules.enterPolicy !== undefined &&
      rules.enterPolicy !== profile.enterPolicy
    ) {
      profile = { ...profile, enterPolicy: rules.enterPolicy };
      ruleOverriddenKeys.push("enterPolicy");
    }
    if (rules.keepPanel !== undefined && rules.keepPanel !== profile.keepPanel) {
      profile = { ...profile, keepPanel: rules.keepPanel };
      ruleOverriddenKeys.push("keepPanel");
    }
  }

  const promptGroup =
    input.groups.find((item) => item.id === profile.promptGroupId) ??
    input.groups.find((item) => item.id === GENERAL_PROMPT_GROUP_ID) ??
    createDefaultPromptGroups()[0];

  if (!isTargetReady) {
    reason = targetBundleId ? "target_unavailable" : "target_missing";
  }

  return {
    profileId: profile.id,
    profile: { ...profile, bundleIds: [...profile.bundleIds] },
    promptGroup,
    source,
    targetBundleId,
    reason,
    isTargetReady,
    privacyCapabilityActive: input.privacyCapabilityActive ?? false,
    safetyClamped,
    duplicateBundleProfileIds: bundleMatches.map((item) => item.id),
    ruleOverriddenKeys,
  };
}

export interface TargetProfileConfiguration {
  groups: PromptGroup[];
  snippets: PromptSnippet[];
  profiles: TargetProfile[];
  defaultProfileId: string;
}

export interface DuplicateBundleAssignment {
  bundleId: string;
  profileIds: string[];
  profileNames: string[];
}

export interface TargetProfileBundleUpdate {
  profiles: TargetProfile[];
  blockedBundleIds: string[];
}

/**
 * 设置页唯一的应用绑定编辑入口：历史重复项原样保留，只有本次新增且已被
 * 其他方案占用的 bundle 会被拒绝。这样不会静默改写旧数据，也不会继续制造冲突。
 */
export function updateTargetProfileBundleIds(
  profiles: TargetProfile[],
  profileId: string,
  requestedBundleIds: string[]
): TargetProfileBundleUpdate {
  const current = profiles.find((profile) => profile.id === profileId);
  if (!current) return { profiles, blockedBundleIds: [] };

  const currentBundleIds = new Set(current.bundleIds);
  const ownedByOtherProfiles = new Set(
    profiles
      .filter((profile) => profile.id !== profileId)
      .flatMap((profile) => profile.bundleIds)
  );
  const requested = [...new Set(requestedBundleIds.map((item) => item.trim()).filter(Boolean))];
  const blockedBundleIds = requested.filter(
    (bundleId) =>
      !currentBundleIds.has(bundleId) && ownedByOtherProfiles.has(bundleId)
  );
  const blocked = new Set(blockedBundleIds);
  const bundleIds = requested.filter((bundleId) => !blocked.has(bundleId));

  return {
    profiles: profiles.map((profile) =>
      profile.id === profileId ? { ...profile, bundleIds } : profile
    ),
    blockedBundleIds,
  };
}

/**
 * 主面板“以后使用”的显式永久重绑入口。用户已经确认改变行为，因此把目标
 * bundle 从其他方案移除，再加入所选方案；不触碰任何无关绑定或方案顺序。
 */
export function assignTargetProfileBundle(
  profiles: TargetProfile[],
  bundleId: string,
  profileId: string
): TargetProfile[] {
  const normalizedBundleId = bundleId.trim();
  if (
    !normalizedBundleId ||
    !profiles.some((profile) => profile.id === profileId)
  ) {
    return profiles;
  }

  let changed = false;
  const next = profiles.map((profile) => {
    if (profile.id === profileId) {
      if (profile.bundleIds.includes(normalizedBundleId)) return profile;
      changed = true;
      return {
        ...profile,
        bundleIds: [...profile.bundleIds, normalizedBundleId],
      };
    }
    if (!profile.bundleIds.includes(normalizedBundleId)) return profile;
    changed = true;
    return {
      ...profile,
      bundleIds: profile.bundleIds.filter((item) => item !== normalizedBundleId),
    };
  });
  return changed ? next : profiles;
}

/** 用户显式裁决历史冲突：保留所选方案的绑定，其他方案只移除该 bundle。 */
export function keepTargetProfileBundleAssignment(
  profiles: TargetProfile[],
  bundleId: string,
  profileId: string
): TargetProfile[] {
  const selected = profiles.find((profile) => profile.id === profileId);
  if (!selected?.bundleIds.includes(bundleId)) return profiles;
  return profiles.map((profile) =>
    profile.id === profileId || !profile.bundleIds.includes(bundleId)
      ? profile
      : {
          ...profile,
          bundleIds: profile.bundleIds.filter((item) => item !== bundleId),
        }
  );
}

export function findDuplicateBundleAssignments(
  profiles: TargetProfile[]
): DuplicateBundleAssignment[] {
  const owners = new Map<string, TargetProfile[]>();
  for (const profile of profiles) {
    for (const bundleId of new Set(profile.bundleIds)) {
      const list = owners.get(bundleId) ?? [];
      list.push(profile);
      owners.set(bundleId, list);
    }
  }
  return [...owners.entries()]
    .filter(([, list]) => list.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bundleId, list]) => ({
      bundleId,
      profileIds: list.map((item) => item.id),
      profileNames: list.map((item) => item.name),
    }));
}

export function promptSnippetsForGroup(
  snippets: PromptSnippet[],
  groupId: string
): { prioritized: PromptSnippet[]; remaining: PromptSnippet[] } {
  return {
    prioritized: snippets.filter((item) => item.groupId === groupId),
    remaining: snippets.filter((item) => item.groupId !== groupId),
  };
}

export function repairTargetProfileConfiguration(
  input: TargetProfileConfiguration
): TargetProfileConfiguration {
  const groups = input.groups.some(
    (item) => item.id === GENERAL_PROMPT_GROUP_ID
  )
    ? input.groups
    : [createDefaultPromptGroups()[0], ...input.groups];
  const groupIds = new Set(groups.map((item) => item.id));
  const snippets = input.snippets.map((item) =>
    groupIds.has(item.groupId)
      ? item
      : { ...item, groupId: GENERAL_PROMPT_GROUP_ID }
  );
  const sourceProfiles = input.profiles.length
    ? input.profiles
    : [{ ...SAFETY_PROFILE, bundleIds: [] }];
  const profiles: TargetProfile[] = sourceProfiles.map((item) => ({
    ...item,
    bundleIds: [...new Set(item.bundleIds.filter(Boolean))],
    promptGroupId: groupIds.has(item.promptGroupId)
      ? item.promptGroupId
      : GENERAL_PROMPT_GROUP_ID,
    // 输出方式只允许三个可表达状态；防御运行时/旧草稿留下 code + strip。
    defaultMarkdownMode:
      item.defaultFormat === "plain" && item.defaultMarkdownMode === "strip"
        ? "strip"
        : "preserve",
  }));
  const defaultProfileId = profiles.some(
    (item) => item.id === input.defaultProfileId
  )
    ? input.defaultProfileId
    : (profiles[0]?.id ?? SAFETY_PROFILE_ID);
  return { groups, snippets, profiles, defaultProfileId };
}

export function deletePromptGroup(
  input: TargetProfileConfiguration,
  groupId: string
): TargetProfileConfiguration & { affectedReferences: number } {
  if (groupId === GENERAL_PROMPT_GROUP_ID) {
    return { ...repairTargetProfileConfiguration(input), affectedReferences: 0 };
  }
  let affectedReferences = 0;
  const result = repairTargetProfileConfiguration({
    ...input,
    groups: input.groups.filter((item) => item.id !== groupId),
    snippets: input.snippets.map((item) => {
      if (item.groupId !== groupId) return item;
      affectedReferences += 1;
      return { ...item, groupId: GENERAL_PROMPT_GROUP_ID };
    }),
    profiles: input.profiles.map((item) => {
      if (item.promptGroupId !== groupId) return item;
      affectedReferences += 1;
      return { ...item, promptGroupId: GENERAL_PROMPT_GROUP_ID };
    }),
  });
  return { ...result, affectedReferences };
}

export function deleteTargetProfile(
  input: TargetProfileConfiguration,
  profileId: string
): TargetProfileConfiguration {
  if (profileId === input.defaultProfileId) {
    return repairTargetProfileConfiguration(input);
  }
  return repairTargetProfileConfiguration({
    ...input,
    profiles: input.profiles.filter((item) => item.id !== profileId),
  });
}
