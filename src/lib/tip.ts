import { api, type HudKind } from "@/lib/tauri";
import { useUIStore } from "@/store/uiStore";

/** 播报代际：新 tip 到来时作废旧的清空定时器（单槽语义与 HUD 一致）。 */
let announceGen = 0;

/**
 * 统一提示通道：所有 tips 走屏幕右上角 HUD 气泡（与捕获/发送提示同一形态）。
 * 隐身模式下非 warn 气泡由 Rust 侧统一抑制。
 * 同时把文案镜像进面板内的 sr-only live region——HUD 是独立无焦点窗口，
 * 屏幕阅读器听不到；此镜像只覆盖主面板自身触发的动作（架构局限，见计划文档）。
 */
export function tip(
  kind: HudKind,
  text: string,
  undoable = false,
  targetId?: string
) {
  void api.hudFeedback(kind, text, undoable, false, targetId).catch(() => {
    /* Tauri 环境外忽略 */
  });
  if (text) {
    const gen = ++announceGen;
    useUIStore.getState().setAnnounce(text);
    window.setTimeout(() => {
      if (gen === announceGen) useUIStore.getState().setAnnounce("");
    }, 1500);
  }
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
