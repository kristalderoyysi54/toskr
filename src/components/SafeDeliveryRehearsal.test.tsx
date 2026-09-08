import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { onboardingAfter, onboardingStateFromPersisted } from "@/lib/onboarding";
import {
  SafeDeliveryRehearsalView,
  type SafeDeliveryRehearsalViewProps,
} from "./SafeDeliveryRehearsal";

function activeOnboarding() {
  return {
    ...onboardingStateFromPersisted(undefined),
    rehearsalStatus: "active" as const,
    rehearsalActive: true,
  };
}

function props(
  overrides: Partial<SafeDeliveryRehearsalViewProps> = {}
): SafeDeliveryRehearsalViewProps {
  return {
    onboarding: activeOnboarding(),
    permissionStatus: "ready",
    targetReady: false,
    targetName: "尚未识别",
    onContinuePermissions: vi.fn(),
    onCopySample: vi.fn(),
    onRefreshTarget: vi.fn(),
    onConfirmTarget: vi.fn(),
    onOpenPreflight: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onSkip: vi.fn(),
    onOpenAccessibility: vi.fn(),
    onOpenInputMonitoring: vi.fn(),
    onResetInputMonitoring: vi.fn(),
    ...overrides,
  };
}

describe("安全发送演练 UI", () => {
  it("权限状态提供不同、可访问且可行动的反馈", () => {
    const denied = renderToStaticMarkup(
      <SafeDeliveryRehearsalView
        {...props({ permissionStatus: "accessibilityDenied" })}
      />
    );
    expect(denied).toContain('aria-label="上手教程"');
    expect(denied).toContain("先允许 Toskr 读取选中的文字");
    expect(denied).toContain("打开辅助功能设置");

    const blocked = renderToStaticMarkup(
      <SafeDeliveryRehearsalView
        {...props({ permissionStatus: "inputMonitoringBlocked" })}
      />
    );
    expect(blocked).toContain("还需要允许 Toskr 接收按键");
    expect(blocked).toContain("重置输入监控授权");
  });

  it("示例捕获说明包含明显假邮箱，不显示 60 秒倒计时", () => {
    const state = {
      ...activeOnboarding(),
      rehearsalStep: "capture" as const,
    };
    const html = renderToStaticMarkup(
      <SafeDeliveryRehearsalView {...props({ onboarding: state })} />
    );
    expect(html).toContain("demo.user@example.com");
    expect(html).toContain("复制示例文字");
    expect(html).not.toMatch(/60\s*秒/);
    expect(html).not.toContain("连按两次");
  });

  it("复制成功后展开跨应用步骤，跟随当前快捷键，不提前算作捕获完成", () => {
    const ready = onboardingAfter(activeOnboarding(), { type: "permissionsReady" });
    const copied = onboardingAfter(ready, { type: "samplePrepared" });
    const html = renderToStaticMarkup(
      <SafeDeliveryRehearsalView {...props({ onboarding: copied, captureKeyLabel: "⌥ Option" })} />
    );
    expect(html).toContain("打开「文本编辑」等空白文档");
    expect(html).toContain("选中刚粘贴的整段文字");
    expect(html).toContain("⌥ Option");
    expect(html).not.toContain("⇧ Shift");
    expect(html).toContain("按下、松开，再按一下");
    expect(html).toContain("重新复制示例");
    expect(copied.captured).toBe(false);
    expect(copied.rehearsalStep).toBe("capture");
    expect(html).not.toContain("示例内容已收好");
    const paused = onboardingAfter(copied, { type: "pause" });
    const resumed = onboardingAfter(paused, { type: "resume" });
    expect(resumed.rehearsalStep).toBe("capture");
    expect(resumed.activationStartedAtMs).toBe(copied.activationStartedAtMs);
  });

  it("隐私检查与粘贴共享第三步，打开检查页不算完成", () => {
    let state = onboardingAfter(activeOnboarding(), { type: "permissionsReady" });
    state = onboardingAfter(state, { type: "sampleCaptured", noteId: "sample" });
    state = onboardingAfter(state, { type: "targetConfirmed" });
    const before = renderToStaticMarkup(<SafeDeliveryRehearsalView {...props({ onboarding: state })} />);
    state = onboardingAfter(state, { type: "preflightOpened" });
    const after = renderToStaticMarkup(<SafeDeliveryRehearsalView {...props({ onboarding: state })} />);
    const progress = (html: string) => html.match(/<ol aria-label="教程进度".*?<\/ol>/)?.[0];
    expect(progress(before)).toBeDefined();
    expect(progress(after)).toBe(progress(before));
    expect(progress(after)?.match(/<li/g)).toHaveLength(3);
    expect(state.sent).toBe(false);
    expect(state.done).toBe(false);
    expect(after).toContain("继续检查并粘贴");
  });

  it("目标步骤不把未就绪目标伪装成可确认", () => {
    const state = {
      ...activeOnboarding(),
      rehearsalStep: "target" as const,
      rehearsalNoteId: "sample-note",
    };
    const html = renderToStaticMarkup(
      <SafeDeliveryRehearsalView
        {...props({ onboarding: state, targetReady: false })}
      />
    );
    expect(html).toContain("还没有可用的粘贴位置");
    expect(html).not.toContain("就粘贴到这里");
  });

  it("已识别应用但方案待确认时，指向顶部确认，不误报目标丢失", () => {
    const html = renderToStaticMarkup(
      <SafeDeliveryRehearsalView {...props({
        onboarding: { ...activeOnboarding(), rehearsalStep: "target", rehearsalNoteId: "existing-sample" },
        targetNeedsConfirmation: true,
        targetName: "文本编辑",
      })} />
    );
    expect(html).toContain("示例内容已收好");
    expect(html).toContain("demo.user@example.com");
    expect(html).toContain("已识别到 文本编辑");
    expect(html).toContain("请先在面板顶部点击");
    expect(html).not.toContain("还没有可用的粘贴位置");
    expect(html).not.toContain("就粘贴到这里");
  });

  it("预检步骤明确显示隐私检查、最终正文与回车安全锁，无英文术语泄漏", () => {
    const state = {
      ...activeOnboarding(),
      rehearsalStep: "firewall" as const,
      rehearsalNoteId: "sample-note",
    };
    const html = renderToStaticMarkup(
      <SafeDeliveryRehearsalView {...props({ onboarding: state })} />
    );
    expect(html).toContain("下一页会标出示例里的邮箱");
    expect(html).toContain("检查正文");
    expect(html).not.toContain("finalText");
    expect(html).not.toContain("Firewall");
    expect(html).toContain("不会自动按回车");
    expect(html).toContain("查看要粘贴的内容");
  });

  it("暂停和退出使用两个明确动作", () => {
    const html = renderToStaticMarkup(
      <SafeDeliveryRehearsalView
        {...props({
          onboarding: activeOnboarding(),
        })}
      />
    );
    expect(html).toContain("稍后继续");
    expect(html).toContain("退出教程");
    expect(html).not.toContain("稍后在真实应用演练");
  });
});
