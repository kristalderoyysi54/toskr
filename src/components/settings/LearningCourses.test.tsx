import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LearningCourses } from "@/components/settings/LearningCourses";
import {
  onboardingAfter,
  onboardingStateFromPersisted,
  type OnboardingState,
} from "@/lib/onboarding";
import { safeDeliveryLearningTasks } from "@/lib/safeDeliveryLearningPath";

const render = (onboarding: OnboardingState) =>
  renderToStaticMarkup(
    <LearningCourses
      onboarding={onboarding}
      onRunRehearsal={vi.fn()}
      onStartLesson={vi.fn()}
      onReplayTour={vi.fn()}
    />
  );
const fresh = () => onboardingStateFromPersisted(undefined);

describe("上手课程卡", () => {
  it.each([null, 1_000])("权限准备 %s 不计作收集完成；进阶课锁定", (permissionsCompletedAtMs) => {
    const onboarding = { ...fresh(), permissionsCompletedAtMs };
    expect(safeDeliveryLearningTasks(onboarding).map((task) => task.status))
      .toEqual(["current", "locked", "locked"]);
    const html = render(onboarding);
    expect(html).toContain("3 步 · 已完成 0 / 3");
    expect(html.match(/先完成基础课/g)).toHaveLength(2);
    expect(html).toContain("重看导览");
  });

  it.each([
    { rehearsalStep: "target" as const, statuses: ["done", "current", "locked"] },
    { rehearsalStep: "firewall" as const, statuses: ["done", "done", "current"] },
    { rehearsalStep: "delivery" as const, statuses: ["done", "done", "current"] },
  ])("$rehearsalStep 阶段与面板教程的三步进度对应", ({ rehearsalStep, statuses }) => {
    const onboarding = { ...fresh(), captured: true, rehearsalNoteId: "sample-note", rehearsalStep };
    expect(safeDeliveryLearningTasks(onboarding).map((task) => task.status)).toEqual(statuses);
  });

  it("只有步骤标记而缺少示例卡片不能宣称位置已确认", () => {
    const onboarding = { ...fresh(), captured: true, rehearsalStep: "firewall" as const };
    expect(safeDeliveryLearningTasks(onboarding).map((task) => task.status))
      .toEqual(["done", "current", "locked"]);
  });

  it("已退出或旧完成标记不能替代真实发送完成", () => {
    const html = render({
      ...fresh(),
      captured: true,
      done: true,
      rehearsalStatus: "skipped",
      rehearsalStep: "complete",
    });
    expect(html).toContain("已完成 1 / 3");
    expect(html).toContain("先完成基础课");
  });

  it.each(["active", "paused"] as const)("%s 基础课提供继续入口", (rehearsalStatus) => {
    const html = render({ ...fresh(), rehearsalStatus, captured: true, rehearsalNoteId: "n", rehearsalStep: "target" });
    expect(html).toContain(">继续<");
  });

  it("基础课完成后解锁进阶课，完成标记分别显示", () => {
    const base = { ...fresh(), captured: true, sent: true, done: true, rehearsalStep: "complete" as const };
    const unlocked = render(base);
    expect(unlocked).toContain("重新练习");
    expect(unlocked).not.toContain("先完成基础课");
    expect(unlocked).not.toContain("再练一次");

    const merged = onboardingAfter(base, { type: "mergeTutorialCompleted" }, 5_000);
    expect(merged.mergeTutorialCompletedAtMs).toBe(5_000);
    const html = render(onboardingAfter(merged, { type: "recoveryTutorialCompleted" }, 6_000));
    expect(html.match(/再练一次/g)).toHaveLength(2);
    expect(html).toContain("合并发送");
    expect(html).toContain("智能脱敏与还原");
  });

  it("旧数据没有合并课字段也能读入，完成时间不被重复覆盖", () => {
    const legacy = { ...fresh() } as Record<string, unknown>;
    delete legacy.mergeTutorialCompletedAtMs;
    const decoded = onboardingStateFromPersisted(legacy);
    expect(decoded.mergeTutorialCompletedAtMs).toBeNull();
    const first = onboardingAfter(decoded, { type: "mergeTutorialCompleted" }, 1_000);
    expect(onboardingAfter(first, { type: "mergeTutorialCompleted" }, 2_000).mergeTutorialCompletedAtMs).toBe(1_000);
  });
});
