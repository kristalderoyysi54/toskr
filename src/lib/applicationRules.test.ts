import { describe, expect, it } from "vitest";

import { applicationRuleValues, applyApplicationRuleDraft, equalApplicationRuleValues, type ApplicationRuleValues } from "./applicationRules";
import { resolveTargetProfile, type TargetProfile } from "./targetProfiles";

function profile(id: string, bundleIds: string[], values: Partial<ApplicationRuleValues> = {}): TargetProfile {
  return {
    id, name: `${id} 名称`, bundleIds, defaultFormat: "plain", defaultMarkdownMode: "preserve",
    enterPolicy: "never", privacyPolicy: "requireRedaction", keepPanel: false, promptGroupId: "general", ...values,
  };
}

function setup() {
  const fallback = profile("default", ["bound-default"], { enterPolicy: "allow", privacyPolicy: "allowRaw" });
  const shared = profile("shared", ["claude", "chatgpt"], { enterPolicy: "confirm", privacyPolicy: "confirmRaw" });
  const single = profile("single", ["terminal"]);
  const profiles = [shared, fallback, single];
  const input = {
    profiles, defaultProfileId: "default", bundleId: "claude" as string | null, sourceProfileId: "shared",
    scope: "app" as "app" | "shared", values: { ...applicationRuleValues(shared), keepPanel: true },
    appName: "Claude", newProfileId: "independent",
  };
  return { fallback, shared, single, profiles, input };
}

