import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TargetProfileQuickSwitch } from "@/components/TargetProfileQuickSwitch";
import {
  quickSwitchKeyboardCommand,
  type QuickProfileOption,
} from "@/lib/targetLens";

const profiles: QuickProfileOption[] = [
  {
    id: "terminal",
    name: "终端发送",
    promptGroupName: "终端问答",
    defaultFormat: "code",
    enterPolicy: "allow",
    keepPanel: false,
  },
  {
    id: "writing",
    name: "写作",
    promptGroupName: "文字润色",
    defaultFormat: "plain",
    enterPolicy: "confirm",
    keepPanel: true,
  },
  {
    id: "research",
    name: "研究",
    promptGroupName: "深度研究",
    defaultFormat: "plain",
    enterPolicy: "never",
    keepPanel: false,
  },
  {
    id: "fourth",
    name: "第四项不应出现",
    promptGroupName: "其他",
    defaultFormat: "plain",
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
    expect(html).toContain("当前发送方案");
    expect(html).toContain("终端发送");
    expect(html).toContain("本次真实生效规则");
    expect(html).toContain("粘贴后动作：自动按回车 · 高风险");
    expect(html).toContain("发送完成后：关闭面板");
    expect(html).toContain("匹配来源：已为 Otty 指定");
    expect(html).toContain("隐私检查：尚未启用");
    expect(html).toContain("以后发给 Otty 都使用此方案");
    expect(html).toContain("编辑 Otty 的发送方案");
    expect(html).toContain("恢复自动匹配：终端发送");
    expect(html).not.toContain("第四项不应出现");
    expect(html).not.toMatch(/要求脱敏|已脱敏|已保护/);
    expect(html).not.toContain("回车：自动回车");
    expect(html.match(/data-quick-profile-option/g)).toHaveLength(3);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain('tabindex="0"');
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
    expect(html).toContain("max-w-full");
    expect(html).toContain('aria-live="off"');
  });
});
