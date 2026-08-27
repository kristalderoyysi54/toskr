import { emitTo } from "@tauri-apps/api/event";

/**
 * 多文本详情窗路由（📌 固定并存，2026-08-27 用户需求）：
 * 主面板维护各详情窗的 {pinned, noteId} 注册表（窗口自报），开卡时挑窗——
 * 同卡复用 > 未固定窗复用 > 动态新窗（textpreview-N，Rust 侧按需创建）。
 * 新窗 webview 尚未挂载就 emit 会丢事件，载荷先入队、等窗口自报就绪再冲洗。
 */

export const DETAIL_STATE_EVENT = "toskr://detail-state";

export type DetailWindowState = {
  label: string;
  pinned: boolean;
  noteId: string | null;
};

const states = new Map<string, { pinned: boolean; noteId: string | null }>();
const pendingPayloads = new Map<string, { event: string; payload: unknown }>();

/** 详情窗自报状态（挂载/📌 切换/换卡都会报）；新窗首报视为就绪，冲洗待发载荷。 */
export function recordDetailWindowState(state: DetailWindowState) {
  const isNew = !states.has(state.label);
  states.set(state.label, { pinned: state.pinned, noteId: state.noteId });
  if (isNew) {
    const pending = pendingPayloads.get(state.label);
    if (pending) {
      pendingPayloads.delete(state.label);
      void emitTo(state.label, pending.event, pending.payload).catch(() => {});
    }
  }
}

export function detailWindowKnown(label: string): boolean {
  return states.has(label);
}

/** 全部已知详情窗标签（基础窗恒在，未上报前也要能收到广播类事件）。 */
export function detailWindowLabels(): string[] {
  const labels = new Set(["textpreview", ...states.keys()]);
  return [...labels];
}

/** 广播类事件（目标变化/字号/图片替换/编辑回执）发往所有详情窗。 */
export function emitToDetailWindows(event: string, payload: unknown) {
  for (const label of detailWindowLabels()) {
    void emitTo(label, event, payload).catch(() => {});
  }
}

/** 开卡挑窗：同卡复用 > 基础窗未固定 > 任一未固定窗 > 新标签。 */
export function pickDetailWindowLabel(noteId: string): string {
  for (const [label, s] of states) {
    if (s.noteId === noteId) return label;
  }
  if (!states.get("textpreview")?.pinned) return "textpreview";
  for (const [label, s] of states) {
    if (!s.pinned) return label;
  }
  let n = 2;
  while (states.has(`textpreview-${n}`)) n += 1;
  return `textpreview-${n}`;
}

/** 新窗未就绪前暂存载荷（每窗只留最后一份——后开的卡覆盖先开的）。 */
export function queueDetailPayload(label: string, event: string, payload: unknown) {
  pendingPayloads.set(label, { event, payload });
}
