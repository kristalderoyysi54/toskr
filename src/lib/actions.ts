import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import {
  formatAsNumberedList,
  imageCaption,
} from "@/lib/format";
import { mapNoteTextBlocks } from "@/lib/noteContentBlocks";
import { buildNotesExportPlan, notesExportFilename } from "@/lib/noteExport";
import { restoreAliases } from "@/lib/delivery/aliasEntities";
import {
  beginDataGenerationLease,
  currentDataGeneration,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import { api } from "@/lib/tauri";
import {
  detailWindowKnown,
  pickDetailWindowLabel,
  queueDetailPayload,
} from "@/lib/detailWindows";
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
  clampDetailFontSize,
  CLIPBOARD_ID,
  DETAIL_FONT_SIZE_DEFAULT,
  noteContentBlocks,
  noteImages,
  orderedCheckedNotes,
  useNotesStore,
  type Note,
  type NoteContentBlock,
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
  /** 主面板按卡片通栏同款规则决议的标题栏定色（分组色优先/着色关闭时中性灰）；
   *  null/缺省 = 详情窗用应用主色兜底（与卡片 sectionColor ?? icon.color 一致）。 */
  headerColor?: string | null;
  /** 图片附件（组合卡在详情窗展示缩略条；点击 Quick Look）。 */
  images: string[];
  /** 有序富内容；缺省表示普通/旧式扁平卡。 */
  contentBlocks?: NoteContentBlock[] | null;
  /** 标签（详情窗只读展示；编辑走主窗口卡片右键）。 */
  tags?: string[];
  /** 创建/最后修改时间（详情窗头部只读展示；批量聚合视图缺省不带）。 */
  createdAt?: number;
  updatedAt?: number;
  /** 详情窗正文字号（px；缺省用默认字阶）。openTextPreview 统一注入。 */
  fontSize?: number;
  /** true = 打开即进入编辑态。 */
  edit: boolean;
  /** 打开即整选正文（新建笔记占位文案「落指即替换」）。 */
  selectAll?: boolean;
  /** 合并发送来源等临时视图不可编辑、移除附件或再次发送。 */
  readOnly?: boolean;
};

/**
 * 独立详情窗的无歧义写回协议。flat 允许旧编辑器改正文/尾部附件；blocks
 * 只接受权威有序块，主窗口据此选择对应 Store 原语，禁止富卡被误压平。
 */
export type NoteEditPayload = {
  id: string;
  sessionId?: string;
  dataGeneration: number;
  /** 需要主窗口明确确认已处理时携带；普通自动保存可省略。 */
  syncId?: string;
  /** true = 编辑中的静默自动保存：只持久化，不释放会话、不提示、不抓链接。 */
  autosave?: boolean;
  /** 会话收尾保存随带：本次编辑开始前的内容，主面板用它装配 HUD「撤销」。 */
  origin?: NoteEditOrigin;
} & (
  | {
      format: "flat";
      text: string;
      images?: string[];
      discardedImages?: string[];
    }
  | {
      format: "blocks";
      contentBlocks: NoteContentBlock[];
    }
);

export const NOTE_EDIT_SYNC_RESULT_EVENT = "toskr://note-edit-sync-result";
export type NoteEditSyncResultPayload = {
  syncId: string;
  ok: boolean;
};

/** 详情窗 → 主面板：触发当前待撤销动作（等价点击 HUD 气泡的「撤销」）。 */
export const RUN_PENDING_UNDO_EVENT = "toskr://run-pending-undo";

/** 详情窗 → 主面板：整卡标签写回（主面板是唯一持久化写入方）。 */
export const NOTE_TAGS_EVENT = "toskr://note-tags";
export type NoteTagsPayload = {
  id: string;
  tags: string[];
  dataGeneration: number;
};

export type NoteEditOrigin =
  | { text: string; images?: string[] }
  | { contentBlocks: NoteContentBlock[] };

/** 编辑态每隔这么久把草稿静默写回 store（崩溃/关窗最多丢这窗口内的输入）。 */
export const NOTE_EDIT_AUTOSAVE_INTERVAL_MS = 2000;

