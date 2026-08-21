import type { OnboardingState } from "@/lib/onboarding";

export type SafeDeliveryLearningTaskId =
  | "permissions"
  | "capture"
  | "safe-send"
  | "restore";

export interface SafeDeliveryLearningTask {
  id: SafeDeliveryLearningTaskId;
  title: string;
  description: string;
  status: "done" | "current" | "locked";
}

const TASKS = [
  {
    id: "permissions",
    title: "完成权限检查",
    description: "确认辅助功能与输入监控可以正常工作",
  },
  {
    id: "capture",
    title: "捕获第一条内容",
    description: "用假邮箱示例体验双击 ⇧ Shift 捕获",
  },
  {
    id: "safe-send",
    title: "体验安全发送",
    description: "用假数据完成一次脱敏发送，不会自动回车",
  },
  {
    id: "restore",
    title: "恢复脱敏结果",
    description: "把 [EMAIL_01] 只在本机恢复为原文",
  },
] as const;

/** 将原五步演练收敛为四个用户任务；状态只来自既有本机 onboarding。 */
export function safeDeliveryLearningTasks(
  onboarding: OnboardingState
): SafeDeliveryLearningTask[] {
  const completed = [
    onboarding.permissionsCompletedAtMs !== null ||
      onboarding.captured ||
      onboarding.sent,
    onboarding.captured || onboarding.sent,
    onboarding.sent,
    onboarding.recoveryTutorialCompletedAtMs !== null,
  ];
  const currentIndex = completed.findIndex((done) => !done);

  return TASKS.map((task, index) => ({
    ...task,
    status: completed[index]
      ? "done"
      : index === currentIndex
        ? "current"
        : "locked",
  }));
}
