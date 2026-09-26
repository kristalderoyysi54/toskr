import type { OnboardingEvent } from "@/lib/onboarding";

export type WelcomeTourExitMode = "use-now" | "rehearse";

export const WELCOME_TOUR_COPY = {
  title: "把散落各处的文字，一次安全地交给 AI",
  points: [
    "选中文字，连按两次快捷键收成卡片",
    "勾选多张，⌘⏎ 合成一次粘贴",
    "邮箱、密钥等敏感信息发送前自动替换",
  ],
} as const;

/** 触发键在动画键帽里的符号。 */
export const CAPTURE_KEY_SYMBOL = { shift: "⇧", control: "⌃", option: "⌥" } as const;

/** 导览与演练解耦：只有用户主动选示例时才启动状态机。 */
export function welcomeTourExitEvent(
  mode: WelcomeTourExitMode
): OnboardingEvent | null {
  return mode === "rehearse" ? { type: "start" } : null;
}
