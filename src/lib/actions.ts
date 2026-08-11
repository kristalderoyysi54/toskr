import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import {
  formatAsNumberedList,
  imageCaption,
} from "@/lib/format";
import {
  beginDataGenerationLease,
  currentDataGeneration,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import { api } from "@/lib/tauri";
import { setPendingUndo, tip } from "@/lib/tip";
import { currentTargetProfileResolution } from "@/lib/currentTargetProfile";
import {
  buildDeliveryDraft,
  buildNoteSourceContent,
} from "@/lib/delivery/buildDraft";
import {
  deliveryDraftPreparationPending,
  dispatchDeliveryDraft,
} from "@/lib/delivery/preflight";
import {
  deliveryDraftPending,
  nextDeliveryDraftRevision,
  warnWithPanel,
} from "@/lib/delivery/executeDraft";
import type { DeliveryDraftInput } from "@/lib/delivery/types";
import {
  EDITOR_INSERT_OPERATION_TTL_MS,
  EDITOR_INSERT_REQUEST_TTL_MS,
  NOTE_EDITOR_INSERT_EVENT,
  NOTE_EDITOR_INSERT_RESULT_EVENT,
  type NoteEditorInsertPayload,
  type NoteEditorInsertResultPayload,
} from "@/lib/previewPayload";
import {
  releaseEditorOperationMedia,
  releaseEditorSessionMedia,
  retainEditorOperationMedia,
} from "@/lib/editorSessionMedia";
import {
  CLIPBOARD_ID,
  noteImages,
  orderedCheckedNotes,
  useNotesStore,
  type Note,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import { useDeliveryStore } from "@/store/deliveryStore";
import { useTargetStore } from "@/store/targetStore";
import {
  isSafeRehearsalText,
  secureRehearsalDraft,
} from "@/lib/onboarding";

export { warnWithPanel } from "@/lib/delivery/executeDraft";

/** 可撤销的操作确认（HUD 气泡悬停出「撤销」；撤销 = 弹出栈顶快照恢复）。 */
export function undoableTip(message: string) {
  setPendingUndo(() => {
    const label = useNotesStore.getState().undo();
    tip("undone", label ? "已撤销" : "没有可撤销的操作");
  });
  tip("ok", message, true);
}

/** 文本详情窗的内容载荷（主面板 → textpreview 窗口）。 */
export type NotePreviewPayload = {
  dataGeneration: number;
  sessionId: string;
  id: string;
  text: string;
  kind: string;
  codeLang: string | null;
  url: string | null;
  title: string | null;
  sourceApp: string | null;
  sourceBundle: string | null;
  /** 非卡片预览可覆盖标题下的来源说明。 */
  subtitle?: string | null;
  /** 图片附件（组合卡在详情窗展示缩略条；点击 Quick Look）。 */
  images: string[];
  /** true = 打开即进入编辑态。 */
  edit: boolean;
  /** 合并发送来源等临时视图不可编辑、移除附件或再次发送。 */
  readOnly?: boolean;
};

/** 详情窗最近展示的卡 id（Space 开合判定用；窗口被 Esc/点 X 关掉也无碍——
 *  toggle 前会实测窗口可见性）。 */
let lastDetailId: string | null = null;
let lastDetailSessionId: string | null = null;
let deliverySequence = 0;
let editorInsertPending = false;
let editorInsertRetry:
  | {
      fingerprint: string;
      operationKey: string;
      retryExpiresAt: number;
    }
  | null = null;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function emitEditorInsert(
  createPayload: () => NoteEditorInsertPayload
): Promise<{
  payload: NoteEditorInsertPayload;
  result: NoteEditorInsertResultPayload;
}> {
  let stop: (() => void) | undefined;
  let payload: NoteEditorInsertPayload | null = null;
  let resolveAck!: (result: NoteEditorInsertResultPayload) => void;
  const ack = new Promise<NoteEditorInsertResultPayload>((resolve) => {
    resolveAck = resolve;
  });
  const registration = listen<NoteEditorInsertResultPayload>(
    NOTE_EDITOR_INSERT_RESULT_EVENT,
    (event) => {
      if (payload && event.payload.requestId === payload.requestId) {
        resolveAck(event.payload);
      }
    }
  );
  try {
    stop = await withTimeout(
      registration,
      1500,
      "卡片编辑器回执监听未就绪"
    );
    // listener 就绪后无 await：重读来源、组装 payload、dispatch 连成同一同步段。
    payload = createPayload();
    const dispatchFailure = emitTo(
      "textpreview",
      NOTE_EDITOR_INSERT_EVENT,
      payload
    ).then(
      () => new Promise<never>(() => {}),
      (error) => Promise.reject(error)
    );
    const result = await withTimeout(
      Promise.race([ack, dispatchFailure]),
      1500,
      "卡片编辑器未确认接收"
    );
    return { payload, result };
  } finally {
    if (stop) stop();
    else void registration.then((lateStop) => lateStop()).catch(() => {});
  }
}

function nextDeliveryId() {
  deliverySequence = (deliverySequence + 1) % Number.MAX_SAFE_INTEGER;
  return `delivery-${Date.now().toString(36)}-${deliverySequence.toString(36)}`;
}

type NoteDeliveryOptions = {
  asCode?: boolean;
  format?: "plain" | "code";
  promptSnippetId?: string;
  forcePreflight?: boolean;
  /** 仅内部上手演练使用；不能由普通发送菜单构造。 */
  safeRehearsal?: boolean;
};

function preflightBlocksNewIntent(): boolean {
  const preflight = useDeliveryStore.getState();
  if (!preflight.open) return false;
  warnWithPanel(
    preflight.busy ? "已有发送正在进行，请稍候" : "请先完成或关闭当前发送预检",
    preflight.busy ? "delivery-pending" : "preflight-open"
  );
  return true;
}

function draftInput(
  sourceItemIds: string[],
  sourceKind: DeliveryDraftInput["sourceKind"],
  prefix?: string,
  opts?: NoteDeliveryOptions
): DeliveryDraftInput {
  return {
    id: nextDeliveryId(),
    revision: nextDeliveryDraftRevision(),
    createdAtMs: Date.now(),
    sourceKind,
    sourceItemIds,
    format: opts?.format ?? (opts?.asCode ? "code" : undefined),
    promptSnippetId: opts?.promptSnippetId ?? null,
    promptTemplate: prefix,
  };
}

function currentDraftState(dataGeneration: number) {
  const state = useNotesStore.getState();
  return {
    notes: state.notes,
    tasks: state.tasks,
    promptSnippets: state.settings.promptSnippets,
    checkedItemIds: state.checkedIds,
    targetSnapshot: useTargetStore.getState().snapshot,
    profileResolution: currentTargetProfileResolution(),
    panelPinned: useUIStore.getState().pinned,
    dataGeneration,
    firewallEnabled: state.settings.firewallEnabled,
    firewallDisabledWarnCategories:
      state.settings.firewallDisabledWarnCategories,
  };
}

function buildNoteDraft(
  ids: string[],
  dataGeneration: number,
  prefix?: string,
  opts?: NoteDeliveryOptions
) {
  const draft = buildDeliveryDraft(
    draftInput(ids, ids.length === 1 ? "note" : "note-batch", prefix, opts),
    currentDraftState(dataGeneration)
  );
  return opts?.safeRehearsal ? secureRehearsalDraft(draft) : draft;
}

function editorInsertFingerprint(
  targetId: string,
  targetSessionId: string,
  dataGeneration: number,
  sourceIds: string[],
  text: string,
  images: string[]
) {
  const input = JSON.stringify({
    targetId,
    targetSessionId,
    dataGeneration,
    sourceIds,
    text,
    images,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function editorInsertOperation(fingerprint: string) {
  const now = Date.now();
  if (
    editorInsertRetry?.fingerprint === fingerprint &&
    editorInsertRetry.retryExpiresAt > now
  ) {
    return editorInsertRetry;
  }
  editorInsertRetry = {
    fingerprint,
    operationKey: `editor-insert-${crypto.randomUUID()}`,
    retryExpiresAt: now + EDITOR_INSERT_OPERATION_TTL_MS,
  };
  return editorInsertRetry;
}

/**
 * Space 快速查看语义（Quick Look 心智）：同一张卡已在详情窗展示中 →
 * 再按空格关闭；否则打开。仅 Space 入口用，Enter/明细按钮永远是打开。
 */
export async function toggleNoteDetail(id: string) {
  try {
    const win = await WebviewWindow.getByLabel("textpreview");
    if (win && lastDetailId === id && (await win.isVisible())) {
      if (lastDetailSessionId) {
        releaseEditorSessionMedia(lastDetailSessionId);
      }
      void win.hide();
      return;
    }
  } catch {
    /* Tauri 环境外 */
  }
  openNoteDetail(id);
}

/**
 * 打开卡片明细：文字类（文本/代码/链接编辑）→ 桌面居中的文本详情窗；
 * 图片编辑直接进入原尺寸预览窗的备注编辑态。
 */
export function openNoteDetail(id: string, edit = false) {
  const note = useNotesStore.getState().notes.find((n) => n.id === id);
  if (!note) return;
  if (note.kind === "image") {
    if (edit && note.imageFile) {
      void api.quickLook(noteImages(note), 0, {
        id: note.id,
        text: imageCaption(note),
        dataGeneration: currentDataGeneration(),
        edit: true,
      });
      return;
    }
    useUIStore.getState().openPreview(id, edit);
    return;
  }
  openTextPreview({
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
  });
}

function openTextPreview(payload: Omit<NotePreviewPayload, "sessionId">) {
  if (lastDetailSessionId) releaseEditorSessionMedia(lastDetailSessionId);
  lastDetailId = payload.id;
  const sessionId = crypto.randomUUID();
  lastDetailSessionId = sessionId;
  void api.showTextPreview();
  void emitTo("textpreview", "toskr://note-preview", {
    ...payload,
    sessionId,
  } satisfies NotePreviewPayload);
}

/**
 * 最近发送不持久化正文；合并记录按当前仍存在的来源卡片重建只读预览。
 * 单卡继续走原详情逻辑，避免改变既有查看/编辑习惯。
 */
export function openNoteBatchDetail(
  ids: readonly string[],
  expectedSourceCount = ids.length
): boolean {
  const notesById = new Map(
    useNotesStore.getState().notes.map((note) => [note.id, note])
  );
  const notes = ids.flatMap((id) => {
    const note = notesById.get(id);
    return note ? [note] : [];
  });
  if (!notes.length) return false;
  if (notes.length === 1 && expectedSourceCount <= 1) {
    openNoteDetail(notes[0].id);
    return true;
  }

  const content = buildNoteSourceContent(notes);
  const expected = Math.max(notes.length, expectedSourceCount);
  const sourceCount = notes.length === expected
    ? `${notes.length} 张当前来源卡片`
    : `${notes.length}/${expected} 张当前可用来源卡片`;
  openTextPreview({
    dataGeneration: currentDataGeneration(),
    id: `delivery-source-${crypto.randomUUID()}`,
    text: content.rawText,
    kind: content.rawText ? "text" : "image",
    codeLang: content.singleCodeLanguage ?? null,
    url: null,
    title: "合并发送内容",
    subtitle: `${sourceCount} · 发送记录不保存正文`,
    sourceApp: null,
    sourceBundle: null,
    images: content.imageFiles,
    edit: false,
    readOnly: true,
  });
  return true;
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
export async function sendTaskToChat(
  taskId: string,
  opts?: { forcePreflight?: boolean }
) {
  const task = useNotesStore.getState().tasks.find((t) => t.id === taskId);
  if (!task) return;
  if (
    preflightBlocksNewIntent() ||
    deliveryDraftPending() ||
    deliveryDraftPreparationPending() ||
    editorInsertPending
  ) {
    if (useDeliveryStore.getState().open) return null;
    warnWithPanel("已有发送正在进行，请稍候", "delivery-pending");
    return null;
  }
  const draft = buildDeliveryDraft(
    draftInput([taskId], "task"),
    currentDraftState(currentDataGeneration())
  );
  return dispatchDeliveryDraft(draft, { force: opts?.forcePreflight });
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

/**
 * 剪贴板卡发送时，若 Toskr 自己的文本详情窗正可见，则把内容追加到该编辑器。
 * 一旦确认存在内部目标，失败也不回退到外部发送，避免内容误发。
 */
async function insertClipboardNotesIntoOpenEditor(
  targets: Note[],
  dataGeneration: number,
  prefix?: string,
  opts?: { asCode?: boolean; format?: "plain" | "code" }
): Promise<"not-target" | "handled"> {
  if (
    !lastDetailId ||
    !lastDetailSessionId ||
    targets.some((note) => note.sectionId !== CLIPBOARD_ID)
  ) {
    return "not-target";
  }

  let win: Awaited<ReturnType<typeof WebviewWindow.getByLabel>>;
  try {
    win = await withTimeout(
      WebviewWindow.getByLabel("textpreview"),
      1500,
      "卡片编辑器窗口探测超时"
    );
  } catch (error) {
    warnWithPanel(
      `无法确认卡片编辑器状态：${error}`,
      "note-editor-visibility-unknown"
    );
    return "handled";
  }
  if (!win) return "not-target";
  try {
    if (
      !(await withTimeout(
        win.isVisible(),
        1500,
        "卡片编辑器可见性探测超时"
      ))
    ) {
      return "not-target";
    }
  } catch (error) {
    warnWithPanel(
      `无法确认卡片编辑器状态：${error}`,
      "note-editor-visibility-unknown"
    );
    return "handled";
  }

  const targetId = lastDetailId;
  const targetSessionId = lastDetailSessionId;
  const destinationExists = useNotesStore
    .getState()
    .notes.some((note) => note.id === targetId);
  if (!destinationExists) {
    tip("warn", "卡片编辑器内容已失效，请重新打开目标卡片");
    return "handled";
  }
  if (isDataOperationLocked()) {
    warnWithPanel("数据只读期间不能修改卡片", "note-editor-insert-locked");
    return "handled";
  }

  if (preflightBlocksNewIntent()) return "handled";
  if (
    deliveryDraftPending() ||
    deliveryDraftPreparationPending() ||
    editorInsertPending
  ) {
    warnWithPanel("已有发送正在进行，请稍候", "delivery-pending");
    return "handled";
  }
  editorInsertPending = true;

  try {
    const sourceIds = new Set(
      targets.filter((note) => note.id !== targetId).map((note) => note.id)
    );
    if (!sourceIds.size) {
      tip("warn", "不能把卡片内容添加到自身");
      return "handled";
    }
    const format = opts?.format ?? (opts?.asCode ? "code" : "plain");
    const { payload, result } = await emitEditorInsert(() => {
      if (
        lastDetailId !== targetId ||
        lastDetailSessionId !== targetSessionId ||
        !matchesDataGeneration(dataGeneration)
      ) {
        throw new Error("卡片编辑目标或数据上下文已变化");
      }
      const currentNotes = useNotesStore.getState().notes;
      const sources = currentNotes.filter((note) => sourceIds.has(note.id));
      if (
        sources.length !== sourceIds.size ||
        sources.some((note) => note.sectionId !== CLIPBOARD_ID) ||
        !currentNotes.some((note) => note.id === targetId)
      ) {
        throw new Error("卡片内容已变化，请重新选择后再添加");
      }
      const draft = buildNoteDraft(
        sources.map((note) => note.id),
        dataGeneration,
        prefix,
        { ...opts, format }
      );
      const fingerprint = editorInsertFingerprint(
        targetId,
        targetSessionId,
        dataGeneration,
        sources.map((note) => note.id),
        draft.finalText,
        draft.imageFiles
      );
      const operation = editorInsertOperation(fingerprint);
      retainEditorOperationMedia(
        targetSessionId,
        operation.operationKey,
        dataGeneration,
        draft.imageFiles
      );
      return {
        requestId: crypto.randomUUID(),
        operationKey: operation.operationKey,
        expiresAt: Date.now() + EDITOR_INSERT_REQUEST_TTL_MS,
        targetId,
        targetSessionId,
        text: draft.finalText,
        images: draft.imageFiles,
        dataGeneration,
      };
    });
    if (
      result.status !== "applied" ||
      result.targetId !== targetId ||
      result.targetSessionId !== targetSessionId ||
      result.dataGeneration !== dataGeneration
    ) {
      if (result.status === "rejected") {
        releaseEditorOperationMedia(targetSessionId, payload.operationKey);
      }
      throw new Error(result.reason ?? "卡片编辑器拒绝了内容");
    }
    if (
      lastDetailId !== targetId ||
      lastDetailSessionId !== targetSessionId ||
      !matchesDataGeneration(dataGeneration) ||
      !useNotesStore.getState().notes.some((note) => note.id === targetId) ||
      !(await withTimeout(
        win.isVisible(),
        1500,
        "卡片编辑器可见性复核超时"
      ))
    ) {
      tip("warn", "卡片编辑目标已变化，内容未确认添加");
      return "handled";
    }
    if (editorInsertRetry?.operationKey === payload.operationKey) {
      editorInsertRetry = null;
    }
    useNotesStore.getState().clearChecked();
    try {
      await withTimeout(
        api.showTextPreview(),
        1500,
        "卡片编辑窗口唤起超时"
      );
    } catch {
      tip("warn", "内容已添加，但卡片编辑窗口唤起失败");
      return "handled";
    }
    tip("ok", "已添加到卡片编辑器");
  } catch (error) {
    warnWithPanel(`添加到卡片编辑器失败：${error}`, "note-editor-insert-failed");
  } finally {
    editorInsertPending = false;
  }
  return "handled";
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
  opts?: NoteDeliveryOptions
) {
  const picked = new Set(ids);
  let targets = useNotesStore
    .getState()
    .notes.filter((note) => picked.has(note.id));
  if (!targets.length) return;
  if (
    preflightBlocksNewIntent() ||
    deliveryDraftPending() ||
    deliveryDraftPreparationPending() ||
    editorInsertPending
  ) {
    if (useDeliveryStore.getState().open) return null;
    warnWithPanel("已有发送正在进行，请稍候", "delivery-pending");
    return null;
  }
  if (isDataOperationLocked()) {
    warnWithPanel("数据只读期间不能发送", "data-locked");
    return null;
  }
  const lease = beginDataGenerationLease();
  const dataGeneration = lease.generation;
  try {
    const requiresPreflight =
      opts?.forcePreflight ||
      opts?.safeRehearsal ||
      useDeliveryStore.getState().preflightMode === "always";
    if (
      !requiresPreflight &&
      (await insertClipboardNotesIntoOpenEditor(
        targets,
        dataGeneration,
        prefix,
        opts
      )) === "handled"
    ) {
      return null;
    }
    if (
      preflightBlocksNewIntent() ||
      deliveryDraftPending() ||
      deliveryDraftPreparationPending() ||
      editorInsertPending
    ) {
      if (useDeliveryStore.getState().open) return null;
      warnWithPanel("已有发送正在进行，请稍候", "delivery-pending");
      return null;
    }
    if (
      !matchesDataGeneration(dataGeneration) ||
      isDataOperationLocked()
    ) {
      warnWithPanel(
        "发送已取消：数据上下文已变化，请重新选择内容",
        "send-generation-changed"
      );
      return null;
    }
    const latestTargets = useNotesStore
      .getState()
      .notes.filter((note) => picked.has(note.id));
    if (latestTargets.length !== targets.length) {
      warnWithPanel("发送已取消：所选卡片已变化", "send-notes-changed");
      return null;
    }
    targets = latestTargets;

    const draft = buildNoteDraft(
      targets.map((note) => note.id),
      dataGeneration,
      prefix,
      opts
    );
    return dispatchDeliveryDraft(draft, {
      force: opts?.forcePreflight || opts?.safeRehearsal,
    });
  } finally {
    lease.release();
  }
}

/** 受控上手演练唯一入口：真实 Firewall/Preflight/Native 链路，强制不回车。 */
export async function openSafeRehearsalPreflight(noteId: string) {
  const state = useNotesStore.getState();
  const onboarding = state.settings.onboarding;
  const note = state.notes.find((item) => item.id === noteId);
  if (
    !onboarding.rehearsalActive ||
    onboarding.rehearsalNoteId !== noteId ||
    !["firewall", "delivery"].includes(onboarding.rehearsalStep) ||
    !note ||
    !isSafeRehearsalText(note.text)
  ) {
    warnWithPanel("演练示例已变化，请从捕获步骤重新开始", "rehearsal-source-stale");
    return null;
  }
  if (useTargetStore.getState().status !== "ready") {
    warnWithPanel("请先重新识别并确认安全目标", "rehearsal-target-not-ready");
    return null;
  }
  const result = await sendNotesToChat([noteId], undefined, {
    forcePreflight: true,
    safeRehearsal: true,
  });
  const delivery = useDeliveryStore.getState();
  if (
    delivery.open &&
    delivery.draft?.safeRehearsal &&
    delivery.draft.sourceItemIds.length === 1 &&
    delivery.draft.sourceItemIds[0] === noteId
  ) {
    useNotesStore.getState().transitionOnboarding({ type: "preflightOpened" });
  }
  return result;
}

/** 发送全部勾选项（可带 Prompt 前缀模板）。 */
export function sendCheckedToChat(
  prefix?: string,
  opts?: NoteDeliveryOptions
) {
  const state = useNotesStore.getState();
  return sendNotesToChat(
    orderedCheckedNotes(state).map((n) => n.id),
    prefix,
    opts
  );
}
