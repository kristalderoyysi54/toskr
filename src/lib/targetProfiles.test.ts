import { describe, expect, it } from "vitest";

import {
  assignTargetProfileBundle,
  GENERAL_PROMPT_GROUP_ID,
  SAFETY_PROFILE_ID,
  TERMINAL_BUNDLE_IDS,
  createDefaultPromptGroups,
  createDefaultTargetProfiles,
  deletePromptGroup,
  deleteTargetProfile,
  findDuplicateBundleAssignments,
  keepTargetProfileBundleAssignment,
  promptSnippetsForGroup,
  repairTargetProfileConfiguration,
  resolveTargetProfile,
  updateTargetProfileBundleIds,
  type PromptGroup,
  type PromptSnippet,
  type TargetProfile,
} from "@/lib/targetProfiles";

function profile(
  id: string,
  bundleIds: string[],
  patch: Partial<TargetProfile> = {}
): TargetProfile {
  return {
    id,
    name: id,
    bundleIds,
    promptGroupId: GENERAL_PROMPT_GROUP_ID,
    defaultFormat: "plain",
    enterPolicy: "never",
    privacyPolicy: "requireRedaction",
    keepPanel: true,
    ...patch,
  };
}

describe("Target Profile resolver", () => {
  const groups: PromptGroup[] = [
    { id: GENERAL_PROMPT_GROUP_ID, name: "通用", order: 0 },
    { id: "coding", name: "编程", order: 1 },
  ];
  const profiles = [
    profile("default", [], {
      name: "默认偏好",
      enterPolicy: "allow",
      privacyPolicy: "allowRaw",
    }),
    profile("codex", ["com.openai.codex"], {
      name: "Codex",
      promptGroupId: "coding",
      defaultFormat: "code",
      enterPolicy: "confirm",
      privacyPolicy: "confirmRaw",
    }),
    profile("temporary", [], {
      name: "本次覆盖",
      enterPolicy: "allow",
      privacyPolicy: "allowRaw",
      keepPanel: false,
    }),
  ];

  it("精确匹配返回唯一发送方案契约且不虚构隐私能力", () => {
    expect(
      resolveTargetProfile({
        bundleId: "com.openai.codex",
        isTargetReady: true,
        targetIdentity: "codex:42:500",
        groups,
        profiles,
        defaultProfileId: "default",
      })
    ).toMatchObject({
      profileId: "codex",
      profile: { id: "codex" },
      source: "exact",
      targetBundleId: "com.openai.codex",
      reason: "exact_bundle_match",
      isTargetReady: true,
      privacyCapabilityActive: false,
    });
  });

  it("绑定旧目标的临时覆盖不会应用到新目标", () => {
    expect(
      resolveTargetProfile({
        bundleId: "com.openai.codex",
        isTargetReady: true,
        targetIdentity: "codex:42:500",
        groups,
        profiles,
        defaultProfileId: "default",
        temporaryProfileId: "temporary",
        temporaryTargetIdentity: "terminal:99:700",
      })
    ).toMatchObject({
      profileId: "codex",
      source: "exact",
      reason: "temporary_target_changed",
    });
  });

  it("A→B→A 后待确认的临时覆盖不会自行复活", () => {
    expect(
      resolveTargetProfile({
        bundleId: "com.openai.codex",
        isTargetReady: true,
        targetIdentity: "codex:42:500",
        groups,
        profiles,
        defaultProfileId: "default",
        temporaryProfileId: "temporary",
        temporaryTargetIdentity: "codex:42:500",
        temporaryNeedsConfirmation: true,
      })
    ).toMatchObject({
      profileId: "codex",
      source: "exact",
      reason: "temporary_target_changed",
    });
  });

  it("临时覆盖在同一目标上优先于精确匹配", () => {
    expect(
      resolveTargetProfile({
        bundleId: "com.openai.codex",
        isTargetReady: true,
        targetIdentity: "codex:42:500",
        groups,
        profiles,
        defaultProfileId: "default",
        temporaryProfileId: "temporary",
        temporaryTargetIdentity: "codex:42:500",
      })
    ).toMatchObject({ profileId: "temporary", source: "temporary" });
  });

  it("未识别应用使用 fallback，且无目标与失效目标保持不可用", () => {
    expect(
      resolveTargetProfile({
        bundleId: "com.example.unknown",
        isTargetReady: true,
        groups,
        profiles,
        defaultProfileId: "default",
      })
    ).toMatchObject({
      profileId: "default",
      source: "fallback",
      reason: "fallback_default",
      isTargetReady: true,
    });

    expect(
      resolveTargetProfile({
        bundleId: null,
        isTargetReady: false,
        groups,
        profiles,
        defaultProfileId: "default",
      })
    ).toMatchObject({
      source: "fallback",
      reason: "target_missing",
      isTargetReady: false,
    });

    expect(
      resolveTargetProfile({
        bundleId: "com.openai.codex",
        isTargetReady: false,
        groups,
        profiles,
        defaultProfileId: "default",
      })
    ).toMatchObject({
      profileId: "codex",
      source: "exact",
      reason: "target_unavailable",
      isTargetReady: false,
    });
  });

  it("临时覆盖 > bundle 精确匹配 > 未识别应用默认方案 > 内建方案", () => {
    expect(
      resolveTargetProfile({
        bundleId: "com.openai.codex",
        isTargetReady: true,
        groups,
        profiles,
        defaultProfileId: "default",
        temporaryProfileId: "temporary",
        targetIdentity: "codex:42:500",
        temporaryTargetIdentity: "codex:42:500",
      }).profile.id
    ).toBe("temporary");

    expect(
      resolveTargetProfile({
        bundleId: "com.openai.codex",
        isTargetReady: true,
        groups,
        profiles,
        defaultProfileId: "default",
      })
    ).toMatchObject({
      source: "exact",
      profile: { id: "codex" },
      promptGroup: { id: "coding" },
    });

    const unknown = resolveTargetProfile({
      bundleId: "com.example.unknown",
      isTargetReady: true,
      groups,
      profiles,
      defaultProfileId: "default",
    });
    expect(unknown.source).toBe("fallback");
    expect(unknown.profile.id).toBe("default");
    expect(unknown.profile.enterPolicy).toBe("never");
    expect(unknown.profile.privacyPolicy).toBe("requireRedaction");
    expect(unknown.safetyClamped).toBe(true);

    expect(
      resolveTargetProfile({
        bundleId: null,
        isTargetReady: false,
        groups: [],
        profiles: [],
        defaultProfileId: "missing",
      }).profile
    ).toMatchObject({
      id: SAFETY_PROFILE_ID,
      enterPolicy: "never",
      privacyPolicy: "requireRedaction",
    });
  });

  it("仓库既有终端 bundle 全部命中终端 Profile 且默认不 Enter", () => {
    const defaults = createDefaultTargetProfiles(false);
    for (const bundleId of TERMINAL_BUNDLE_IDS) {
      const resolved = resolveTargetProfile({
        bundleId,
        isTargetReady: true,
        groups: createDefaultPromptGroups(),
        profiles: defaults,
        defaultProfileId: SAFETY_PROFILE_ID,
      });
      expect(resolved.source).toBe("exact");
      expect(resolved.profile.enterPolicy).toBe("never");
    }
  });

  it("重复 bundle 按 Profile 列表首项稳定胜出并返回 UI 警告", () => {
    const duplicate = [
      profile("first", ["com.example.same"]),
      profile("second", ["com.example.same"]),
    ];
    const resolved = resolveTargetProfile({
      bundleId: "com.example.same",
      isTargetReady: true,
      groups,
      profiles: duplicate,
      defaultProfileId: "first",
    });

    expect(resolved.profile.id).toBe("first");
    expect(resolved.source).toBe("conflict");
    expect(resolved.duplicateBundleProfileIds).toEqual(["first", "second"]);
    expect(findDuplicateBundleAssignments(duplicate)).toEqual([
      {
        bundleId: "com.example.same",
        profileIds: ["first", "second"],
        profileNames: ["first", "second"],
      },
    ]);
  });

  it("新增重复 bundle 被阻止，其他合法绑定仍可保存", () => {
    const current = [
      profile("first", ["com.example.owned"]),
      profile("second", []),
    ];

    const result = updateTargetProfileBundleIds(
      current,
      "second",
      ["com.example.owned", "com.example.fresh"]
    );

    expect(result.blockedBundleIds).toEqual(["com.example.owned"]);
    expect(result.profiles).toEqual([
      current[0],
      profile("second", ["com.example.fresh"]),
    ]);
  });

  it("移除当前方案已有应用不会触碰其他方案", () => {
    const current = [
      profile("first", ["com.example.keep"]),
      profile("second", ["com.example.remove", "com.example.stay"]),
    ];

    const result = updateTargetProfileBundleIds(
      current,
      "second",
      ["com.example.stay"]
    );

    expect(result.blockedBundleIds).toEqual([]);
    expect(result.profiles).toEqual([
      current[0],
      profile("second", ["com.example.stay"]),
    ]);
  });

  it("只有显式以后使用才把应用唯一重绑到所选方案", () => {
    const current = [
      profile("terminal", ["com.ghostty.Ghostty", "com.apple.Terminal"]),
      profile("writing", ["com.apple.TextEdit"]),
    ];

    const assigned = assignTargetProfileBundle(
      current,
      "com.ghostty.Ghostty",
      "writing"
    );

    expect(assigned).toEqual([
      profile("terminal", ["com.apple.Terminal"]),
      profile("writing", ["com.apple.TextEdit", "com.ghostty.Ghostty"]),
    ]);
    expect(current[0].bundleIds).toEqual([
      "com.ghostty.Ghostty",
      "com.apple.Terminal",
    ]);
  });

  it("历史重复 bundle 只在用户选择保留方案后解除冲突", () => {
    const duplicate = [
      profile("first", ["com.example.same", "com.example.first"]),
      profile("second", ["com.example.same", "com.example.second"]),
    ];

    expect(
      keepTargetProfileBundleAssignment(
        duplicate,
        "com.example.same",
        "second"
      )
    ).toEqual([
      profile("first", ["com.example.first"]),
      duplicate[1],
    ]);
  });

  it("Prompt 菜单优先当前分组，其他模板不重复且保留原顺序", () => {
    const snippets: PromptSnippet[] = [
      { id: "a", label: "A", text: "a", groupId: GENERAL_PROMPT_GROUP_ID },
      { id: "b", label: "B", text: "b", groupId: "coding" },
      { id: "c", label: "C", text: "c", groupId: "coding" },
    ];

    const menu = promptSnippetsForGroup(snippets, "coding");
    expect(menu.prioritized.map((item) => item.id)).toEqual(["b", "c"]);
    expect(menu.remaining.map((item) => item.id)).toEqual(["a"]);

    const generalMenu = promptSnippetsForGroup(snippets, GENERAL_PROMPT_GROUP_ID);
    expect(generalMenu.prioritized.map((item) => item.id)).toEqual(["a"]);
    expect(generalMenu.remaining.map((item) => item.id)).toEqual(["b", "c"]);

    const singleGroupMenu = promptSnippetsForGroup(
      snippets.map((item) => ({ ...item, groupId: "coding" })),
      "coding"
    );
    expect(singleGroupMenu.prioritized.map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(singleGroupMenu.remaining).toEqual([]);
  });
});

describe("Prompt/Profile reference repair", () => {
  const groups: PromptGroup[] = [
    { id: GENERAL_PROMPT_GROUP_ID, name: "通用", order: 0 },
    { id: "team", name: "团队", order: 1 },
  ];
  const snippets: PromptSnippet[] = [
    { id: "general", label: "通用模板", text: "a", groupId: GENERAL_PROMPT_GROUP_ID },
    { id: "team", label: "团队模板", text: "b", groupId: "team" },
  ];
  const profiles = [
    profile("default", [], { promptGroupId: "team" }),
    profile("other", ["com.example.other"], { promptGroupId: "team" }),
  ];

  it("新安装使用稳妥发送，旧安全默认名称不会被静默改写", () => {
    expect(createDefaultTargetProfiles(false)[0]).toMatchObject({
      id: SAFETY_PROFILE_ID,
      name: "稳妥发送",
    });

    const legacy = profile(SAFETY_PROFILE_ID, [], { name: "安全默认" });
    const repaired = repairTargetProfileConfiguration({
      groups,
      snippets,
      profiles: [legacy],
      defaultProfileId: SAFETY_PROFILE_ID,
    });
    expect(repaired.profiles[0].name).toBe("安全默认");
  });

  it("空配置始终补回未识别应用的默认方案", () => {
    const repaired = repairTargetProfileConfiguration({
      groups,
      snippets,
      profiles: [],
      defaultProfileId: "",
    });

    expect(repaired.profiles).toHaveLength(1);
    expect(repaired.profiles[0].id).toBe(SAFETY_PROFILE_ID);
    expect(repaired.defaultProfileId).toBe(SAFETY_PROFILE_ID);
  });

  it("删除被引用分组后 snippet/Profile 全部回落通用分组", () => {
    const result = deletePromptGroup(
      { groups, snippets, profiles, defaultProfileId: "default" },
      "team"
    );

    expect(result.affectedReferences).toBe(3);
    expect(result.groups.map((group) => group.id)).toEqual([GENERAL_PROMPT_GROUP_ID]);
    expect(result.snippets.map((snippet) => snippet.groupId)).toEqual([
      GENERAL_PROMPT_GROUP_ID,
      GENERAL_PROMPT_GROUP_ID,
    ]);
    expect(result.profiles.every((item) => item.promptGroupId === GENERAL_PROMPT_GROUP_ID)).toBe(true);
  });

  it("未识别应用的默认方案不能删除，删除其他方案不会影响默认项", () => {
    const protectedResult = deleteTargetProfile(
      { groups, snippets, profiles, defaultProfileId: "default" },
      "default"
    );
    expect(protectedResult.profiles).toEqual(profiles);
    expect(protectedResult.defaultProfileId).toBe("default");

    const withoutOther = deleteTargetProfile(protectedResult, "other");
    expect(withoutOther.profiles).toEqual([profiles[0]]);
    expect(withoutOther.defaultProfileId).toBe("default");
  });
});
