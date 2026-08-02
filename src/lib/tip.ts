import { api, type HudKind } from "@/lib/tauri";

/**
 * 统一提示通道：所有 tips 走屏幕右上角 HUD 气泡（与捕获/发送提示同一形态）。
 * 隐身模式下非 warn 气泡由 Rust 侧统一抑制。
 */
export function tip(kind: HudKind, text: string, undoable = false) {
  void api.hudFeedback(kind, text, undoable).catch(() => {
    /* Tauri 环境外忽略 */
  });
}

/** HUD「撤销」按钮的待执行动作（一次性，后写覆盖前写）。 */
let pendingUndo: (() => void) | null = null;

export function setPendingUndo(fn: () => void) {
  pendingUndo = fn;
}

/** HUD 撤销点击回执：执行并清空当前待撤销动作。 */
export function runPendingUndo() {
  const fn = pendingUndo;
  pendingUndo = null;
  if (fn) fn();
  else tip("undone", "没有可撤销的操作");
}
