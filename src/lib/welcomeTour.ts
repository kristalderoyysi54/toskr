import type { OnboardingEvent } from "@/lib/onboarding";

export type WelcomeTourExitMode = "use-now" | "rehearse";

export const WELCOME_TOUR_COPY = {
  title: "AI 消息中转站",
  body: "把其他应用里的文字收成卡片，再一起粘贴到 AI 输入框。先试着收一条内容。",
  sample: "周五前完成首页设计稿。",
} as const;

/** 导览与演练解耦：只有用户主动选示例时才启动状态机。 */
export function welcomeTourExitEvent(
  mode: WelcomeTourExitMode
): OnboardingEvent | null {
  return mode === "rehearse" ? { type: "start" } : null;
}