/**
 * 编辑会话收尾的可撤销「已保存」：撤销 = 把该卡还原到本次编辑开始前的内容。
 * 不走 undoStack 快照——会话可能跨越数分钟，栈顶早被别的操作压过，
 * 精确还原单卡字段才不会误伤无关改动。
 */
export function armNoteEditUndo(id: string, origin: NoteEditOrigin) {
  setPendingUndo(() => {
    if ("contentBlocks" in origin) {
      useNotesStore.getState().updateNoteContent(id, origin.contentBlocks);
    } else {
      useNotesStore.getState().updateNoteText(id, origin.text, origin.images);
    }
    tip("undone", "已撤销");
  });
  tip("ok", "已保存", true);
}

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
  /** 片段发送：以该文本取代来源笔记正文（详情窗「发送选中」）；仅单卡有效。 */
  overrideText?: string;
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
    sourceTextOverride:
      sourceItemIds.length === 1 ? opts?.overrideText : undefined,
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
    aliasEntitiesEnabled: state.settings.aliasEntitiesEnabled,
    aliasEntities: state.settings.aliasEntities,
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
      useUIStore.getState().setDetailEditorNoteId(null);
      void win.hide();
      return;
    }
  } catch {
    /* Tauri 环境外 */
  }
  openNoteDetail(id);
}

/**
 * 详情窗会话释放回执：仅当释放的是当前会话才判定编辑器已关闭。切卡时旧
 * 会话的释放事件晚于新会话建立到达，一概清空会把刚打开的编辑器标成关闭。
 */
export function noteEditorSessionReleased(sessionId: string) {
  if (sessionId === lastDetailSessionId) {
    useUIStore.getState().setDetailEditorNoteId(null);
  }
}

/**
 * 撤销后详情窗内容可能已回退：窗口仍可见时按最近展示的卡重推 payload。
 * 不可见/卡已不存在则什么都不做（绝不因撤销把窗口弹出来）。
 */
export async function refreshOpenNoteDetail() {
  if (!lastDetailId) return;
  try {
    const win = await WebviewWindow.getByLabel("textpreview");
    if (!win || !(await win.isVisible())) return;
  } catch {
    return; /* Tauri 环境外 */
  }
  const note = useNotesStore.getState().notes.find((n) => n.id === lastDetailId);
  if (note) openNoteDetail(note.id);
}

/**
 * 打开卡片明细：文字类（文本/代码/链接编辑）→ 桌面居中的文本详情窗；
 * 图片卡编辑优先进入文字备注，低频的图片打码由预览窗独立按钮触发。
 */
export function openNoteDetail(id: string, edit = false, selectAll = false) {
  const { notes, sections, settings } = useNotesStore.getState();
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  // 秘文卡绝不进详情窗：通用文本编辑器一旦保存会以明文改写 text，直接损毁密文信封
  // （GCM 认证从此失败、永久不可解）。解密只走秘文页卡片自身的按需揭示。
  if (note.kind === "secret") {
    tip("info", "秘文请在秘文页点击查看，不支持详情窗");
    return;
  }
  // 与卡片通栏同款取色：分组色优先（剪贴卡恒不取）；着色关闭时定死中性灰，
  // 避免详情窗再用应用主色兜底出现两边颜色不一致
  const sectionColor =
    note.sectionId === CLIPBOARD_ID
      ? undefined
      : sections.find((sec) => sec.id === note.sectionId)?.color;
  const headerColor = settings.cardTint ? sectionColor ?? null : "#7c8494";
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
    headerColor,
    images: noteImages(note),
    contentBlocks: note.contentBlocks ? noteContentBlocks(note) : null,
    tags: note.tags,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    edit,
    selectAll,
  });
}

