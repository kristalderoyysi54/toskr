import { invoke } from "@tauri-apps/api/core";

/** 预览窗只能通过原生白名单向主窗口提交编辑动作。 */
export function emitToMain(target: string, event: string, payload: unknown): Promise<void> {
  if (target !== "main") return Promise.reject(new Error("预览动作只能发往主窗口"));
  return invoke("preview_event", { event, payload });
}
