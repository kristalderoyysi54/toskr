import { describe, expect, it } from "vitest";

import {
  GENERAL_PROMPT_GROUP_ID,
  SAFETY_PROFILE_ID,
  TERMINAL_BUNDLE_IDS,
  createDefaultPromptGroups,
  createDefaultTargetProfiles,
  deletePromptGroup,
  deleteTargetProfile,
  findDuplicateBundleAssignments,
  promptSnippetsForGroup,
  resolveTargetProfile,
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

  it("临时覆盖 > bundle 精确匹配 > 用户默认 > 安全默认", () => {
    expect(
      resolveTargetProfile({
        bundleId: "com.openai.codex",
        groups,
        profiles,
        defaultProfileId: "default",
        temporaryProfileId: "temporary",
      }).profile.id
    ).toBe("temporary");

    expect(
      resolveTargetProfile({
        bundleId: "com.openai.codex",
        groups,
        profiles,
        defaultProfileId: "default",
      })
    ).toMatchObject({
      source: "bundle",
      profile: { id: "codex" },
      promptGroup: { id: "coding" },
    });

    const unknown = resolveTargetProfile({
      bundleId: "com.example.unknown",
      groups,
      profiles,
      defaultProfileId: "default",
    });
    expect(unknown.source).toBe("default");
    expect(unknown.profile.id).toBe("default");
    expect(unknown.profile.enterPolicy).toBe("never");
    expect(unknown.profile.privacyPolicy).toBe("requireRedaction");
    expect(unknown.safetyClamped).toBe(true);

    expect(
      resolveTargetProfile({
        bundleId: null,
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
        groups: createDefaultPromptGroups(),
        profiles: defaults,
        defaultProfileId: SAFETY_PROFILE_ID,
      });
      expect(resolved.source).toBe("bundle");
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
      groups,
      profiles: duplicate,
      defaultProfileId: "first",
    });

    expect(resolved.profile.id).toBe("first");
    expect(resolved.duplicateBundleProfileIds).toEqual(["first", "second"]);
    expect(findDuplicateBundleAssignments(duplicate)).toEqual([
      {
        bundleId: "com.example.same",
        profileIds: ["first", "second"],
        profileNames: ["first", "second"],
      },
    ]);
  });

  it("Prompt 菜单优先当前分组，同时保留全部模板原顺序", () => {
    const snippets: PromptSnippet[] = [
      { id: "a", label: "A", text: "a", groupId: GENERAL_PROMPT_GROUP_ID },
      { id: "b", label: "B", text: "b", groupId: "coding" },
      { id: "c", label: "C", text: "c", groupId: "coding" },
    ];

    const menu = promptSnippetsForGroup(snippets, "coding");
    expect(menu.prioritized.map((item) => item.id)).toEqual(["b", "c"]);
    expect(menu.all.map((item) => item.id)).toEqual(["a", "b", "c"]);
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

  it("删除默认 Profile 后 defaultProfileId 指向剩余项；删空则回到安全虚拟 Profile", () => {
    const first = deleteTargetProfile(
      { groups, snippets, profiles, defaultProfileId: "default" },
      "default"
    );
    expect(first.defaultProfileId).toBe("other");

    const empty = deleteTargetProfile(first, "other");
    expect(empty.profiles).toEqual([]);
    expect(empty.defaultProfileId).toBe(SAFETY_PROFILE_ID);
  });
});
