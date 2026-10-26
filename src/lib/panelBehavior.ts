import type { TriggerPayload } from "@/lib/tauri";

type ToggleTrigger = Extract<TriggerPayload, { kind: "toggle" }>;

/** 键盘/双击唤出的面板在用户真正移动或按 Esc 前保持展开。 */
export function triggerKeepsPanelOpen(payload: ToggleTrigger): boolean {
  return payload.source === "hotkey" || payload.source === "doubleTap";
}

export function shouldHidePanelOnBlur(input: {
  open: boolean;
  pinned: boolean;
  hideOnBlur: boolean;
  shortcutHoldOpen: boolean;
  /** 预检、对话框、行内输入等后续界面存在（panelHold 的失焦豁免登记）。 */
  held?: boolean;
}): boolean {
  return (
    input.open && !input.pinned && input.hideOnBlur && !input.shortcutHoldOpen && !input.held
  );
}
