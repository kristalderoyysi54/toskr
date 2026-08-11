import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { onboardingStateFromPersisted } from "@/lib/onboarding";
import { safeDeliveryLearningTasks } from "@/lib/safeDeliveryLearningPath";
import { SafeDeliveryLearningPath } from "./SafeDeliveryLearningPath";

const callbacks = {
  onRunRehearsal: vi.fn(),
  onCompleteRecoveryTutorial: vi.fn(),
};

describe("使用概览安全发送入门", () => {
  it("把原演练状态映射为四个可恢复任务", () => {
    const onboarding = {
      ...onboardingStateFromPersisted(undefined),
      permissionsCompletedAtMs: 1_000,
      captured: true,
    };

    expect(safeDeliveryLearningTasks(onboarding).map((task) => task.status))
      .toEqual(["done", "done", "current", "locked"]);

    const html = renderToStaticMarkup(
      <SafeDeliveryLearningPath onboarding={onboarding} {...callbacks} />
    );
    expect(html).toContain("开始使用 Toskr");
    expect(html).toContain("2</span> / 4 已完成");
    expect(html).toContain("体验安全发送");
    expect(html).toContain("不会自动回车");
    expect(html).toContain("恢复脱敏结果");
    expect(html).toContain("待完成");
  });

  it("发送完成后只解锁本地恢复教学，不伪装成全部完成", () => {
    const onboarding = {
      ...onboardingStateFromPersisted(undefined),
      captured: true,
      sent: true,
      done: true,
      rehearsalStep: "complete" as const,
    };
    const html = renderToStaticMarkup(
      <SafeDeliveryLearningPath onboarding={onboarding} {...callbacks} />
    );

    expect(html).toContain("3</span> / 4 已完成");
    expect(html).toContain("体验恢复");
    expect(html).toContain("把 [EMAIL_01] 只在本机恢复为原文");
    expect(html).not.toContain("安全发送入门已完成");
  });

  it("四项完成后收成一行，并保留查看和重跑入口", () => {
    const onboarding = {
      ...onboardingStateFromPersisted(undefined),
      captured: true,
      sent: true,
      done: true,
      rehearsalStep: "complete" as const,
      recoveryTutorialCompletedAtMs: 3_000,
    };
    const html = renderToStaticMarkup(
      <SafeDeliveryLearningPath onboarding={onboarding} {...callbacks} />
    );

    expect(html).toContain("安全发送入门已完成");
    expect(html).toContain("4 / 4 已完成");
    expect(html).toContain("重新演练");
    expect(html).toContain("查看任务");
    expect(html).not.toContain("完成权限检查");
  });
});
