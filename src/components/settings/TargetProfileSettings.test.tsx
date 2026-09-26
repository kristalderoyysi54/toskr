import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CurrentTargetPreview } from "@/components/settings/CurrentTargetPreview";
import { DeliveryPolicySummary } from "@/components/settings/DeliveryPolicySummary";
import { TargetProfileManager } from "@/components/settings/TargetProfileManager";
import { AppAssignmentPicker } from "@/components/settings/AppAssignmentPicker";
import { ProfileEditor } from "@/components/settings/ProfileEditor";
import { ProfileList } from "@/components/settings/ProfileList";
import { appIdentityForCurrentBundle } from "@/components/settings/useAppIdentity";
import { defaultSettings } from "@/store/notesStore";
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
    ["requireRedaction", "要求逐项处理"],
    ["confirmRaw", "提示项原文需确认"],
    ["allowRaw", "允许原文（高风险二次确认）"],
  ] as const)("规则摘要区分检查开关和 %s 的命中处理策略", (privacyPolicy, label) => {
    const configured = profile("rules", { privacyPolicy });
    const active = renderToStaticMarkup(<DeliveryPolicySummary profile={configured} privacyCapabilityActive />);
    expect(active).toContain("发现敏感内容");
    expect(active).toContain(label);
    expect(active).toContain("已开启");
    expect(active).not.toMatch(/自动脱敏|已保护|绝对安全/);
    const disabled = renderToStaticMarkup(<DeliveryPolicySummary profile={configured} privacyCapabilityActive={false} />);
    expect(disabled).toContain("已关闭 · 不检查");
    expect(disabled).toContain(`${label}（检查关闭时不生效）`);
  });

  it.each(["发送方案", "默认发送方式", "粘贴后动作", "敏感内容处理"])("搜索 %s 首帧即可找到已展开的设置", (searchTarget) => {
    const html = renderToStaticMarkup(
      <TargetProfileManager settings={defaultSettings()} patch={vi.fn()} searchTarget={searchTarget} searchSequence={1} />
    );
    expect(html).toContain('id="target-profile-management"');
    expect(html).toContain(`data-settings-search="${searchTarget}"`);
    expect(html).toContain('data-settings-search="默认发送方式"');
    expect(html).toContain('data-settings-search="敏感内容处理"');
  });

  it("默认展开应用优先管理，高级共享管理收起，方案深链首帧展开高级管理", () => {
    const settings = defaultSettings();
    const initial = renderToStaticMarkup(<TargetProfileManager settings={settings} patch={vi.fn()} />);
    expect(initial).toContain("管理应用粘贴规则");
    expect(initial).toMatch(/<details[^>]*id="target-profile-management"[^>]*open=""/);
    expect(initial).toContain('aria-label="应用列表"');
    expect(initial).toContain('aria-label="搜索应用或方案"');
    expect(initial).toContain('data-settings-search="默认发送方式"');
    expect(initial).toContain('data-settings-search="敏感内容处理"');
    expect(initial).toMatch(/id="target-profile-advanced"[\s\S]*?aria-expanded="false"/);
    expect(initial).not.toContain('data-profile-select=');
    const linked = renderToStaticMarkup(
      <TargetProfileManager settings={settings} patch={vi.fn()} requestedProfileId={settings.defaultTargetProfileId} requestSequence={1} />
    );
    expect(linked).toMatch(/id="target-profile-advanced"[\s\S]*?aria-expanded="true"/);
    expect(linked).toContain('data-profile-select=');
    expect(linked).toContain('data-settings-search="默认发送方式"');
    expect(linked).toContain('data-settings-search="敏感内容处理"');
  });

  it("检查关闭时不把已保存隐私策略描述成正在生效的保护", () => {
    const edited = profile("default", { privacyPolicy: "allowRaw", enterPolicy: "allow" });
    const html = renderToStaticMarkup(
      <ProfileEditor
        profile={edited}
        profiles={[edited]}
        groups={groups}
        snippets={snippets}
        defaultProfileId={edited.id}
        firewallEnabled={false}
        currentTarget={target}
        recentApps={[]}
        onUpdate={vi.fn()}
        onProfilesChange={vi.fn()}
        onSetDefault={vi.fn()}
      />
    );
    expect(html).toContain("全局隐私检查已关闭，这项规则暂不生效");
    expect(html).toContain("隐私检查开启时，保留高风险原文不会自动按回车");
    expect(html).toContain("隐私检查开启时，敏感内容仍需明确处理");
  });

  it.each([
    ["exact", [profile("default"), profile("otty", { name: "AI 对话", bundleIds: [target.bundleId as string] })], "已为 Otty 指定"],
    ["fallback", [profile("default", { name: "稳妥发送" })], "未识别应用的默认方案"],
    ["conflict", [profile("first", { bundleIds: [target.bundleId as string] }), profile("second", { bundleIds: [target.bundleId as string] })], "重复绑定冲突"],
  ] as const)("当前粘贴目标卡准确展示 %s，默认规则先于匹配详情", (_source, profiles, expectedReason) => {
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

    expect(html).toContain("当前粘贴目标");
    expect(html).toContain("可粘贴");
    expect(html).toContain(expectedReason);
    expect(html).toContain("已关闭 · 不检查");
    expect(html).toContain("检查关闭时不生效");
    expect(html).toContain('aria-label="Otty 应用图标"');
    expect(html).toContain('aria-label="重新识别粘贴目标"');
    expect(html).toContain("检查规则");
    expect(html).not.toContain("测试当前目标");
    expect(html).toContain("本次临时调整以主面板为准");
    expect(html.split("<details")[0]).toContain("调整粘贴规则");
    expect(html.split("<details")[0]).not.toContain("规则来源");
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
    expect(unavailable).toContain("应用已退出");
    expect(unavailable).toContain("位置未确认前不会粘贴");

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
      "粘贴格式",
      "粘贴后动作",
      "敏感内容处理",
      "名称、应用与模板组",
      "规则生效预览",
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
    expect(html).toContain("隐私检查已开启");
    expect(html).toContain("每个敏感项都需替换或明确保留");
    expect(html).toContain("只调整“其他模板”的显示顺序，不会自动套用模板");
    expect(html).toContain("配置值");
    expect(html).toContain("测试预演值（不影响当前发送）");
    expect(html).toContain("匹配来源：仅本次手动选择");
    expect(html).toContain("应用默认生效值");
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
    expect(html).toContain("不包含主面板的本次临时调整");
    expect(html).toContain('type="radio"');
    expect(html).toContain("sm:grid-cols-3");
    expect(html).not.toContain("overflow-x-auto");
    const primary = html.split("<details")[0];
    expect(primary).toContain('data-settings-search="默认发送方式"');
    expect(primary).toContain('data-settings-search="粘贴后动作"');
    expect(primary).toContain('data-settings-search="敏感内容处理"');
    expect(primary).not.toMatch(/aria-label="[^"]* 方案名称"/);
    expect(primary).not.toContain("添加当前目标应用");
    expect(primary).not.toContain("提示词组 · 数量 · 摘要");
    expect(primary).not.toContain("测试内容（可编辑");
    expect(html.match(/<details\b[^>]*>/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details\b[^>]*\bopen(?:=|>)/);
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
    expect(currentTarget).toMatch(/粘贴格式<\/dt><dd[^>]*>无 Markdown/);
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

  it("应用默认生效值不把编辑预演冒充为 fallback，并展示安全收紧", () => {
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
      /测试预演值（不影响当前发送）[\s\S]*粘贴后动作：自动按回车 · 高风险[\s\S]*应用默认生效值[\s\S]*粘贴后动作：从不按回车/
    );
    expect(html).toContain("默认回退已收紧为从不按回车");
  });

  it("应用默认生效值保留历史冲突来源，不被编辑预演遮蔽", () => {
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
      /应用默认生效值[\s\S]*匹配来源：重复绑定冲突/
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
