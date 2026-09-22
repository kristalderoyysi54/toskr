import { assignTargetProfileBundle, resolveTargetProfile, type TargetProfile } from "@/lib/targetProfiles";

export type ApplicationRuleValues = Pick<TargetProfile,
  "defaultFormat" | "defaultMarkdownMode" | "enterPolicy" | "privacyPolicy" | "keepPanel" | "promptGroupId"
>;

export function applicationRuleValues(profile: ApplicationRuleValues): ApplicationRuleValues {
  const { defaultFormat, defaultMarkdownMode, enterPolicy, privacyPolicy, keepPanel, promptGroupId } = profile;
  return { defaultFormat, defaultMarkdownMode, enterPolicy, privacyPolicy, keepPanel, promptGroupId };
}

export function equalApplicationRuleValues(left: ApplicationRuleValues, right: ApplicationRuleValues): boolean {
  return left.defaultFormat === right.defaultFormat
    && left.defaultMarkdownMode === right.defaultMarkdownMode
    && left.enterPolicy === right.enterPolicy
    && left.privacyPolicy === right.privacyPolicy
    && left.keepPanel === right.keepPanel
    && left.promptGroupId === right.promptGroupId;
}

export type ApplicationRuleDraftResult =
  | { ok: true; profiles: TargetProfile[] }
  | { ok: false; error: "profile-missing" | "source-changed" | "binding-conflict" | "duplicate-profile-id" | "invalid-profile-id" };

/** 应用检查器的显式保存：只修改规则字段，分离时只移动当前应用。 */
export function applyApplicationRuleDraft(input: {
  profiles: TargetProfile[];
  defaultProfileId: string;
  bundleId: string | null;
  sourceProfileId: string;
  scope: "app" | "shared";
  values: ApplicationRuleValues;
  appName: string;
  newProfileId: string;
  resetToDefault?: boolean;
}): ApplicationRuleDraftResult {
  const { profiles, defaultProfileId, bundleId, sourceProfileId } = input;
  const owners = bundleId ? profiles.filter(profile => profile.bundleIds.includes(bundleId)) : [];
  if (owners.length > 1) return { ok: false, error: "binding-conflict" };
  const source = profiles.find(profile => profile.id === sourceProfileId);
  if (!source) return { ok: false, error: "profile-missing" };
  if ((owners[0]?.id ?? defaultProfileId) !== sourceProfileId) {
    return { ok: false, error: "source-changed" };
  }

  // 恢复默认解除绑定，而非复制默认值；后续默认规则调整仍能自动生效。
  if (input.resetToDefault) {
    if (!bundleId?.trim()) return { ok: false, error: "source-changed" };
    return {
      ok: true,
      profiles: owners.length === 0 ? profiles : profiles.map(profile => profile === source
        ? { ...profile, bundleIds: profile.bundleIds.filter(id => id !== bundleId) }
        : profile),
    };
  }

  const values = applicationRuleValues(input.values);
  if (bundleId === null) {
    // 兜底界面不编辑回车/隐私，保留默认方案对显式绑定应用的完整策略。
    const next = { ...source, ...values, enterPolicy: source.enterPolicy, privacyPolicy: source.privacyPolicy };
    return {
      ok: true,
      profiles: equalApplicationRuleValues(source, next)
        ? profiles
        : profiles.map(profile => profile === source ? next : profile),
    };
  }
  if (!bundleId.trim()) return { ok: false, error: "source-changed" };

  // 只取 resolver 的方案值；分组显示回落不参与这次草稿比较。
  const baseline = resolveTargetProfile({
    bundleId, isTargetReady: true, profiles, defaultProfileId, groups: [],
  }).profile;
  if (equalApplicationRuleValues(baseline, values)) return { ok: true, profiles };

  const canUpdateInPlace = input.scope === "shared"
    || (owners.length === 1 && source.bundleIds.length === 1 && source.id !== defaultProfileId);
  if (canUpdateInPlace) {
    if (equalApplicationRuleValues(source, values)) return { ok: true, profiles };
    return {
      ok: true,
      profiles: profiles.map(profile => profile === source ? { ...profile, ...values } : profile),
    };
  }

  const newProfileId = input.newProfileId.trim();
  if (!newProfileId) return { ok: false, error: "invalid-profile-id" };
  if (profiles.some(profile => profile.id === newProfileId)) return { ok: false, error: "duplicate-profile-id" };
  const independent: TargetProfile = {
    ...source,
    ...values,
    id: newProfileId,
    name: `${input.appName.trim() || bundleId} 粘贴规则`,
    bundleIds: [],
  };
  return {
    ok: true,
    profiles: assignTargetProfileBundle([...profiles, independent], bundleId, newProfileId),
  };
}
