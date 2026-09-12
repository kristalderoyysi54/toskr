import type { HudPayload } from "@/lib/tauri";

/**
 * H1（2026-09-12 用户选定）：需要用户处理的提示（可撤销 / 可点击跳转 / 到期 / 粘性）
 * 走头像说话气泡；其余纯告知类（已发送、完成、提示、发送失败无重试）走单行药丸。
 */
export function hudActionable(item: HudPayload): boolean {
  return !!item.undoable || !!item.sticky || item.kind === "due" || !!item.targetId;
}
