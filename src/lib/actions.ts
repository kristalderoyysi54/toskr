import { buildSendText, formatAsNumberedList, wrapAsCodeBlock } from "@/lib/format";
import { api } from "@/lib/tauri";
import { setPendingUndo, tip } from "@/lib/tip";
import { noteImages, orderedCheckedNotes, useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 可撤销的操作确认（HUD 气泡悬停出「撤销」；撤销 = 弹出栈顶快照恢复）。 */
export function undoableTip(message: string) {
  setPendingUndo(() => {
    const label = useNotesStore.getState().undo();
    tip("undone", label ? "已撤销" : "没有可撤销的操作");
  });
  tip("ok", message, true);
}

/** 删除并给撤销机会。 */
export function deleteNotesWithUndo(ids: string[], label?: string) {
  if (!ids.length) return;
  const text = label ?? `已删除 ${ids.length} 条`;
  useNotesStore.getState().deleteNotes(ids, text);
  undoableTip(text);
}

/** 清理全部已完成卡片（带撤销）。 */
export function clearDoneWithUndo() {
  const n = useNotesStore.getState().clearDone();
  if (n > 0) undoableTip(`已清理 ${n} 条已完成`);
}

/** 合并勾选（带撤销）。 */
export function mergeCheckedWithUndo() {
  const ids = orderedCheckedNotes(useNotesStore.getState()).map((n) => n.id);
  if (ids.length < 2) return;
  useNotesStore.getState().mergeNotes(ids);
  undoableTip(`已合并 ${ids.length} 条`);
}

/** 把指定卡片与勾选项合并为一张卡（右键菜单入口；顺序按队列排列）。 */
export function mergeNoteWithChecked(noteId: string) {
  const state = useNotesStore.getState();
  const pick = new Set([...state.checkedIds, noteId]);
  const valid = state.notes.filter((n) => pick.has(n.id));
  if (valid.length < 2) return;
  state.mergeNotes(valid.map((n) => n.id));
  undoableTip(`已合并 ${valid.length} 条`);
}

/** 把指定笔记复制为编号列表到系统剪贴板。 */
export async function copyNotesAsList(ids: string[]) {
  const { notes } = useNotesStore.getState();
  const picked = new Set(ids);
  const texts = notes.filter((n) => picked.has(n.id)).map((n) => n.text);
  if (!texts.length) return;
  try {
    await api.copyText(formatAsNumberedList(texts));
    tip("ok", `已复制 ${texts.length} 条为列表`);
  } catch (e) {
    tip("warn", `复制失败：${e}`);
  }
}

/** 复制勾选项为编号列表。 */
export function copyCheckedAsList() {
  const state = useNotesStore.getState();
  return copyNotesAsList(orderedCheckedNotes(state).map((n) => n.id));
}

/**
 * 一键发送到当前对话。目标应用未到达前台时 Rust 会中止（返回 false），
 * 此时不标完成、保留勾选，由 HUD 提示用户。
 * `prefix`：Prompt 前缀模板（拼在内容前，Prompt 组装台）。
 */
export async function sendNotesToChat(
  ids: string[],
  prefix?: string,
  opts?: { asCode?: boolean }
) {
  const notesState = useNotesStore.getState();
  const picked = new Set(ids);
  const targets = notesState.notes.filter((n) => picked.has(n.id));
  if (!targets.length) return;

  // 图片卡片以真正的图片粘贴（写入剪贴板再 ⌘V），文本部分单独拼装，
  // 否则图片会退化成「图片 1867×391」这样的占位文字
  const textNotes = targets.filter((n) => n.kind !== "image");
  const imageFiles = [...new Set(targets.flatMap(noteImages))];

  let body = textNotes.length ? buildSendText(textNotes.map((n) => n.text)) : "";
  if (body && opts?.asCode) {
    // 代码块发送：单条用其检测到的语言，多条统一无语言标记
    body = wrapAsCodeBlock(
      body,
      textNotes.length === 1 ? textNotes[0].codeLang : undefined
    );
  }
  const text = prefix ? (body ? `${prefix}\n\n${body}` : prefix) : body;
  // 钉住 = 常驻：发送后保留面板，只把焦点交回目标应用
  const keepPanel = useUIStore.getState().pinned;
  if (!keepPanel) {
    // Rust 侧会直接 hide 窗口，这里同步收起状态、跳过退场动画与二次 hide。
    useUIStore.getState().setOpen(false);
  }
  try {
    const sent = await api.sendToChat(
      text,
      imageFiles,
      notesState.settings.autoEnter,
      keepPanel
    );
    if (sent) {
      const sentIds = targets.map((n) => n.id);
      useNotesStore.getState().setDone(sentIds, true);
      useNotesStore.getState().clearChecked();
      useNotesStore.getState().markOnboarding({ sent: true });
    }
  } catch (e) {
    tip("warn", `发送失败：${e}`);
  }
}

/** 发送全部勾选项（可带 Prompt 前缀模板）。 */
export function sendCheckedToChat(prefix?: string, opts?: { asCode?: boolean }) {
  const state = useNotesStore.getState();
  return sendNotesToChat(
    orderedCheckedNotes(state).map((n) => n.id),
    prefix,
    opts
  );
}