function openTextPreview(payload: Omit<NotePreviewPayload, "sessionId">) {
  if (lastDetailSessionId) releaseEditorSessionMedia(lastDetailSessionId);
  lastDetailId = payload.id;
  const sessionId = crypto.randomUUID();
  lastDetailSessionId = sessionId;
  // 只读会话（合并来源预览等）不是可添加目标，不亮「添加到卡片」
  useUIStore
    .getState()
    .setDetailEditorNoteId(payload.readOnly ? null : payload.id);
  // 多详情窗：📌 固定的窗不被顶掉——同卡复用 > 未固定窗 > 动态新窗
  const label = pickDetailWindowLabel(payload.id);
  const isNewWindow = label !== "textpreview" && !detailWindowKnown(label);
  void api.showTextPreview(label);
  const previewPayload = {
    fontSize: clampDetailFontSize(
      useNotesStore.getState().settings.detailFontSize ??
        DETAIL_FONT_SIZE_DEFAULT
    ),
    ...payload,
    sessionId,
  } satisfies NotePreviewPayload;
  if (isNewWindow) {
    // 新窗 webview 未挂载就 emit 会丢：入队，等窗口自报就绪冲洗
    queueDetailPayload(label, "toskr://note-preview", previewPayload);
  } else {
    void emitTo(label, "toskr://note-preview", previewPayload);
  }
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
    contentBlocks: null,
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

/** 清理全部已完成卡片（带撤销）；0 条时给反馈（快捷键 ⇧⌘⌫ 无按钮可看）。 */
export function clearDoneWithUndo() {
  const n = useNotesStore.getState().clearDone();
  if (n > 0) undoableTip(`已清理 ${n} 条已完成`);
  else tip("info", "没有已完成的卡片");
}

/** 删除任务并给撤销机会。 */
export function deleteTasksWithUndo(ids: string[], label?: string) {
  if (!ids.length) return;
  const text = label ?? `已删除 ${ids.length} 个任务`;
  useNotesStore.getState().deleteTasks(ids, text);
  undoableTip(text);
}

/** 清理全部已完成任务（带撤销）；0 个时给反馈（快捷键 ⇧⌘⌫ 无按钮可看）。 */
export function clearDoneTasksWithUndo() {
  const n = useNotesStore.getState().clearDoneTasks();
  if (n > 0) undoableTip(`已清理 ${n} 个已完成任务`);
  else tip("info", "没有已完成的任务");
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

/** 剪贴历史与笔记队列合并事务不同（组合新卡 vs 就地消费），混选拒绝。 */
function mergeDomainsMixed(notes: readonly Note[]): boolean {
  const clips = notes.filter((n) => n.sectionId === CLIPBOARD_ID).length;
  return clips > 0 && clips < notes.length;
}

/** 合并勾选（带撤销）。 */
export function mergeCheckedWithUndo() {
  const picked = orderedCheckedNotes(useNotesStore.getState());
  if (picked.length < 2) return;
  if (mergeDomainsMixed(picked)) {
    tip("warn", "剪贴卡与笔记不能混合合并");
    return;
  }
  useNotesStore.getState().mergeNotes(picked.map((n) => n.id));
  undoableTip(`已合并 ${picked.length} 条`);
}

/** 把指定卡片与勾选项合并为一张卡（右键菜单入口；顺序按队列排列）。 */
export function mergeNoteWithChecked(noteId: string) {
  const state = useNotesStore.getState();
  const pick = new Set([...state.checkedIds, noteId]);
  const valid = state.notes.filter((n) => pick.has(n.id));
  if (valid.length < 2) return;
  if (mergeDomainsMixed(valid)) {
    tip("warn", "剪贴卡与笔记不能混合合并");
    return;
  }
  state.mergeNotes(valid.map((n) => n.id));
  undoableTip(`已合并 ${valid.length} 条`);
}

/**
 * 剪贴卡收编为正式笔记（移动语义，可撤销）：落收件箱并重置生命周期状态
 * ——done 清零（收编即待办），keep 不带（剪贴域「固定不清理」≠ 笔记域「常用」）。
 */
export function moveClipsToNotesWithUndo(ids: string[]) {
  const moved = useNotesStore.getState().moveClipsToNotes(ids);
  if (!moved) return;
  undoableTip(moved === 1 ? "已移入笔记" : `已移入笔记 ${moved} 条`);
}

/**
 * 恢复卡片正文中的本机化名（带撤销）。带图卡逐文字块处理——图片块与块序
 * 原样保留；纯文字卡维持旧扁平路径（保留 updateNoteText 的链接/代码再检测）。
 */
export function restoreNoteAliasesWithUndo(id: string) {
  const st = useNotesStore.getState();
  const note = st.notes.find((n) => n.id === id);
  if (!note) return;
  const dictionary = st.settings.aliasEntities;
  const blocks = noteContentBlocks(note);
  if (blocks.some((block) => block.type === "image")) {
    let restoredCount = 0;
    const next = mapNoteTextBlocks(blocks, (text) => {
      const restored = restoreAliases(text, dictionary);
      restoredCount += restored.restoredCount;
      return restored.text;
    });
    if (restoredCount === 0) return;
    st.snapshot("恢复化名");
    st.updateNoteContent(id, next);
    undoableTip(`已恢复 ${restoredCount} 处化名`);
    return;
  }
  const restored = restoreAliases(note.text, dictionary);
  if (restored.text === note.text) return;
  st.snapshot("恢复化名");
  st.updateNoteText(id, restored.text);
  undoableTip(`已恢复 ${restored.restoredCount} 处化名`);
}

/** 复制单条笔记内容：有序图文写 plain+HTML；单图仍写原生 PNG。 */
export async function copyNoteContent(note: Note) {
  const images = noteImages(note);
  const blocks = noteContentBlocks(note);
  try {
    if (blocks.some((block) => block.type === "image") && blocks.length > 1) {
      await api.copyRichClipboard(
        blocks.map((block) =>
          block.type === "text"
            ? { kind: "text" as const, text: block.text }
            : {
                kind: "image" as const,
                file: block.file,
                ...(block.alt ? { alt: block.alt } : {}),
              }
        )
      );
      tip("ok", `已复制图文（${images.length} 张图）`);
    } else if (note.kind === "image" && images.length > 0) {
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

/**
 * 复制勾选文本：单条原样、多条转编号列表——与发送路径（buildSendText）
 * 同规则。规则在此内联而非调用：delivery-routing 守卫测试禁止 actions
 * 出现 buildSendText 调用（发送正文装配必须收敛在 builder 层）。
 */
export async function copyNotesAsList(ids: string[]) {
  const { notes } = useNotesStore.getState();
  const picked = new Set(ids);
  const texts = notes.filter((n) => picked.has(n.id)).map((n) => n.text);
  if (!texts.length) return;
  try {
    await api.copyText(
      texts.length === 1 ? texts[0] : formatAsNumberedList(texts)
    );
    tip("ok", texts.length === 1 ? "已复制" : `已复制 ${texts.length} 条为列表`);
  } catch (e) {
    tip("warn", `复制失败：${e}`);
  }
}

function exportErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return "未知错误";
}

/** 导出普通笔记为单文件 Markdown 媒体包；取消静默，且不改变当前选择。 */
export async function exportNotesBundle(ids: string[]) {
  if (isDataOperationLocked()) {
    tip("warn", "数据操作进行中，请稍后再导出");
    return;
  }
  const state = useNotesStore.getState();
  const picked = new Set(ids);
  const openEditorId = useUIStore.getState().detailEditorNoteId;
  if (openEditorId && picked.has(openEditorId)) {
    tip("warn", "请先关闭已打开的笔记详情，确认最新编辑已同步后再导出");
    return;
  }
  const notes = state.notes.filter((note) => picked.has(note.id));
  try {
    const plan = buildNotesExportPlan({ notes, sections: state.sections });
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: notesExportFilename(plan.noteCount),
      filters: [{ name: "Toskr Markdown 笔记包", extensions: ["zip"] }],
    });
    if (!path) return;
    tip("info", "正在导出笔记包…");
    await api.exportNotesBundle(path, plan.markdown, plan.mediaFiles);
    const mediaCount = plan.mediaFiles.length;
    tip(
      "ok",
      plan.noteCount === 1
        ? `笔记包已导出${mediaCount ? `（含 ${mediaCount} 张图）` : ""}`
        : `已导出 ${plan.noteCount} 条笔记${
            mediaCount ? `、${mediaCount} 张图` : ""
          }`
    );
  } catch (error) {
    tip("warn", `导出失败：${exportErrorMessage(error)}`);
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
    onboarding.rehearsalStatus !== "active" ||
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
