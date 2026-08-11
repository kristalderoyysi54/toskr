import { describe, expect, it } from "vitest";

import {
  buildAppMoveQuestion,
  createProfileFromPreset,
  filterAndPinProfiles,
  formatPromptGroupOption,
  profileFocusAfterDeleteId,
  profileSelectionAfterDelete,
  profileReorderAvailability,
  profileListKeyboardIndex,
  previewSelectedProfile,
  reorderProfilesKeepingDefault,
  shouldShowProfileSearch,
  settingsTargetAfterObservation,
} from "@/lib/profileManager";
import {
  GENERAL_PROMPT_GROUP_ID,
  type PromptGroup,
  type PromptSnippet,
  type TargetProfile,
} from "@/lib/targetProfiles";

function profile(id: string, name = id): TargetProfile {
  return {
    id,
    name,
    bundleIds: [],
    promptGroupId: GENERAL_PROMPT_GROUP_ID,
    defaultFormat: "plain",
    enterPolicy: "never",
    privacyPolicy: "requireRedaction",
    keepPanel: false,
  };
}

describe("发送方案管理器纯数据契约", () => {
  it("默认方案只在视图中置顶，不改变存储顺序", () => {
    const stored = [profile("first"), profile("default"), profile("last")];
    const visible = filterAndPinProfiles(stored, "default", "");

    expect(visible.map((item) => item.id)).toEqual(["default", "first", "last"]);
    expect(stored.map((item) => item.id)).toEqual(["first", "default", "last"]);
  });

  it("排序不移动默认方案，也不改变历史冲突的稳定命中顺序", () => {
    const stored = [
      { ...profile("first"), bundleIds: ["com.example.shared"] },
      profile("default"),
      { ...profile("second"), bundleIds: ["com.example.shared"] },
      profile("last"),
    ];

    expect(
      reorderProfilesKeepingDefault(stored, "default", "last", -1).map(
        (item) => item.id
      )
    ).toEqual(["first", "default", "last", "second"]);
    expect(
      reorderProfilesKeepingDefault(stored, "default", "second", -1)
    ).toBe(stored);
    expect(
      reorderProfilesKeepingDefault(stored, "default", "default", 1)
    ).toBe(stored);

    const defaultConflict = [
      { ...profile("first"), bundleIds: ["com.example.shared"] },
      { ...profile("default"), bundleIds: ["com.example.shared"] },
      profile("last"),
    ];
    expect(
      reorderProfilesKeepingDefault(defaultConflict, "default", "last", -1)
    ).toBe(defaultConflict);
  });

  it("方案超过八个才显示搜索，并可按名称或应用过滤", () => {
    expect(shouldShowProfileSearch(Array.from({ length: 8 }, (_, i) => profile(`${i}`)))).toBe(false);
    expect(shouldShowProfileSearch(Array.from({ length: 9 }, (_, i) => profile(`${i}`)))).toBe(true);

    const terminal = { ...profile("terminal", "终端只粘贴"), bundleIds: ["com.apple.Terminal"] };
    expect(filterAndPinProfiles([profile("default"), terminal], "default", "terminal")).toEqual([terminal]);
  });

  it("50 个方案的排序可用性一次生成稳定索引", () => {
    const profiles = Array.from({ length: 50 }, (_, index) =>
      profile(index === 0 ? "default" : `profile-${index}`)
    );
    const availability = profileReorderAvailability(profiles, "default");

    expect(availability).toHaveLength(50);
    expect(availability[0]).toEqual({ id: "default", up: false, down: false });
    expect(availability[1]).toEqual({ id: "profile-1", up: false, down: true });
    expect(availability[49]).toEqual({ id: "profile-49", up: true, down: false });
  });

  it("推荐方案只生成初始值，保留调用方提供的 ID 和名称", () => {
    expect(
      createProfileFromPreset({
        id: "kept-id",
        presetId: "terminal",
        name: "我的 Shell",
        promptGroupId: "coding",
        bundleId: "com.example.Terminal",
      })
    ).toMatchObject({
      id: "kept-id",
      name: "我的 Shell",
      promptGroupId: "coding",
      bundleIds: ["com.example.Terminal"],
      defaultFormat: "code",
      enterPolicy: "never",
    });
  });

  it("提示词组选项包含数量和短摘要", () => {
    const group: PromptGroup = { id: "coding", name: "编程", order: 1 };
    const snippets: PromptSnippet[] = [
      { id: "one", label: "解释代码", text: "解释这段代码", groupId: "coding" },
      { id: "two", label: "修复问题", text: "修复问题", groupId: "coding" },
    ];

    expect(formatPromptGroupOption(group, snippets)).toEqual({
      value: "coding",
      label: "编程 · 2 条 · 解释代码、修复问题",
      count: 2,
      summary: "解释代码、修复问题",
    });
  });

  it("实时效果预览通过统一 resolver 以本次覆盖方式应用编辑中的方案", () => {
    const profiles = [profile("default"), profile("selected", "AI 对话")];
    const groups: PromptGroup[] = [
      { id: GENERAL_PROMPT_GROUP_ID, name: "通用", order: 0 },
    ];

    expect(
      previewSelectedProfile({
        bundleId: "com.example.chat",
        isTargetReady: true,
        selectedProfileId: "selected",
        profiles,
        groups,
        defaultProfileId: "default",
      })
    ).toMatchObject({ profileId: "selected", source: "temporary" });
  });

  it("应用移动确认明确写出来源与目标方案", () => {
    expect(buildAppMoveQuestion("Otty", "AI 对话", "稳妥发送")).toBe(
      "Otty 当前属于“AI 对话”，是否移动到“稳妥发送”？"
    );
  });

  it("方案列表支持上下方向键循环选择", () => {
    expect(profileListKeyboardIndex("ArrowDown", 1, 3)).toBe(2);
    expect(profileListKeyboardIndex("ArrowDown", 2, 3)).toBe(0);
    expect(profileListKeyboardIndex("ArrowUp", 0, 3)).toBe(2);
    expect(profileListKeyboardIndex("Enter", 0, 3)).toBeNull();
  });

  it("删除方案后优先把焦点移到下一个可见方案，再回退上一个", () => {
    const visible = [profile("default"), profile("middle"), profile("last")];

    expect(profileFocusAfterDeleteId(visible, "middle")).toBe("last");
    expect(profileFocusAfterDeleteId(visible, "last")).toBe("middle");
    expect(profileFocusAfterDeleteId([profile("default")], "default")).toBeNull();
  });

  it("删除当前方案后编辑器选中项与焦点落点保持一致", () => {
    const remaining = [profile("default"), profile("last")];
    expect(profileSelectionAfterDelete({
      profiles: remaining,
      defaultProfileId: "default",
      deletedProfileId: "middle",
      selectedProfileId: "middle",
      nextVisibleProfileId: "last",
    })).toBe("last");
  });

  it("设置页拒绝旧 IPC 目标覆盖更新事件，并在 Toskr 前台时保留失效快照", () => {
    const targetA = {
      token: "a",
      pid: 1,
      bundleId: "com.example.A",
      appName: "A",
      launchedAtMs: 1,
      capturedAtMs: 1,
      revision: 1,
      ready: true,
      reason: null,
      windowId: null,
    };
    const targetB = {
      ...targetA,
      token: "b",
      pid: 2,
      bundleId: "com.example.B",
      appName: "B",
      revision: 2,
    };
    expect(settingsTargetAfterObservation(targetB, targetA)).toBe(targetB);
    expect(settingsTargetAfterObservation(targetB, {
      ...targetB,
      token: "self",
      bundleId: "com.toskr.app",
      appName: "Toskr",
      revision: 3,
      ready: false,
      reason: "target_not_frontmost",
    })).toMatchObject({
      bundleId: "com.example.B",
      appName: "B",
      revision: 3,
      ready: false,
    });
  });
});
