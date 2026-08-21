import type { OnboardingEvent } from "@/lib/onboarding";

export type WelcomeTourExitMode = "use-now" | "rehearse";

export const WELCOME_TOUR_COPY = [
  {
    mini: "来源应用 → Toskr → AI 输入框",
    title: "AI 消息中转站",
    body: "把各个应用里的文字和图片收进 Toskr。整理、组合并检查隐私后，再粘贴到当前 AI 输入框。",
  },
  {
    mini: "选中内容 · 双击 ⇧ Shift",
    title: "从其他应用收集内容",
    body: "选中文字后连按两次 ⇧ Shift，内容会变成卡片。图片和剪贴板内容也能加入，之后可一起整理。",
  },
  {
    mini: "选卡片 · 排顺序 · ⌘ Enter",
    title: "整理后粘贴到目标",
    body: "勾选卡片并调整顺序。按 ⌘ Enter，Toskr 会切回目标应用并粘贴。默认不按回车，请先确认光标位置。",
  },
  {
    mini: "文字替换 · 图片遮挡",
    title: "粘贴前检查隐私",
    body: "邮箱、手机号、IP 等文字可在本机识别并替换。图片可用本机 OCR 生成遮挡副本，原图不变；人脸和二维码不在检查范围。",
  },
] as const;

/** 导览与演练解耦：只有用户主动选示例时才启动状态机。 */
export function welcomeTourExitEvent(
  mode: WelcomeTourExitMode
): OnboardingEvent | null {
  return mode === "rehearse" ? { type: "start" } : null;
}
