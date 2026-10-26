import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { api } from "@/lib/tauri";

/**
 * 面板「暂不收起」登记：右键菜单、预检、对话框、行内输入等还有下一步的界面
 * 存在期间登记一条。任一登记在 → 贴边隐藏暂停光标计时（Rust panel_hold）；
 * `focus` 登记额外豁免失焦收起——右键菜单只挡光标计时，否则菜单开着切走应用
 * 面板就收不掉了。
 */
const holds = new Map<symbol, { reason: string; focus: boolean }>();
let synced = false;

/** 只有主面板窗口的登记作数（设置窗等也渲染右键菜单，但与面板收起无关）。 */
function isPanelWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label === "main";
  } catch {
    return false;
  }
}

function sync() {
  const next = holds.size > 0;
  if (next === synced) return;
  synced = next;
  if (!isPanelWindow()) return;
  void api.setPanelHold(next).catch(() => {});
}

/** `lingerMs`：释放后再保留一会儿——点完菜单项光标多半还停在面板外的小窗处，
 *  给用户把光标移回面板的时间，而不是立刻开始 600ms 宽限。 */
export function holdPanel(
  reason: string,
  opts: { focus?: boolean; lingerMs?: number } = {}
): () => void {
  const key = Symbol(reason);
  holds.set(key, { reason, focus: opts.focus ?? true });
  sync();
  return () => {
    const release = () => {
      if (holds.delete(key)) sync();
    };
    if (opts.lingerMs) window.setTimeout(release, opts.lingerMs);
    else release();
  };
}

/** 失焦收起是否应让路（存在豁免失焦的登记）。 */
export function panelHeldAgainstBlur(): boolean {
  for (const hold of holds.values()) if (hold.focus) return true;
  return false;
}

/** 当前登记原因（诊断用）。 */
export function panelHoldReasons(): string[] {
  return [...holds.values()].map((hold) => hold.reason);
}

export function usePanelHold(
  active: boolean,
  reason: string,
  opts: { focus?: boolean; lingerMs?: number } = {}
) {
  const { focus = true, lingerMs } = opts;
  useEffect(
    () => (active ? holdPanel(reason, { focus, lingerMs }) : undefined),
    [active, reason, focus, lingerMs]
  );
}
