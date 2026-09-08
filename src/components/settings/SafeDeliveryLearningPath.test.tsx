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
  it.each([null, 1_000])("权限准备状态 %s 不计作收集完成", (permissionsCompletedAtMs) => {
    const onboarding = {
      ...onboardingStateFromPersisted(undefined),
      permissionsCompletedAtMs,
    };
    const tasks = safeDeliveryLearningTasks(onboarding);
    const html = renderToStaticMarkup(
      <SafeDeliveryLearningPath onboarding={onboarding} {...callbacks} />
    );

    expect(tasks.map((task) => task.id)).toEqual(["capture", "target", "safe-send"]);
    expect(tasks.map((task) => task.status)).toEqual(["current", "locked", "locked"]);
    expect(html).toContain("0</span> / 3 已完成");
    expect(html).toContain("收进第一条内容");
    expect(html).not.toContain("准备快捷键");
  });

  it.each([
    { rehearsalStep: "target" as const, statuses: ["done", "current", "locked"], count: 1 },
    { rehearsalStep: "firewall" as const, statuses: ["done", "done", "current"], count: 2 },
    { rehearsalStep: "delivery" as const, statuses: ["done", "done", "current"], count: 2 },
  ])("$rehearsalStep 阶段与主教程的三步进度对应", ({ rehearsalStep, statuses, count }) => {
    const onboarding = {
      ...onboardingStateFromPersisted(undefined),
      permissionsCompletedAtMs: 1_000,
      captured: true,
      rehearsalNoteId: "sample-note",
      rehearsalStep,
    };

    expect(safeDeliveryLearningTasks(onboarding).map((task) => task.status))
      .toEqual(statuses);

    const html = renderToStaticMarkup(
      <SafeDeliveryLearningPath onboarding={onboarding} {...callbacks} />
    );
    expect(html).toContain("开始使用 Toskr");
    expect(html).toContain(`${count}</span> / 3 已完成`);
    expect(html).toContain("选择粘贴位置");
    expect(html).toContain("检查并粘贴");
    expect(html).toContain("不会自动回车");
    expect(html).toContain("可选进阶");
    expect(html).not.toContain("基础教程已完成");
    expect(html).not.toContain("Shift");
  });

  it("真实发送完成即完成基础教程，未体验恢复不阻碍完成", () => {
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

    expect(html).toContain("3 / 3 已完成");
    expect(html).toContain("基础教程已完成");
    expect(html).toContain("重新演练");
    expect(html).toContain("查看步骤");
    expect(html).toContain("体验恢复");
    expect(html).toContain("此项不计入基础教程进度");
    expect(html).not.toContain("收进第一条内容");
  });

  it("已完成的恢复教学只更新进阶区，不增加基础步骤", () => {
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

    expect(html).toContain("基础教程已完成");
    expect(html).toContain("3 / 3 已完成");
    expect(html).toContain("已体验");
    expect(html).toContain("再看一次");
    expect(safeDeliveryLearningTasks(onboarding)).toHaveLength(3);
  });

  it("已退出或旧完成标记不能替代真实发送完成", () => {
    const onboarding = {
      ...onboardingStateFromPersisted(undefined),
      captured: true,
      done: true,
      rehearsalStatus: "skipped" as const,
      rehearsalStep: "complete" as const,
      recoveryTutorialCompletedAtMs: 3_000,
    };
    const html = renderToStaticMarkup(
      <SafeDeliveryLearningPath onboarding={onboarding} {...callbacks} />
    );

    expect(html).toContain("1</span> / 3 已完成");
    expect(html).not.toContain("基础教程已完成");
    expect(html).toContain("开始教程");
  });

  it("只有步骤标记而缺少示例卡片不能宣称位置已确认", () => {
    const onboarding = {
      ...onboardingStateFromPersisted(undefined),
      captured: true,
      rehearsalStep: "firewall" as const,
    };

    expect(safeDeliveryLearningTasks(onboarding).map((task) => task.status))
      .toEqual(["done", "current", "locked"]);
  });

  it.each(["active", "paused"] as const)("%s 教程提供继续入口，收起不冒充暂停", (rehearsalStatus) => {
    const onboarding = {
      ...onboardingStateFromPersisted(undefined),
      rehearsalStatus,
      permissionsCompletedAtMs: 1_000,
      captured: true,
      rehearsalNoteId: "sample-note",
      rehearsalStep: "target" as const,
    };
    const html = renderToStaticMarkup(
      <SafeDeliveryLearningPath onboarding={onboarding} {...callbacks} />
    );

    expect(safeDeliveryLearningTasks(onboarding).map((task) => task.status))
      .toEqual(["done", "current", "locked"]);
    expect(html).toContain("继续教程");
    expect(html).toContain("收起教程");
    expect(html).not.toContain("稍后继续");
  });
});
