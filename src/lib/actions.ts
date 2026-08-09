import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask } from "@tauri-apps/plugin-dialog";

import {
  applyPromptTemplate,
  buildSendText,
  formatAsNumberedList,
  imageCaption,
  wrapAsCodeBlock,
} from "@/lib/format";
import {
  beginDataGenerationLease,
  currentDataGeneration,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import {
  api,
  isSendDeliveryResult,
  type SendDeliveryResult,
} from "@/lib/tauri";
import { setPendingUndo, tip } from "@/lib/tip";
import { currentTargetProfileResolution } from "@/lib/currentTargetProfile";
import type { TargetProfileResolution } from "@/lib/targetProfiles";
import {
  doneIdsAfterSend,
  noteImages,
  orderedCheckedNotes,
  useNotesStore,
  type Note,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import {
  clearTargetProfileOverride,
  currentTargetBlockMessage,
  refreshTarget,
  sameTargetIdentity,
  targetSendDisabled,
  useTargetStore,
} from "@/store/targetStore";

/** 可撤销的操作确认（HUD 气泡悬停出「撤销」；撤销 = 弹出栈顶快照恢复）。 */
export function undoableTip(message: string) {
  setPendingUndo(() => {
    const label = useNotesStore.getState().undo();
    tip("undone", label ? "已撤销" : "没有可撤销的操作");
  });
  tip("ok", message, true);
}

/**
 * 发送/保存被前置闸门拦截时的可见反馈：请求可能来自详情窗，而主面板正处于
 * 贴边隐藏或关闭状态——HUD 落在不可见窗口上等于毫无反馈。先把面板带回可见
 * 再警告，并落一条无正文的诊断脚注供事后排查。
 */
export function warnWithPanel(message: string, diagCode?: string) {
  useUIStore.getState().setOpen(true);
  try {
    void Promise.resolve(api.showPanel()).catch(() => {});
    void Promise.resolve(
      api.diagNote(`前端阻断: ${diagCode ?? message}`)
    ).catch(() => {});
  } catch {
    /* Tauri 环境外 */
  }
  tip("warn", message);
}

/** 文本详情窗的内容载荷（主面板 → textpreview 窗口）。 */
export type NotePreviewPayload = {
  dataGeneration: number;
  id: string;
  text: string;
  kind: string;
  codeLang: string | null;
  url: string | null;
  title: string | null;
  sourceApp: string | null;
  sourceBundle: string | null;
  /** 图片附件（组合卡在详情窗展示缩略条；点击 Quick Look）。 */
  images: string[];
  /** true = 打开即进入编辑态。 */
  edit: boolean;
};

/** 详情窗最近展示的卡 id（Space 开合判定用；窗口被 Esc/点 X 关掉也无碍——
 *  toggle 前会实测窗口可见性）。 */
let lastDetailId: string | null = null;
let deliverySequence = 0;
let deliveryPending = false;

function sameProfilePolicy(
  left: TargetProfileResolution,
  right: TargetProfileResolution
): boolean {
  return left.source === right.source &&
    left.promptGroup.id === right.promptGroup.id &&
    left.profile.id === right.profile.id &&
    left.profile.defaultFormat === right.profile.defaultFormat &&
    left.profile.enterPolicy === right.profile.enterPolicy &&
    left.profile.privacyPolicy === right.profile.privacyPolicy &&
    left.profile.keepPanel === right.profile.keepPanel;
}

function nextDeliveryId() {
  deliverySequence = (deliverySequence + 1) % Number.MAX_SAFE_INTEGER;
  return `delivery-${Date.now().toString(36)}-${deliverySequence.toString(36)}`;
}

async function restorePanelAfterDelivery(keepPanel: boolean) {
  useUIStore.getState().setOpen(true);
  if (!keepPanel) {
    try {
      await api.showPanel();
    } catch (error) {
      tip("warn", `发送已中止，但面板恢复失败：${error}`);
    }
  }
}

/** 所有笔记/任务/单条/批量/快捷发送共用的唯一前端投递入口。 */
async function deliver(
  text: string,
  imageFiles: string[],
  profileResolution: TargetProfileResolution
): Promise<SendDeliveryResult | null> {
  if (deliveryPending) {
    warnWithPanel("已有发送正在进行，请稍候", "delivery-pending");
    return null;
  }
  if (isDataOperationLocked()) {
    warnWithPanel("数据只读期间不能发送", "data-locked");
    return null;
  }
  if (useTargetStore.getState().profileOverrideNeedsConfirmation) {
    warnWithPanel("目标已变化，请在面板确认 Profile 后重试", "override-needs-confirmation");
    return null;
  }
  if (targetSendDisabled()) {
    warnWithPanel(currentTargetBlockMessage(), "target-not-ready");
    return null;
  }
  const visibleTarget = useTargetStore.getState().snapshot;
  const lease = beginDataGenerationLease();
  deliveryPending = true;
  const keepPanel =
    useUIStore.getState().pinned || profileResolution.profile.keepPanel;
  try {
    let pressEnter = false;
    if (profileResolution.profile.enterPolicy === "confirm") {
      const confirmed = await ask(
        "当前 Profile 要求发送前确认：粘贴后立即按回车吗？",
        { title: "确认自动回车", kind: "warning" }
      );
      if (!confirmed) {
        tip("info", "已取消发送，内容和选择保持不变");
        return null;
      }
      pressEnter = true;
    } else {
      pressEnter = profileResolution.profile.enterPolicy === "allow";
    }
    // UI ready 只允许进入准备阶段；发送紧前仍刷新 token，随后由 Native 在每个
    // paste/Enter gate 再验证。事件抢占本次刷新时 fail-closed，不借用新目标续发。
    const target = await refreshTarget();
    if (!target?.ready || targetSendDisabled()) {
      const message = target
        ? currentTargetBlockMessage()
        : useTargetStore.getState().status === "ready"
          ? "投递目标刚刚发生变化，请重试发送"
          : currentTargetBlockMessage();
      warnWithPanel(message, "target-refresh-blocked");
      return null;
    }
    if (!sameTargetIdentity(visibleTarget, target)) {
      warnWithPanel("投递目标已变化，请确认后重试发送", "target-identity-changed");
      return null;
    }
    // 确认框/刷新均会让出事件循环。期间即使 A→B→A 回到同一进程，临时
    // Profile 的确认闸仍必须保持；Settings 改过策略也不能沿用点击时的旧 Enter。
    if (useTargetStore.getState().profileOverrideNeedsConfirmation) {
      warnWithPanel("目标已变化，请在面板确认 Profile 后重试", "override-needs-confirmation");
      return null;
    }
    if (!sameProfilePolicy(profileResolution, currentTargetProfileResolution())) {
      warnWithPanel("Profile 设置已变化，请确认后重试发送", "profile-policy-changed");
      return null;
    }
    const deliveryId = nextDeliveryId();
    if (!keepPanel) useUIStore.getState().setOpen(false);
    const result = await api.sendDelivery({
      targetToken: target.token,
      text,
      imageFiles,
      pressEnter,
      keepPanel,
      deliveryId,
    });
    if (!isSendDeliveryResult(result) || result.deliveryId !== deliveryId) {
      throw new Error("原生发送回执无效");
    }
    if (
      result.status === "sent" &&
      profileResolution.source === "temporary" &&
      useTargetStore.getState().profileOverrideId === profileResolution.profile.id
    ) {
      clearTargetProfileOverride();
    }
    if (result.status !== "sent") await restorePanelAfterDelivery(keepPanel);
    return result;
  } catch (error) {
    await restorePanelAfterDelivery(keepPanel);
    tip("warn", `发送失败：${error}`);
    return null;
  } finally {
    deliveryPending = false;
    lease.release();
  }
}

/**
 * Space 快速查看语义（Quick Look 心智）：同一张卡已在详情窗展示中 →
 * 再按空格关闭；否则打开。仅 Space 入口用，Enter/明细按钮永远是打开。
 */
export async function toggleNoteDetail(id: string) {
  try {
    const win = await WebviewWindow.getByLabel("textpreview");
    if (win && lastDetailId === id && (await win.isVisible())) {
      void win.hide();
      return;
    }
  } catch {
    /* Tauri 环境外 */
  }
  openNoteDetail(id);
}

/**
 * 打开卡片明细：文字类（文本/代码/链接编辑）→ 桌面居中的文本详情窗
 * （窄面板放不下长文）；图片卡仍走面板内预览层（形变开合 + Quick Look）。
 */
export function openNoteDetail(id: string, edit = false) {
  const note = useNotesStore.getState().notes.find((n) => n.id === id);
  if (!note) return;
  if (note.kind === "image") {
    useUIStore.getState().openPreview(id, edit);
    return;
  }
  lastDetailId = note.id;
  void api.showTextPreview();
  const payload: NotePreviewPayload = {
    dataGeneration: currentDataGeneration(),
    id: note.id,
    text: note.text,
    kind: note.kind ?? "text",
    codeLang: note.codeLang ?? null,
    url: note.url ?? null,
    title: note.title ?? null,
    sourceApp: note.sourceApp ?? null,
    sourceBundle: note.sourceBundle ?? null,
    images: noteImages(note),
    edit,
  };
  void emitTo("textpreview", "toskr://note-preview", payload);
}

/** 链接卡片补抓网页标题/图标（幂等：已有标题跳过；离线/超时静默保持 URL 展示）。 */
export async function enrichLinkMeta(id: string) {
  const dataGeneration = currentDataGeneration();
  const note = useNotesStore.getState().notes.find((n) => n.id === id);
  if (!note || note.kind !== "link" || !note.url || note.linkTitle) return;
  try {
    const meta = await api.fetchLinkMeta(note.url);
    const cur = useNotesStore.getState().notes.find((n) => n.id === id);
    // 抓取期间卡片被删除或 URL 被改：丢弃过期结果
    if (!matchesDataGeneration(dataGeneration) || !cur || cur.url !== note.url) return;
    useNotesStore.getState().setLinkMeta(id, {
      title: meta.title ?? undefined,
      icon: meta.icon ?? undefined,
    });
  } catch {
    /* 静默：卡片保持 URL 展示 */
  }
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

/** 删除任务并给撤销机会。 */
export function deleteTasksWithUndo(ids: string[], label?: string) {
  if (!ids.length) return;
  const text = label ?? `已删除 ${ids.length} 个任务`;
  useNotesStore.getState().deleteTasks(ids, text);
  undoableTip(text);
}

/** 清理全部已完成任务（带撤销）。 */
export function clearDoneTasksWithUndo() {
  const n = useNotesStore.getState().clearDoneTasks();
  if (n > 0) undoableTip(`已清理 ${n} 个已完成任务`);
}

/** 笔记转任务（带撤销；图片/组合卡不可转）。 */
export function convertNoteToTaskWithUndo(noteId: string) {
  if (useNotesStore.getState().convertNoteToTask(noteId)) {
    undoableTip("已转为任务");
  } else {
    tip("warn", "图片卡片暂不支持转为任务");
  }
}

/**
 * 任务发送到对话：标题 + 备注 + 检查列表拼装成 Markdown 后粘贴给 AI。
 * 任务不因发送标完成（完成与否由用户在任务页管理）。
 */
export async function sendTaskToChat(taskId: string) {
  const task = useNotesStore.getState().tasks.find((t) => t.id === taskId);
  if (!task) return;
  const parts = [task.text];
  if (task.note) parts.push(`\n备注：${task.note}`);
  const list = task.checklist ?? [];
  if (list.length) {
    parts.push(
      "\n" + list.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n")
    );
  }
  const profile = currentTargetProfileResolution();
  const text = parts.join("\n");
  return deliver(
    profile.profile.defaultFormat === "code" ? wrapAsCodeBlock(text) : text,
    [],
    profile
  );
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
/** 复制单条笔记内容：图片卡复制图片本体（多图取第一张），其余复制文本。 */
export async function copyNoteContent(note: Note) {
  const images = noteImages(note);
  try {
    if (note.kind === "image" && images.length > 0) {
      await api.copyImage(images[0]);
      tip(
        "ok",
        images.length > 1 ? `已复制第 1 张图（共 ${images.length} 张）` : "已复制图片"
      );
    } else {
      await api.copyText(note.text);
      tip("ok", "已复制");
    }
  } catch (e) {
    tip("warn", `复制失败：${e}`);
  }
}

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
 * `prefix`：Prompt 模板（含 {内容}/{content} 占位符时内容注入占位处，
 * 否则拼在内容前，Prompt 组装台）。
 */
export async function sendNotesToChat(
  ids: string[],
  prefix?: string,
  opts?: { asCode?: boolean; format?: "plain" | "code" }
) {
  const notesState = useNotesStore.getState();
  const dataGeneration = currentDataGeneration();
  const picked = new Set(ids);
  const targets = notesState.notes.filter((n) => picked.has(n.id));
  if (!targets.length) return;

  // 图片卡片以真正的图片粘贴（写入剪贴板再 ⌘V），文本部分单独拼装，
  // 否则图片会退化成「图片 1867×391」这样的占位文字。图片卡的真实文字
  // 备注（详情窗里写的说明，占位符不算）也参与拼装——发送时文字跟着图走
  const textNotes = targets.filter(
    (n) => n.kind !== "image" || imageCaption(n).length > 0
  );
  const imageFiles = [...new Set(targets.flatMap(noteImages))];
  const profile = currentTargetProfileResolution();
  const format = opts?.format ?? (opts?.asCode ? "code" : profile.profile.defaultFormat);

  let body = textNotes.length ? buildSendText(textNotes.map((n) => n.text)) : "";
  if (body && format === "code") {
    // 代码块发送：单条用其检测到的语言，多条统一无语言标记
    body = wrapAsCodeBlock(
      body,
      textNotes.length === 1 ? textNotes[0].codeLang : undefined
    );
  }
  const text = prefix ? applyPromptTemplate(prefix, body) : body;
  const result = await deliver(text, imageFiles, profile);
  if (result?.status !== "sent") return result;
  if (!matchesDataGeneration(dataGeneration)) return result;

  // 「常用」卡与「发送后保留」分组内的卡不标完成（长期复用内容）
  const doneIds = doneIdsAfterSend(
    useNotesStore.getState(),
    targets.map((n) => n.id)
  );
  if (doneIds.length) useNotesStore.getState().setDone(doneIds, true);
  useNotesStore.getState().clearChecked();
  useNotesStore.getState().markOnboarding({ sent: true });
  return result;
}

/** 发送全部勾选项（可带 Prompt 前缀模板）。 */
export function sendCheckedToChat(
  prefix?: string,
  opts?: { asCode?: boolean; format?: "plain" | "code" }
) {
  const state = useNotesStore.getState();
  return sendNotesToChat(
    orderedCheckedNotes(state).map((n) => n.id),
    prefix,
    opts
  );
}