describe("应用规则草稿", () => {
  it("恢复默认只解除当前应用的绑定，保留共享方案并跟随后续默认变化", () => {
    const { input, profiles, shared, fallback, single } = setup();
    const result = applyApplicationRuleDraft({ ...input, scope: "shared", resetToDefault: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profiles).toEqual([{ ...shared, bundleIds: ["chatgpt"] }, fallback, single]);
    expect(result.profiles[1]).toBe(fallback);
    expect(result.profiles[2]).toBe(single);
    expect(profiles[0].bundleIds).toEqual(["claude", "chatgpt"]);
    const resolved = resolveTargetProfile({ bundleId: "claude", isTargetReady: true, profiles: result.profiles, defaultProfileId: "default", groups: [] });
    expect(resolved.source).toBe("fallback");
    expect(resolved.profile).toMatchObject({ enterPolicy: "never", privacyPolicy: "requireRedaction" });
    const updated = result.profiles.map(item => item.id === "default" ? { ...item, keepPanel: true } : item);
    expect(resolveTargetProfile({ bundleId: "claude", isTargetReady: true, profiles: updated, defaultProfileId: "default", groups: [] }).profile.keepPanel).toBe(true);
  });

  it.each([["terminal", "single"], ["bound-default", "default"]])("恢复 %s 保留无绑定的原方案和所有字段", (bundleId, sourceProfileId) => {
    const { input, profiles } = setup();
    const result = applyApplicationRuleDraft({ ...input, bundleId, sourceProfileId, resetToDefault: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profiles).toHaveLength(profiles.length);
    expect(result.profiles.find(item => item.id === sourceProfileId)).toEqual({ ...profiles.find(item => item.id === sourceProfileId), bundleIds: [] });
  });

  it("恢复默认拒绝冲突、变更来源和全局入口；已未绑定时不写入", () => {
    const { input, profiles } = setup();
    expect(applyApplicationRuleDraft({ ...input, resetToDefault: true, profiles: [...profiles, profile("duplicate", ["claude"])] })).toEqual({ ok: false, error: "binding-conflict" });
    expect(applyApplicationRuleDraft({ ...input, resetToDefault: true, sourceProfileId: "single" })).toEqual({ ok: false, error: "source-changed" });
    expect(applyApplicationRuleDraft({ ...input, resetToDefault: true, bundleId: null, sourceProfileId: "default" })).toEqual({ ok: false, error: "source-changed" });
    const result = applyApplicationRuleDraft({ ...input, resetToDefault: true, bundleId: "unbound", sourceProfileId: "default" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profiles).toBe(profiles);
  });

  it("取值只包含规则，比较不受名称、绑定或对象引用影响", () => {
    const { shared } = setup();
    const values = applicationRuleValues(shared);
    expect(Object.keys(values)).toHaveLength(6);
    expect(values).not.toHaveProperty("bundleIds");
    expect(equalApplicationRuleValues(values, { ...values })).toBe(true);
    for (const patch of [
      { defaultFormat: "code" }, { defaultMarkdownMode: "strip" }, { enterPolicy: "never" },
      { privacyPolicy: "allowRaw" }, { keepPanel: true }, { promptGroupId: "writing" },
    ] as Partial<ApplicationRuleValues>[]) {
      expect(equalApplicationRuleValues(values, { ...values, ...patch })).toBe(false);
    }
  });

  it("仅此应用从共享方案分离，只移动当前绑定并保留原顺序与其他字段", () => {
    const { input, profiles, shared, fallback, single } = setup();
    profiles.forEach(item => { Object.freeze(item.bundleIds); Object.freeze(item); });
    Object.freeze(profiles);
    const result = applyApplicationRuleDraft(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profiles.map(item => item.id)).toEqual(["shared", "default", "single", "independent"]);
    expect(result.profiles[0]).toEqual({ ...shared, bundleIds: ["chatgpt"] });
    expect(result.profiles[1]).toBe(fallback);
    expect(result.profiles[2]).toBe(single);
    expect(result.profiles[3]).toEqual({ ...shared, ...input.values, id: "independent", name: "Claude 粘贴规则", bundleIds: ["claude"] });
    expect(shared.bundleIds).toEqual(["claude", "chatgpt"]);
  });

  it("唯一且非默认的独立方案原位更新，不改名称和绑定", () => {
    const { input, single, profiles } = setup();
    const values = { ...applicationRuleValues(single), keepPanel: true };
    const result = applyApplicationRuleDraft({ ...input, bundleId: "terminal", sourceProfileId: "single", values, newProfileId: "default" });
    expect(result).toEqual({ ok: true, profiles: [profiles[0], profiles[1], { ...single, ...values }] });
  });

  it("共享更新只改指定方案字段，全部绑定仍引用同一方案", () => {
    const { input, shared, profiles } = setup();
    const result = applyApplicationRuleDraft({ ...input, scope: "shared" });
    expect(result).toEqual({ ok: true, profiles: [{ ...shared, ...input.values }, profiles[1], profiles[2]] });
    if (result.ok) expect(result.profiles[0].bundleIds).toBe(shared.bundleIds);
  });

  it("默认方案即使只绑定一个应用，仅此应用也需分离", () => {
    const { input, fallback } = setup();
    const result = applyApplicationRuleDraft({ ...input, bundleId: "bound-default", sourceProfileId: "default", values: { ...applicationRuleValues(fallback), keepPanel: true } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profiles[1]).toEqual({ ...fallback, bundleIds: [] });
    expect(result.profiles.at(-1)?.bundleIds).toEqual(["bound-default"]);
  });

  it("未绑定应用按安全钳制值建立副本，不继承默认方案的宽松策略", () => {
    const { input, fallback, profiles } = setup();
    const baseline = resolveTargetProfile({ bundleId: "new-app", isTargetReady: true, profiles, defaultProfileId: "default", groups: [] }).profile;
    const result = applyApplicationRuleDraft({ ...input, bundleId: "new-app", sourceProfileId: "default", values: { ...applicationRuleValues(baseline), keepPanel: true } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profiles[1]).toBe(fallback);
    expect(result.profiles.at(-1)).toMatchObject({ bundleIds: ["new-app"], enterPolicy: "never", privacyPolicy: "requireRedaction", keepPanel: true });
  });

  it("编辑默认兜底只保存格式、面板和组，保留直接绑定应用的回车与隐私策略", () => {
    const { input, fallback, profiles } = setup();
    const values: ApplicationRuleValues = { defaultFormat: "plain", defaultMarkdownMode: "strip", keepPanel: true, promptGroupId: "writing", enterPolicy: "never", privacyPolicy: "requireRedaction" };
    const result = applyApplicationRuleDraft({ ...input, bundleId: null, sourceProfileId: "default", values });
    expect(result).toEqual({ ok: true, profiles: [profiles[0], { ...fallback, ...values, enterPolicy: "allow", privacyPolicy: "allowRaw" }, profiles[2]] });
  });

  it.each(["app", "shared"] as const)("%s 范围拒绝重复绑定，不静默选中首方案", scope => {
    const { input, profiles } = setup();
    expect(applyApplicationRuleDraft({ ...input, scope, profiles: [...profiles, profile("conflict", ["claude"])] }))
      .toEqual({ ok: false, error: "binding-conflict" });
  });

  it("共享应用值没变不分离；未绑定应用钳制值没变也不创建", () => {
    const { input, shared, fallback, profiles } = setup();
    for (const [bundleId, sourceProfileId, values] of [
      ["claude", "shared", applicationRuleValues(shared)],
      ["new-app", "default", { ...applicationRuleValues(fallback), enterPolicy: "never", privacyPolicy: "requireRedaction" }],
      [null, "default", { ...applicationRuleValues(fallback), enterPolicy: "never", privacyPolicy: "requireRedaction" }],
    ] as const) {
      const result = applyApplicationRuleDraft({ ...input, bundleId, sourceProfileId, values, newProfileId: "default" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.profiles).toBe(profiles);
    }
  });

  it("仅创建副本时拒绝空白或重复 ID", () => {
    const { input } = setup();
    expect(applyApplicationRuleDraft({ ...input, newProfileId: " default " })).toEqual({ ok: false, error: "duplicate-profile-id" });
    expect(applyApplicationRuleDraft({ ...input, newProfileId: "  " })).toEqual({ ok: false, error: "invalid-profile-id" });
  });

  it("未绑定应用编辑共享来源时，字段与存储一致也不复制数组", () => {
    const { input, fallback, profiles } = setup();
    const result = applyApplicationRuleDraft({ ...input, bundleId: "new-app", sourceProfileId: "default", scope: "shared", values: applicationRuleValues(fallback) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profiles).toBe(profiles);
  });

  it("来源方案被删除、重新绑定或默认切换时拒绝旧草稿", () => {
    const { input } = setup();
    expect(applyApplicationRuleDraft({ ...input, sourceProfileId: "missing" })).toEqual({ ok: false, error: "profile-missing" });
    expect(applyApplicationRuleDraft({ ...input, sourceProfileId: "single" })).toEqual({ ok: false, error: "source-changed" });
    expect(applyApplicationRuleDraft({ ...input, bundleId: null })).toEqual({ ok: false, error: "source-changed" });
    expect(applyApplicationRuleDraft({ ...input, bundleId: "new-app", sourceProfileId: "default", defaultProfileId: "single" })).toEqual({ ok: false, error: "source-changed" });
  });
});
