import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { onboardingStateFromPersisted } from "@/lib/onboarding";
import {
  SafeDeliveryRehearsalView,
  type SafeDeliveryRehearsalViewProps,
} from "./SafeDeliveryRehearsal";

function props(
  overrides: Partial<SafeDeliveryRehearsalViewProps> = {}
): SafeDeliveryRehearsalViewProps {
  return {
    onboarding: onboardingStateFromPersisted(undefined),
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
    onDefer: vi.fn(),
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
    expect(denied).toContain('aria-label="安全发送演练"');
    expect(denied).toContain("辅助功能尚未授权");
    expect(denied).toContain("打开辅助功能设置");

    const blocked = renderToStaticMarkup(
      <SafeDeliveryRehearsalView
        {...props({ permissionStatus: "inputMonitoringBlocked" })}
      />
    );
    expect(blocked).toContain("键盘事件被系统拦截");
    expect(blocked).toContain("一键重置授权");
  });

  it("示例捕获说明包含明显假邮箱，不显示 60 秒倒计时", () => {
    const state = {
      ...onboardingStateFromPersisted(undefined),
      rehearsalStep: "capture" as const,
    };
    const html = renderToStaticMarkup(
      <SafeDeliveryRehearsalView {...props({ onboarding: state })} />
    );
    expect(html).toContain("demo.user@example.com");
    expect(html).toContain("复制演练示例");
    expect(html).not.toMatch(/60\s*秒/);
  });

  it("目标步骤不把未就绪目标伪装成可确认", () => {
    const state = {
      ...onboardingStateFromPersisted(undefined),
      rehearsalStep: "target" as const,
      rehearsalNoteId: "sample-note",
    };
    const html = renderToStaticMarkup(
      <SafeDeliveryRehearsalView
        {...props({ onboarding: state, targetReady: false })}
      />
    );
    expect(html).toContain("请先打开一个安全目标");
    expect(html).not.toContain("确认这个目标");
  });

  it("预检步骤明确显示 Firewall、finalText 与回车安全锁", () => {
    const state = {
      ...onboardingStateFromPersisted(undefined),
      rehearsalStep: "firewall" as const,
      rehearsalNoteId: "sample-note",
    };
    const html = renderToStaticMarkup(
      <SafeDeliveryRehearsalView {...props({ onboarding: state })} />
    );
    expect(html).toContain("Context Firewall");
    expect(html).toContain("finalText");
    expect(html).toContain("自动回车始终关闭");
    expect(html).toContain("打开演练预检");
  });
});
