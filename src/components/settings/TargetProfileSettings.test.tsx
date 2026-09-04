import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CurrentTargetPreview } from "@/components/settings/CurrentTargetPreview";
import { AppAssignmentPicker } from "@/components/settings/AppAssignmentPicker";
import { ProfileEditor } from "@/components/settings/ProfileEditor";
import { ProfileList } from "@/components/settings/ProfileList";
import { appIdentityForCurrentBundle } from "@/components/settings/useAppIdentity";
import type { TargetSnapshot } from "@/lib/tauri";
import {
  GENERAL_PROMPT_GROUP_ID,
  resolveTargetProfile,
  type PromptGroup,
  type PromptSnippet,
  type TargetProfile,
} from "@/lib/targetProfiles";

const groups: PromptGroup[] = [
  { id: GENERAL_PROMPT_GROUP_ID, name: "通用", order: 0 },
  { id: "coding", name: "编程", order: 1 },
];
const snippets: PromptSnippet[] = [
  { id: "explain", label: "解释代码", text: "解释以下代码", groupId: "coding" },
  { id: "review", label: "代码审查", text: "审查以下代码", groupId: "coding" },
];

function profile(id: string, patch: Partial<TargetProfile> = {}): TargetProfile {
  return {
    id,
    name: id,
    bundleIds: [],
    promptGroupId: GENERAL_PROMPT_GROUP_ID,
    defaultFormat: "plain",
    enterPolicy: "never",
    privacyPolicy: "requireRedaction",
    keepPanel: false,
    ...patch,
    defaultMarkdownMode: patch.defaultMarkdownMode ?? "preserve",
  };
}

const target: TargetSnapshot = {
  token: "token",
  pid: 42,
  bundleId: "com.example.otty",
  appName: "Otty",
  launchedAtMs: 100,
  capturedAtMs: 200,
  revision: 1,
  ready: true,
  reason: null,
  windowId: null,
};

