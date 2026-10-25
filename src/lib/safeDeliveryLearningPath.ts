import { t, type MessageKey } from "@/lib/i18n";
import type { OnboardingState } from "@/lib/onboarding";

export type SafeDeliveryLearningTaskId =
  | "capture"
  | "target"
  | "safe-send";

export interface SafeDeliveryLearningTask {
  id: SafeDeliveryLearningTaskId;
  title: string;
  description: string;
  status: "done" | "current" | "locked";
}

const TASKS: readonly {
  id: SafeDeliveryLearningTaskId;
  title: MessageKey;
  description: MessageKey;
}[] = [
  {
    id: "capture",
    title: "收进第一条内容",
    description: "选中示例文字，用快捷键把它变成一张卡片",
  },
  {
    id: "target",
    title: "选择粘贴位置",
    description: "打开空白文档，点击正文，再回 Toskr 确认粘贴位置",
  },
  {
    id: "safe-send",
    title: "检查并粘贴",
    description: "把示例邮箱替换后粘贴到空白文档，不会自动回车",
  },
];

/** 基础教程与主面板共用收集、确认位置和粘贴三步；权限是收集前的准备。 */
export function safeDeliveryLearningTasks(
  onboarding: OnboardingState
): SafeDeliveryLearningTask[] {
  const completed = [
    onboarding.captured || onboarding.sent,
    onboarding.sent ||
      (Boolean(onboarding.rehearsalNoteId) &&
        ["firewall", "delivery"].includes(onboarding.rehearsalStep)),
    onboarding.sent,
  ];
  const currentIndex = completed.findIndex((done) => !done);

  return TASKS.map((task, index) => ({
    ...task,
    title: t(task.title),
    description: t(task.description),
    status: completed[index]
      ? "done"
      : index === currentIndex
        ? "current"
        : "locked",
  }));
}
