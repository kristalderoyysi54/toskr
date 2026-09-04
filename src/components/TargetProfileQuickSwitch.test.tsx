import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TargetProfileQuickSwitch } from "@/components/TargetProfileQuickSwitch";
import {
  profileDiffSummary,
  quickSwitchKeyboardCommand,
  type QuickProfileOption,
} from "@/lib/targetLens";

const profiles: QuickProfileOption[] = [
  {
    id: "terminal",
    name: "终端发送",
    promptGroupId: "terminal-qa",
    promptGroupName: "终端问答",
    defaultFormat: "code",
    defaultMarkdownMode: "preserve",
    enterPolicy: "allow",
    keepPanel: false,
  },
  {
    id: "writing",
    name: "写作",
    promptGroupId: "writing-polish",
    promptGroupName: "文字润色",
    defaultFormat: "plain",
    defaultMarkdownMode: "preserve",
    enterPolicy: "confirm",
    keepPanel: true,
  },
  {
    id: "research",
    name: "研究",
    promptGroupId: "deep-research",
    promptGroupName: "深度研究",
    defaultFormat: "plain",
    defaultMarkdownMode: "preserve",
    enterPolicy: "never",
    keepPanel: false,
  },
  {
    id: "fourth",
    name: "第四项不应出现",
    promptGroupId: "misc",
    promptGroupName: "其他",
    defaultFormat: "plain",
    defaultMarkdownMode: "preserve",
    enterPolicy: "never",
    keepPanel: false,
  },
];

describe("TargetProfileQuickSwitch", () => {
  it("展示发送决策上下文、最多三个方案和真实隐私状态", () => {
    const html = renderToStaticMarkup(
      <TargetProfileQuickSwitch
        appName="Otty"
        icon={null}
        status="ready"
        matchReason="已为 Otty 指定"
        currentProfile={profiles[0]}
        candidates={profiles}
        privacyCapabilityActive={false}
        temporaryProfileId="terminal"
        automaticProfileName="终端发送"
        canMakePermanent
        onSelectTemporary={vi.fn()}
        onRestoreAutomatic={vi.fn()}
        onMakePermanent={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(html).toContain("发送到 Otty");
    expect(html).toContain("可发送");
    expect(html).toContain("已为 Otty 指定");
    expect(html).toContain("终端发送");
    // A 版台账：键值拆分渲染，警示值完整携带风险措辞
    expect(html).toContain("本次生效规则");
    expect(html).toContain(">粘贴后</dt>");
    expect(html).toContain("自动按回车 · 高风险");
    expect(html).toContain(">完成后</dt>");
    expect(html).toContain(">隐私检查</dt>");
    expect(html).toContain("尚未启用");
    // 重复区块与系统术语前缀不再出现
    expect(html).not.toContain("当前发送方案");
    expect(html).not.toContain("匹配来源：");
    // 选中项用「当前」胶囊标注；候选副行只报与当前的差异
    expect(html).toContain(">当前</span>");
    expect(html).toContain("输出改为原文");
    expect(html).toContain("以后发给 Otty 都使用此方案");
    expect(html).toContain('title="编辑 Otty 的发送方案"');
    expect(html).toContain("编辑方案");
    expect(html).toContain('title="恢复自动匹配：终端发送"');
    expect(html).toContain("恢复自动匹配");
    expect(html).not.toContain("第四项不应出现");
    expect(html).not.toMatch(/要求脱敏|已脱敏|已保护/);
    expect(html).not.toContain("回车：自动回车");
    expect(html.match(/data-quick-profile-option/g)).toHaveLength(3);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain('tabindex="0"');
  });

  it("差异摘要只报不同维度，回车差异必须携带风险措辞", () => {
    expect(profileDiffSummary(profiles[1], profiles[0])).toEqual([
      "提示词组改为文字润色",
      "输出改为原文",
      "粘贴后改为每次发送前确认",
      "完成后保持打开",
    ]);
    expect(profileDiffSummary(profiles[0], profiles[2])).toContain(
      "粘贴后改为自动按回车 · 高风险"
    );
    expect(profileDiffSummary(profiles[0], profiles[0])).toEqual([]);
    expect(profileDiffSummary(
      { ...profiles[1], defaultMarkdownMode: "strip" },
      profiles[0]
    )).toContain("输出改为无 Markdown");
  });

  it("Arrow 循环移动，Enter 选择，Escape 关闭", () => {
    expect(quickSwitchKeyboardCommand("ArrowDown", 0, 3)).toEqual({
      type: "move",
      index: 1,
    });
    expect(quickSwitchKeyboardCommand("ArrowUp", 0, 3)).toEqual({
      type: "move",
      index: 2,
    });
    expect(quickSwitchKeyboardCommand("Enter", 2, 3)).toEqual({
      type: "select",
      index: 2,
    });
    expect(quickSwitchKeyboardCommand("Escape", 1, 3)).toEqual({
      type: "close",
    });
  });

  it("目标失效时锁定临时与永久切换，长规则最多展示两行", () => {
    const html = renderToStaticMarkup(
      <TargetProfileQuickSwitch
        appName="一个非常长的目标应用名称用于验证窄窗口"
        icon={null}
        status="blocked"
        matchReason="目标应用已失效"
        currentProfile={{
          ...profiles[0],
          name: "一个非常长的发送方案名称用于验证窄窗口",
          promptGroupName: "一个非常长的提示词组名称用于验证最多两行",
        }}
        candidates={profiles.slice(0, 3)}
        privacyCapabilityActive={false}
        temporaryProfileId="terminal"
        automaticProfileName="终端发送"
        canMakePermanent={false}
        onSelectTemporary={vi.fn()}
        onRestoreAutomatic={vi.fn()}
        onMakePermanent={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(html).toContain("目标已失效");
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).not.toContain("以后发给");
    expect(html).toContain("line-clamp-2");
    expect(html).toContain("break-words");
    expect(html).toContain('aria-live="off"');
  });
});