describe("发送方案设置组件", () => {
  it.each([
    ["exact", [profile("default"), profile("otty", { name: "AI 对话", bundleIds: [target.bundleId as string] })], "已为 Otty 指定"],
    ["fallback", [profile("default", { name: "稳妥发送" })], "未识别应用的默认方案"],
    ["conflict", [profile("first", { bundleIds: [target.bundleId as string] }), profile("second", { bundleIds: [target.bundleId as string] })], "重复绑定冲突"],
  ] as const)("当前匹配卡准确展示 %s", (_source, profiles, expectedReason) => {
    const resolution = resolveTargetProfile({
      bundleId: target.bundleId,
      isTargetReady: true,
      groups,
      profiles: [...profiles],
      defaultProfileId: profiles[0].id,
    });
    const html = renderToStaticMarkup(
      <CurrentTargetPreview
        snapshot={target}
        resolution={resolution}
        refreshing={false}
        testMessage={null}
        onRefresh={vi.fn()}
        onTest={vi.fn()}
        onEditProfile={vi.fn()}
      />
    );

    expect(html).toContain("当前匹配");
    expect(html).toContain("可发送");
    expect(html).toContain(expectedReason);
    expect(html).toContain("隐私检查：尚未启用");
    expect(html).toContain("隐私检查尚未启用 · 本次未检查");
    expect(html).toContain('aria-label="Otty 应用图标"');
    expect(html).toContain('aria-label="刷新（重新识别系统前台应用）"');
    expect(html).toContain("测试当前目标");
    expect(html).not.toMatch(/已脱敏|已保护|隐私检查：安全/);
  });

  it("无目标与目标失效使用真实状态，不把隐私预设写成保护", () => {
    const profiles = [profile("default", { name: "安全默认" })];
    const missingResolution = resolveTargetProfile({
      bundleId: null,
      isTargetReady: false,
      groups,
      profiles,
      defaultProfileId: "default",
    });
    const missing = renderToStaticMarkup(
      <CurrentTargetPreview
        snapshot={null}
        resolution={missingResolution}
        refreshing={false}
        testMessage={null}
        onRefresh={vi.fn()}
        onTest={vi.fn()}
        onEditProfile={vi.fn()}
      />
    );
    expect(missing).toContain("尚未识别");
    expect(missing).toContain('disabled=""');

    const unavailable = renderToStaticMarkup(
      <CurrentTargetPreview
        snapshot={{ ...target, ready: false, reason: "target_exited" }}
        resolution={resolveTargetProfile({
          bundleId: target.bundleId,
          isTargetReady: false,
          groups,
          profiles,
          defaultProfileId: "default",
        })}
        refreshing={false}
        testMessage={null}
        onRefresh={vi.fn()}
        onTest={vi.fn()}
        onEditProfile={vi.fn()}
      />
    );
    expect(unavailable).toContain("目标已失效");
    expect(unavailable).toContain("发送已锁定");

    const assignment = renderToStaticMarkup(
      <AppAssignmentPicker
        profile={profiles[0]}
        profiles={profiles}
        currentTarget={{ ...target, ready: false, reason: "target_exited" }}
        recentApps={[]}
        onProfilesChange={vi.fn()}
      />
    );
    expect(assignment).toMatch(
      /<button[^>]*disabled=""[^>]*>[\s\S]*?添加当前目标应用<\/button>/
    );
  });

  it("十个方案显示搜索、默认项保护、应用图标最多三个并提供 VoiceOver 名称", () => {
    const profiles = Array.from({ length: 10 }, (_, index) =>
      profile(`profile-${index}`, {
        name: index === 4 ? "一个非常长的方案名称用于验证自然换行与键盘选择" : `方案 ${index}`,
        enterPolicy: index === 4 ? "allow" : "never",
        bundleIds: index === 4
          ? ["com.one", "com.two", "com.three", "com.four", "com.five"]
          : [],
      })
    );
    const html = renderToStaticMarkup(
      <ProfileList
        profiles={profiles}
        groups={groups}
        defaultProfileId="profile-0"
        selectedProfileId="profile-4"
        currentProfileId="profile-4"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(html).toContain("搜索方案或应用");
    expect(html).toContain("未识别应用的默认方案");
    expect(html).toContain("未识别应用的默认方案不可删除");
    expect(html).toContain("当前目标使用");
    expect(html).toContain("+2");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("一个非常长的方案名称");
    expect(html).toContain("自动按回车 · 高风险");
  });

  it("编辑器按真实流程分组，解释格式与风险，并明确隐私能力待启用", () => {
    const edited = profile("coding-profile", {
      name: "一个很长的终端方案名称用于验证窄宽布局",
      promptGroupId: "coding",
      defaultFormat: "code",
      enterPolicy: "confirm",
      keepPanel: true,
    });
    const html = renderToStaticMarkup(
      <ProfileEditor
        profile={edited}
        profiles={[profile("default"), edited]}
        groups={groups}
        snippets={snippets}
        defaultProfileId="default"
        currentTarget={target}
        recentApps={[]}
        onUpdate={vi.fn()}
        onProfilesChange={vi.fn()}
        onSetDefault={vi.fn()}
      />
    );

    const headings = [
      "基本信息",
      "适用应用",
      "内容与格式",
      "发送行为",
      "隐私命中后处理策略",
      "实时效果预览",
    ];
    for (let index = 1; index < headings.length; index += 1) {
      expect(html.indexOf(headings[index - 1])).toBeLessThan(html.indexOf(headings[index]));
    }
    expect(html).toContain("编程 · 2 条 · 解释代码、代码审查");
    expect(html).toContain("保持内容自然排版");
    expect(html).toContain("发送时去除 Markdown 标记");
    expect(html).toContain("用代码围栏包裹文本");
    expect(html).toContain("从不按回车");
    expect(html).toContain("每次发送前确认");
    expect(html).toContain("自动按回车");
    expect(html).toContain("关闭面板");
    expect(html).toContain("保持打开");
    expect(html).toContain("已启用");
    expect(html).toContain("发送前在本机检查最终文本");
    expect(html).toContain("配置值");
    expect(html).toContain("测试预演值（不影响当前发送）");
    expect(html).toContain("匹配来源：仅本次手动选择");
    expect(html).toContain("当前真实生效值");
    expect(html).toContain("匹配来源：未识别应用的默认方案");
    expect(html).toContain("发送前隐私门禁");
    expect(html).toContain("当前生效策略：要求逐项处理");
    expect(html).toContain("测试内容（可编辑，最多 4000 字符）");
    expect(html).toContain('maxLength="4000"');
    expect(html).toContain("格式预览 · 代码块");
    expect(html).toContain("```\n# 项目更新");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain("代码块预览已更新，共");
    expect(html).toContain("不会读取剪贴板、修改卡片或执行发送");
    expect(html).toContain('type="radio"');
    expect(html).toContain("sm:grid-cols-3");
    expect(html).not.toContain("overflow-x-auto");
  });

  it("无 Markdown 方案在配置、预演和当前生效轨道中保持一致", () => {
    const edited = profile("markdown-free", {
      name: "聊天纯净文本",
      bundleIds: [target.bundleId as string],
      defaultFormat: "plain",
      defaultMarkdownMode: "strip",
    });
    const html = renderToStaticMarkup(
      <ProfileEditor
        profile={edited}
        profiles={[profile("default"), edited]}
        groups={groups}
        snippets={snippets}
        defaultProfileId="default"
        currentTarget={target}
        recentApps={[]}
        onUpdate={vi.fn()}
        onProfilesChange={vi.fn()}
        onSetDefault={vi.fn()}
      />
    );

    expect(html).toContain('checked=""');
    expect(html.match(/输出格式：无 Markdown/g)).toHaveLength(3);
    expect(html).toContain("格式预览 · 无 Markdown");
    expect(html).toContain("• 完成：修复发送");
    expect(html).toContain("查看文档（https://example.com）");

    const profileList = renderToStaticMarkup(
      <ProfileList
        profiles={[edited]}
        groups={groups}
        defaultProfileId={edited.id}
        selectedProfileId={edited.id}
        currentProfileId={edited.id}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(profileList).toContain("通用 · 无 Markdown");

    const currentTarget = renderToStaticMarkup(
      <CurrentTargetPreview
        snapshot={target}
        resolution={resolveTargetProfile({
          bundleId: target.bundleId,
          isTargetReady: true,
          groups,
          profiles: [edited],
          defaultProfileId: edited.id,
        })}
        refreshing={false}
        testMessage={null}
        onRefresh={vi.fn()}
        onTest={vi.fn()}
        onEditProfile={vi.fn()}
      />
    );
    expect(currentTarget).toContain("输出格式：无 Markdown");
  });

  it("提示词组被删除时同时展示原配置缺失与 resolver 的安全回退", () => {
    const edited = profile("missing-group-profile", {
      name: "旧配置方案",
      promptGroupId: "deleted-group",
    });
    const html = renderToStaticMarkup(
      <ProfileEditor
        profile={edited}
        profiles={[profile("default"), edited]}
        groups={groups}
        snippets={snippets}
        defaultProfileId="default"
        currentTarget={target}
        recentApps={[]}
        onUpdate={vi.fn()}
        onProfilesChange={vi.fn()}
        onSetDefault={vi.fn()}
      />
    );

    expect(html).toContain("已删除的提示词组");
    expect(html).toContain("当前生效：通用");
  });

  it("当前真实生效值不把编辑预演冒充为 fallback，并展示安全收紧", () => {
    const riskyDefault = profile("default", {
      name: "高风险默认",
      enterPolicy: "allow",
    });
    const html = renderToStaticMarkup(
      <ProfileEditor
        profile={riskyDefault}
        profiles={[riskyDefault]}
        groups={groups}
        snippets={snippets}
        defaultProfileId="default"
        currentTarget={target}
        recentApps={[]}
        onUpdate={vi.fn()}
        onProfilesChange={vi.fn()}
        onSetDefault={vi.fn()}
      />
    );

    expect(html).toMatch(
      /测试预演值（不影响当前发送）[\s\S]*粘贴后动作：自动按回车 · 高风险[\s\S]*当前真实生效值[\s\S]*粘贴后动作：从不按回车/
    );
    expect(html).toContain("默认回退已收紧为从不按回车");
  });

  it("当前真实生效值保留历史冲突来源，不被编辑预演遮蔽", () => {
    const first = profile("first", { bundleIds: [target.bundleId as string] });
    const second = profile("second", { bundleIds: [target.bundleId as string] });
    const html = renderToStaticMarkup(
      <ProfileEditor
        profile={first}
        profiles={[first, second]}
        groups={groups}
        snippets={snippets}
        defaultProfileId="first"
        currentTarget={target}
        recentApps={[]}
        onUpdate={vi.fn()}
        onProfilesChange={vi.fn()}
        onSetDefault={vi.fn()}
      />
    );

    expect(html).toMatch(
      /当前真实生效值[\s\S]*匹配来源：重复绑定冲突/
    );
  });

  it("目标切换首帧不会复用旧应用身份", () => {
    expect(
      appIdentityForCurrentBundle("com.example.new", "New App", {
        bundleId: "com.example.old",
        info: { name: "Old App", iconUrl: "old-icon" },
      })
    ).toEqual({ name: "New App", iconUrl: null });
  });
});
