import { useEffect, useMemo, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { motion } from "motion/react";
import {
  Check,
  ImagePlus,
  Pin,
  Send,
  X,
} from "lucide-react";

import { DataReadOnlyGuard } from "@/components/DataReadOnlyGuard";
import { DetailWindowFrame } from "@/components/DetailWindowFrame";
import {
  RichImageBlock,
  RichNoteContent,
  RichNoteTextEditor,
} from "@/components/RichNoteContent";
import { stats } from "@/components/PreviewOverlay";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { MacTrafficLights } from "@/components/ui/mac-close-button";
import { DETAIL_STATE_EVENT } from "@/lib/detailWindows";
import { Segmented } from "@/components/ui/segmented";
import { SimpleMenu, SimpleMenuItem } from "@/components/SimpleMenu";
import { TextSelectionToolbar } from "@/components/TextSelectionToolbar";
import {
  NOTE_EDIT_AUTOSAVE_INTERVAL_MS,
  NOTE_EDIT_SYNC_RESULT_EVENT,
  NOTE_TAGS_EVENT,
  RUN_PENDING_UNDO_EVENT,
  type NoteEditPayload,
  type NoteEditSyncResultPayload,
  type NotePreviewPayload,
  type NoteTagsPayload,
} from "@/lib/actions";
import { requestAliasQuickAdd } from "@/lib/aliasQuickAdd";
import { highlightCode } from "@/lib/code";
import { NOTE_EDITOR_SESSION_RELEASE_EVENT } from "@/lib/editorSessionMedia";
import { useAppIcon } from "@/lib/icons";
import { timeAgo, useNoteThumb } from "@/lib/media";
import {
  looksLikeMarkdown,
  renderMarkdown,
  toggleTaskListItem,
} from "@/lib/markdown";
import { textareaSelectionAnchor } from "@/lib/selectionAnchor";
import { springSnappy } from "@/lib/motion";
import {
  hasOrderedRichLayout,
  normalizeNoteContentBlocks,
  replaceNoteImageFile,
  textBlockRanges,
  textFromContentBlocks,
  type NoteContentBlock,
} from "@/lib/noteContentBlocks";
import {
  NOTE_IMAGE_REPLACED_EVENT,
  advanceNoteImageEditSequence,
  type ImagePreviewEditContext,
  type NoteImageReplacedPayload,
} from "@/lib/imageEditor";
import {
  appendPreviewContent,
  editorInsertRejectionReason,
  hasRecentEditorInsertOperation,
  NOTE_EDITOR_INSERT_EVENT,
  NOTE_EDITOR_INSERT_RESULT_EVENT,
  previewIsEditable,
  rememberEditorInsertOperation,
  refreshPreviewPayload,
  type NoteEditorInsertPayload,
  type NoteEditorInsertResultPayload,
} from "@/lib/previewPayload";
import {
  DATA_ACTIVITY_EVENT,
  DATA_LOCATION_CHANGED_EVENT,
} from "@/lib/dataOperations";
import { DATA_CONTEXT_INVALIDATED_EVENT } from "@/lib/dataGeneration";
import {
  resolveSourceSelection,
  type SelectionEdit,
  type TextSelection,
} from "@/lib/selectionFormat";
import {
  api,
  TARGET_CHANGED_EVENT,
  type PastedImage,
  type TargetSnapshot,
} from "@/lib/tauri";
import { imageFilePaths } from "@/lib/imageFiles";
import {
  DETAIL_FONT_SIZE_EVENT,
  SETTINGS_PATCH,
} from "@/lib/settingsSync";
import {
  clampDetailFontSize,
  DETAIL_FONT_SIZE_DEFAULT,
  NOTE_TAG_MAX_COUNT,
} from "@/store/notesStore";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import {
  applyTargetEvent,
  readTarget,
  targetBlockMessage,
  useTargetStore,
} from "@/store/targetStore";

/**
 * 文本详情窗（独立 webview，桌面居中）：窄面板放不下长文，文字类卡片的
 * 预览与编辑都在这里。标题栏可拖动窗口；Esc 关闭（编辑态先退编辑）；
 * ⌘⏎ 保存。窗口隐藏复用，内容经 toskr://note-preview 事件下发；
 * 编辑保存 / 发送经事件回传主面板执行（主面板是唯一持久化写入方）。
 * 编辑态每 2s 静默自动保存；Esc/关窗/切卡都保留内容（清空草稿才还原），
 * 收尾「已保存」气泡可撤销 = 回到本次编辑前。
 */
/** 附件缩略块：懒取缩略图，点击 Quick Look；悬停右上角 ⊗ 从卡片移除该图。 */
function AttachThumb({
  file,
  onClick,
  onRemove,
}: {
  file: string;
  onClick: () => void;
  onRemove?: () => void;
}) {
  const url = useNoteThumb(file);
  return (
    <div className="group relative shrink-0">
      <button
        aria-label="查看图片"
        onClick={onClick}
        className={cn(
          "flex size-12 items-center justify-center overflow-hidden rounded-md",
          "border border-foreground/10 bg-black/[0.04] outline-none dark:bg-white/[0.06]",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        )}
      >
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="size-4 animate-pulse rounded-sm bg-black/10 dark:bg-white/10" />
        )}
      </button>
      {onRemove && (
        /* 常显于键盘焦点，悬停才淡入——缩略图只有 48px，常驻 ⊗ 会盖住画面 */
        <button
          aria-label="从卡片移除这张图片"
          title="从卡片移除这张图片"
          onClick={onRemove}
          className={cn(
            "absolute -right-1 -top-1 rounded-full bg-foreground/80 p-0.5 text-background",
            "opacity-0 outline-none transition-opacity group-hover:opacity-100",
            "focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          )}
        >
          <X className="size-2.5" />
        </button>
      )}
    </div>
  );
}

/** 详情窗只上报本次编辑新增且放弃的文件；主窗口会再按全库引用过滤后删盘。 */
/** 操作坞文字钮（无界剧场）：ghost 样式；active = 开关型按下态（选词/渲染） */
function DockOp({
  active,
  className,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      {...props}
      className={cn(
        "rounded-lg px-3 py-1.5 text-body text-muted-foreground outline-none",
        "transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        active && "bg-black/5 text-foreground dark:bg-white/10",
        className
      )}
    />
  );
}

function discardDraftImages(
  original: string[],
  draft: string[],
  dataGeneration?: number
) {
  const originalSet = new Set(original);
  const files = [...new Set(draft.filter((file) => !originalSet.has(file)))];
  if (files.length && dataGeneration !== undefined) {
    void emitTo("main", "toskr://note-image-discard", { files, dataGeneration });
  }
}

function releaseEditorSession(note: NotePreviewPayload | null) {
  if (!note) return;
  void emitTo("main", NOTE_EDITOR_SESSION_RELEASE_EVENT, {
    targetSessionId: note.sessionId,
    dataGeneration: note.dataGeneration,
  }).catch(() => {});
}

/** 选词模式的一个可点选单元；start/end 是相对整卡投影文本的偏移。 */
type PickSegment = {
  text: string;
  start: number;
  end: number;
  wordLike: boolean;
};

const sameFiles = (a: string[], b: string[]) =>
  a.length === b.length && a.every((file, index) => file === b[index]);

const replaceImageRefs = (files: readonly string[], source: string, edited: string) =>
  files.map((file) => file === source ? edited : file);

/** 编辑会话账本：origin = 本次编辑前内容；persisted* = 最近一次已写库内容。 */
type AutosaveSession = {
  origin: { text: string; images: string[]; blocks: NoteContentBlock[] | null };
  persistedText: string;
  persistedImages: string[];
  persistedBlocksJson: string | null;
};

type TextEditSnapshot = SelectionEdit & { images: string[] };
type TextEditHistory = {
  undo: TextEditSnapshot[];
  redo: TextEditSnapshot[];
  group: { kind: "insert" | "backspace" | "delete"; at: number } | null;
};

const freshTextEditHistory = (): TextEditHistory => ({
  undo: [],
  redo: [],
  group: null,
});

const TEXT_HISTORY_MAX_ITEMS = 100;
const TEXT_HISTORY_MAX_CHARS = 1_000_000;

function trimTextEditHistory(history: TextEditHistory) {
  const totalChars = () =>
    [...history.undo, ...history.redo].reduce(
      (total, snapshot) => total + snapshot.text.length,
      0
    );
  while (
    history.undo.length + history.redo.length > TEXT_HISTORY_MAX_ITEMS ||
    totalChars() > TEXT_HISTORY_MAX_CHARS
  ) {
    if (history.undo.length > 1) history.undo.shift();
    else if (history.redo.length > 1) history.redo.shift();
    else break;
  }
}

function snapshotTextarea(
  textarea: HTMLTextAreaElement,
  images: string[]
): TextEditSnapshot {
  return {
    text: textarea.value,
    images: [...images],
    selection: {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    },
  };
}

function checkpointTextEdit(history: TextEditHistory, snapshot: TextEditSnapshot) {
  const last = history.undo[history.undo.length - 1];
  if (
    !last ||
    last.text !== snapshot.text ||
    last.images.length !== snapshot.images.length ||
    last.images.some((file, index) => file !== snapshot.images[index]) ||
    last.selection.start !== snapshot.selection.start ||
    last.selection.end !== snapshot.selection.end
  ) {
    history.undo.push(snapshot);
  }
  history.redo = [];
  trimTextEditHistory(history);
  history.group = null;
}

function beginTextEditGroup(
  history: TextEditHistory,
  snapshot: TextEditSnapshot,
  kind: NonNullable<TextEditHistory["group"]>["kind"] | null,
  at: number
) {
  const continuesGroup =
    !!kind && history.group?.kind === kind && at - history.group.at < 1000;
  if (!continuesGroup) checkpointTextEdit(history, snapshot);
  history.group = kind ? { kind, at } : null;
}

function inputEditGroup(
  inputType: string
): "insert" | "backspace" | "delete" | null {
  if (inputType.startsWith("insertText") || inputType.includes("Composition")) {
    return "insert";
  }
  if (inputType === "deleteContentBackward") return "backspace";
  if (inputType === "deleteContentForward") return "delete";
  return null;
}

/** 替换正文并恢复选区；历史栈由调用方维护，避免受 WKWebView 原生分组差异影响。 */
function applyTextareaEdit(textarea: HTMLTextAreaElement, edit: SelectionEdit) {
  textarea.focus();
  textarea.setRangeText(edit.text, 0, textarea.value.length, "end");
  textarea.setSelectionRange(edit.selection.start, edit.selection.end);
}

async function emitNoteEditWithAck(payload: NoteEditPayload): Promise<boolean> {
  const syncId = globalThis.crypto.randomUUID();
  let resolveAck!: (ok: boolean) => void;
  const ack = new Promise<boolean>((resolve) => { resolveAck = resolve; });
  const stop = await listen<NoteEditSyncResultPayload>(
    NOTE_EDIT_SYNC_RESULT_EVENT,
    (event) => {
      if (event.payload.syncId === syncId) resolveAck(event.payload.ok);
    }
  );
  const timeout = window.setTimeout(() => resolveAck(false), 4_000);
  try {
    await emitTo("main", "toskr://note-edit", { ...payload, syncId });
    return await ack;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
    stop();
  }
}

export default function TextPreviewView() {
  const [note, setNote] = useState<NotePreviewPayload | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftEmpty, setDraftEmpty] = useState(true);
  const [draftImages, setDraftImages] = useState<string[]>([]);
  const [draftContentBlocks, setDraftContentBlocks] = useState<
    NoteContentBlock[]
  >([]);
  const [mdView, setMdView] = useState(false);
  // 📌 固定窗口：发送/发送选中后不自动关窗；主动关闭（X/Esc/空格）与数据失效关窗不受影响
  const [winPinned, setWinPinned] = useState(false);
  const winPinnedRef = useRef(winPinned);
  winPinnedRef.current = winPinned;
  // 编辑态的 Markdown 预览开关：textarea 以 hidden 保留 DOM（原生撤销/草稿
  // 不因卸载丢失），预览为当前草稿的只读渲染
  const [editPreviewOn, setEditPreviewOn] = useState(false);
  // 核对清单在预览里被点选后草稿（ref）已变，靠它触发重渲
  const [, setTaskTick] = useState(0);
  const [textSelection, setTextSelection] = useState<TextSelection | null>(null);
  // 选词模式：正文按分词渲染为可点选区块，点选驱动 textSelection（复用选中工具条）
  const [pickMode, setPickMode] = useState(false);
  // 粒度：词（Intl.Segmenter 分词）/ 段（按换行分段）；切换即清空已选范围
  const [pickGranularity, setPickGranularity] = useState<"word" | "paragraph">(
    "word"
  );
  const [pick, setPick] = useState<{ anchor: number; focus: number } | null>(null);
  // 每次唤起自增：窗口隐藏复用，重开也要重播内容浮现
  const [gen, setGen] = useState(0);
  // 标签内联输入（null = 未在输入；"" = 输入框已开待输入）
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  // 拖拽图片悬停提示（松开添加）
  const [dropActive, setDropActive] = useState(false);
  // 正文字号（px）：⌘+/⌘- 调整、⌘0 复位；与设置页滑杆经主面板双向同步
  const [fontSize, setFontSize] = useState(DETAIL_FONT_SIZE_DEFAULT);
  const fontSizeRef = useRef(fontSize);
  // ——— 无界剧场（A×E，2026-08-27 用户选定）：贴缘唤出 chrome / 毛玻璃膜层 ———
  const [chromeOn, setChromeOn] = useState(true);
  const chromeHideTimerRef = useRef<number | null>(null);
  const [glassOn, setGlassOn] = useState(true);
  /** 本次载荷是否新建占位（selectAll 只有新建流程传）：关窗未改则回收。 */
  const blankDraftRef = useRef(false);
  // 长按发送选目标：候选 = 运行中的常规 GUI 应用；点选后采信为目标再发送
  const [sendTargets, setSendTargets] = useState<
    { pid: number; name: string; bundleId: string }[]
  >([]);
  const sendLongPressTimerRef = useRef<number | null>(null);
  const sendLongPressFiredRef = useRef(false);
  fontSizeRef.current = fontSize;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 正文由 textarea DOM 持有，避免每次按键的 React 回写切断原生撤销分组。
  const draftRef = useRef("");
  const draftImagesRef = useRef<string[]>([]);
  const draftContentBlocksRef = useRef<NoteContentBlock[]>([]);
  const sessionPastedImagesRef = useRef<Set<string>>(new Set());
  const editSessionTokenRef = useRef(0);
  const composingRef = useRef(false);
  const skipNextBeforeInputRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentFrameRef = useRef<HTMLDivElement>(null);
  const previewContentRef = useRef<HTMLElement>(null);
  // 选中工具条锚点（正文容器坐标系）；null = 取不到（选词模式等）回退底部居中
  const [toolbarAnchor, setToolbarAnchor] = useState<{
    left: number;
    top: number;
    bottom: number;
  } | null>(null);
  const pendingSelectionRef = useRef<TextSelection | null>(null);
  const pendingTextEditRef = useRef<SelectionEdit | null>(null);
  const pendingTextEditImagesRef = useRef<string[] | null>(null);
  const pendingTextEditBeforeRef = useRef<TextEditSnapshot | null>(null);
  const appliedInsertOperationsRef = useRef(new Map<string, number>());
  const noteRef = useRef<NotePreviewPayload | null>(null);
  const autosaveSessionRef = useRef<AutosaveSession | null>(null);
  const noteImageEditSequencesRef = useRef(new Map<string, number>());
  const textEditHistoryRef = useRef<TextEditHistory>(freshTextEditHistory());
  const editSessionRef = useRef({
    original: [] as string[],
    editing: false,
    dataGeneration: undefined as number | undefined,
  });
  const icon = useAppIcon(note?.sourceBundle ?? undefined);
  // 发送键前置目标名（「发送到 Chrome」）：发去哪里按之前就看得见
  const targetAppName = useTargetStore(
    (state) => state.snapshot?.appName ?? null
  );
  const targetReady = useTargetStore(
    (state) => state.status === "ready" && !state.profileOverrideNeedsConfirmation
  );
  const targetBlockedMessage = useTargetStore((state) =>
    state.profileOverrideNeedsConfirmation
      ? "原临时发送方案已暂停"
      : state.status === "ready"
        ? null
        : targetBlockMessage(state.status, state.reason)
  );

  useEffect(() => {
    editSessionRef.current = {
      original: note?.images ?? [],
      editing,
      dataGeneration: note?.dataGeneration,
    };
  }, [editing, note?.dataGeneration, note?.images]);

  // 编辑自动保存：进入编辑先快照「本次编辑前内容」，随后按固定间隔把草稿
  // 静默写回主面板（autosave 事件只持久化，不释放会话/不提示）。崩溃、关窗、
  // 切卡最多丢一个间隔内的输入；收尾保存与 HUD「撤销」都以 origin 为基准。
  useEffect(() => {
    if (!editing) return;
    const current = noteRef.current;
    if (!previewIsEditable(current)) return;
    const blocks =
      hasOrderedRichLayout(current.contentBlocks) && current.contentBlocks
        ? current.contentBlocks
        : null;
    autosaveSessionRef.current = {
      origin: { text: current.text, images: [...current.images], blocks },
      persistedText: current.text,
      persistedImages: [...current.images],
      persistedBlocksJson: blocks
        ? JSON.stringify(normalizeNoteContentBlocks(blocks))
        : null,
    };
    const tick = () => {
      const session = autosaveSessionRef.current;
      const target = noteRef.current;
      if (!session || !previewIsEditable(target)) return;
      if (session.origin.blocks) {
        const nextBlocks = normalizeNoteContentBlocks(
          draftContentBlocksRef.current
        );
        const json = JSON.stringify(nextBlocks);
        if (json === session.persistedBlocksJson) return;
        void emitTo("main", "toskr://note-edit", {
          format: "blocks",
          id: target.id,
          contentBlocks: nextBlocks,
          dataGeneration: target.dataGeneration,
          autosave: true,
        } satisfies NoteEditPayload);
        session.persistedBlocksJson = json;
        return;
      }
      const text = draftRef.current;
      const images = draftImagesRef.current;
      // 清空态不落库：未写完的空草稿覆盖原文只会造成二次事故
      if (!text.trim() && images.length === 0) return;
      if (
        text === session.persistedText &&
        sameFiles(images, session.persistedImages)
      ) {
        return;
      }
      void emitTo("main", "toskr://note-edit", {
        format: "flat",
        id: target.id,
        text,
        images,
        dataGeneration: target.dataGeneration,
        autosave: true,
      } satisfies NoteEditPayload);
      session.persistedText = text;
      session.persistedImages = [...images];
    };
    const timer = window.setInterval(tick, NOTE_EDIT_AUTOSAVE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      autosaveSessionRef.current = null;
      // 会话结束顺带收掉编辑态 Markdown 预览（下次进入编辑从原文开始）
      setEditPreviewOn(false);
    };
    // 依赖只认「会话身份」（进出编辑、换卡）；note 对象在保存时会换引用，
    // 不能让它触发重建，否则 origin 会被覆盖成编辑后的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, note?.id]);

  useEffect(() => {
    const changed = listen<TargetSnapshot>(TARGET_CHANGED_EVENT, (event) => {
      applyTargetEvent(event.payload);
    });
    return () => {
      changed.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    const replaced = listen<NoteImageReplacedPayload>(
      NOTE_IMAGE_REPLACED_EVENT,
      (event) => {
        const payload = event.payload;
        const current = noteRef.current;
        if (!advanceNoteImageEditSequence(
          noteImageEditSequencesRef.current,
          payload.noteId,
          payload.dataGeneration,
          payload.sequence
        )) return;
        // 即使当前窗显示的是别卡，也记录该笔记水位，防止切回后接受迟到事件。
        if (
          !current || current.id !== payload.noteId ||
          current.dataGeneration !== payload.dataGeneration ||
          !payload.sourceFile || !payload.editedFile ||
          !Number.isSafeInteger(payload.width) || payload.width <= 0 ||
          !Number.isSafeInteger(payload.height) || payload.height <= 0
        ) return;
        const currentBlocks = current.contentBlocks ?? null;
        const inBlocks = currentBlocks?.some(
          (block) => block.type === "image" && block.file === payload.sourceFile
        ) ?? false;
        const inDraft = draftImagesRef.current.includes(payload.sourceFile) ||
          draftContentBlocksRef.current.some(
            (block) => block.type === "image" && block.file === payload.sourceFile
          );
        if (
          !current.images.includes(payload.sourceFile) && !inBlocks && !inDraft
        ) return;

        const edit = {
          file: payload.editedFile,
          width: payload.width,
          height: payload.height,
        };
        const nextBlocks = currentBlocks
          ? replaceNoteImageFile(currentBlocks, payload.sourceFile, edit)
          : currentBlocks;
        const nextNote = {
          ...current,
          images: replaceImageRefs(
            current.images,
            payload.sourceFile,
            payload.editedFile
          ),
          contentBlocks: nextBlocks,
        };
        noteRef.current = nextNote;
        setNote(nextNote);

        draftImagesRef.current = replaceImageRefs(
          draftImagesRef.current,
          payload.sourceFile,
          payload.editedFile
        );
        setDraftImages(draftImagesRef.current);
        if (draftContentBlocksRef.current.some(
          (block) => block.type === "image" && block.file === payload.sourceFile
        )) {
          draftContentBlocksRef.current = replaceNoteImageFile(
            draftContentBlocksRef.current,
            payload.sourceFile,
            edit
          );
          setDraftContentBlocks(draftContentBlocksRef.current);
        }

        const session = autosaveSessionRef.current;
        if (session) {
          session.origin.images = replaceImageRefs(
            session.origin.images,
            payload.sourceFile,
            payload.editedFile
          );
          session.persistedImages = replaceImageRefs(
            session.persistedImages,
            payload.sourceFile,
            payload.editedFile
          );
          if (session.origin.blocks) {
            session.origin.blocks = replaceNoteImageFile(
              session.origin.blocks,
              payload.sourceFile,
              edit
            );
          }
          if (session.persistedBlocksJson) {
            try {
              session.persistedBlocksJson = JSON.stringify(
                replaceNoteImageFile(
                  normalizeNoteContentBlocks(
                    JSON.parse(session.persistedBlocksJson) as unknown
                  ),
                  payload.sourceFile,
                  edit
                )
              );
            } catch {
              // 下一次自动保存会按 draft ref 重建正确持久态。
              session.persistedBlocksJson = null;
            }
          }
        }
        const history = textEditHistoryRef.current;
        for (const snapshot of [...history.undo, ...history.redo]) {
          snapshot.images = replaceImageRefs(
            snapshot.images,
            payload.sourceFile,
            payload.editedFile
          );
        }
        if (pendingTextEditImagesRef.current) {
          pendingTextEditImagesRef.current = replaceImageRefs(
            pendingTextEditImagesRef.current,
            payload.sourceFile,
            payload.editedFile
          );
        }
        if (sessionPastedImagesRef.current.delete(payload.sourceFile)) {
          sessionPastedImagesRef.current.add(payload.editedFile);
        }
      }
    );
    return () => {
      replaced.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    // 必须窗口级监听：Tauri v2 全局 listen 是 Any 目标，emitTo 定向到别的
    // 详情窗的载荷这里也会收到——📌 多窗并存时 pinned 窗会被新窗内容串台
    const un = getCurrentWebviewWindow().listen<NotePreviewPayload>(
      "toskr://note-preview",
      (e) => {
      const p = e.payload;
      // 换内容先收尾旧编辑会话：自动保存语义下切卡不丢稿
      // （保留内容；空草稿还原原文）。save/cancel 只读 ref，不受闭包旧 state 影响
      if (editSessionRef.current.editing && previewIsEditable(noteRef.current)) {
        exitEditing();
      }
      const previousNote = noteRef.current;
      if (previousNote?.sessionId !== p.sessionId) {
        releaseEditorSession(previousNote);
      }
      editSessionTokenRef.current += 1;
      const previous = editSessionRef.current;
      if (previous.editing) {
        discardDraftImages(
          previous.original,
          [...sessionPastedImagesRef.current],
          previous.dataGeneration
        );
      }
      sessionPastedImagesRef.current.clear();
      appliedInsertOperationsRef.current.clear();
      noteRef.current = p;
      setNote(p);
      void api
        .diagNote(
          `详情窗载荷 label=${getCurrentWebviewWindow().label} note=${p.id.slice(0, 8)}`
        )
        .catch(() => {});
      // 投递回执必须即刻发（同卡重开 note.id 不变，状态上报 effect 不会触发）；
      // pinned 走 ref 镜像，别把主面板注册表里的 📌 冲成 false
      void emitTo("main", DETAIL_STATE_EVENT, {
        label: getCurrentWebviewWindow().label,
        pinned: winPinnedRef.current,
        noteId: p.id,
      }).catch(() => {});
      draftRef.current = p.text;
      setDraftEmpty(!p.text.trim());
      draftImagesRef.current = p.images;
      setDraftImages(p.images);
      draftContentBlocksRef.current = p.contentBlocks ?? [];
      setDraftContentBlocks(p.contentBlocks ?? []);
      setEditing(previewIsEditable(p) && p.edit);
      setEditPreviewOn(false);
      setMdView(!p.codeLang && p.kind !== "link" && looksLikeMarkdown(p.text));
      // 窗口隐藏复用、组件不卸载：选词模式是单次查看态，换内容必须归位，
      // 否则一次开启会"传染"给之后打开的所有卡片
      setPickMode(false);
      // 📌 同理不跨卡传染（用户 2026-08-27）：打开另一张卡回到未固定，
      // 每次要用再手动开；同卡内容刷新不动它
      if (previousNote?.id !== p.id) setWinPinned(false);
      setPick(null);
      setTextSelection(null);
      blankDraftRef.current = !!p.selectAll;
      // 新建笔记：整选占位文案，落指即替换（编辑聚焦 effect 消费该选区）
      pendingSelectionRef.current =
        p.selectAll && p.edit && previewIsEditable(p)
          ? { start: 0, end: p.text.length }
          : null;
      pendingTextEditRef.current = null;
      pendingTextEditImagesRef.current = null;
      pendingTextEditBeforeRef.current = null;
      textEditHistoryRef.current = freshTextEditHistory();
      if (p.fontSize) setFontSize(clampDetailFontSize(p.fontSize));
      setTagDraft(null);
      setGen((g) => g + 1);
      bodyRef.current?.scrollTo({ top: 0 });
      // 独立 WebView 只读同步当前 token；先注册 target event，让在途旧响应
      // 服从更新事件，但不能因打开详情窗轮换 Native token。
      void readTarget();
      }
    );
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const un = listen<NoteEditorInsertPayload>(
      NOTE_EDITOR_INSERT_EVENT,
      (event) => {
        const currentNote = noteRef.current;
        const payload = event.payload;
        const respond = (
          status: NoteEditorInsertResultPayload["status"],
          reason?: string
        ) => {
          void emitTo(
            "main",
            NOTE_EDITOR_INSERT_RESULT_EVENT,
            {
              requestId: payload.requestId,
              targetId: payload.targetId,
              targetSessionId: payload.targetSessionId,
              dataGeneration: payload.dataGeneration,
              status,
              ...(reason ? { reason } : {}),
            } satisfies NoteEditorInsertResultPayload
          ).catch(() => {});
        };
        const rejection = editorInsertRejectionReason(currentNote, payload);
        if (rejection) {
          respond("rejected", rejection);
          return;
        }
        if (hasOrderedRichLayout(currentNote?.contentBlocks)) {
          respond("rejected", "有序图文卡仅支持编辑现有文字段落");
          return;
        }
        const applied = appliedInsertOperationsRef.current;
        if (hasRecentEditorInsertOperation(applied, payload.operationKey)) {
          respond("applied");
          return;
        }
        const acknowledgeApplied = () => {
          rememberEditorInsertOperation(applied, payload.operationKey);
          respond("applied");
        };
        try {
          const appended = appendPreviewContent(
            draftRef.current,
            draftImagesRef.current,
            payload.text,
            payload.images
          );
          const edit: SelectionEdit = {
            text: appended.text,
            selection: appended.selection,
          };
          const textarea = textareaRef.current;
          if (textarea) {
            checkpointTextEdit(
              textEditHistoryRef.current,
              snapshotTextarea(textarea, draftImagesRef.current)
            );
            applyTextareaEdit(textarea, edit);
            draftRef.current = appended.text;
            draftImagesRef.current = appended.images;
            setDraftImages(appended.images);
            setDraftEmpty(!appended.text.trim());
            setTextSelection(null);
            pendingSelectionRef.current = null;
            acknowledgeApplied();
            return;
          }
          if (!pendingTextEditBeforeRef.current) {
            pendingTextEditBeforeRef.current = {
              text: draftRef.current,
              images: [...draftImagesRef.current],
              selection: {
                start: draftRef.current.length,
                end: draftRef.current.length,
              },
            };
          }
          pendingTextEditRef.current = edit;
          pendingTextEditImagesRef.current = appended.images;
          draftRef.current = appended.text;
          draftImagesRef.current = appended.images;
          setDraftImages(appended.images);
          setDraftEmpty(!appended.text.trim());
          setTextSelection(null);
          pendingSelectionRef.current = null;
          setEditing(true);
          acknowledgeApplied();
        } catch (error) {
          respond("rejected", String(error));
        }
      }
    );
    return () => {
      un.then((stop) => stop());
    };
  }, []);

  // 正文字号：⌘+/⌘-/⌘0 全窗生效（capture 先于 textarea 的 stopPropagation）；
  // 改动经 SETTINGS_PATCH 回主面板持久化，主面板再回声推送（幂等）。
  useEffect(() => {
    const applySize = (next: number) => {
      const clamped = clampDetailFontSize(next);
      if (clamped === fontSizeRef.current) return;
      setFontSize(clamped);
      void emitTo("main", SETTINGS_PATCH, { detailFontSize: clamped }).catch(
        () => {}
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        applySize(fontSizeRef.current + 1);
      } else if (e.key === "-") {
        e.preventDefault();
        applySize(fontSizeRef.current - 1);
      } else if (e.key === "0") {
        e.preventDefault();
        applySize(DETAIL_FONT_SIZE_DEFAULT);
      } else if (!e.shiftKey && e.key.toLowerCase() === "w") {
        // ⌘W 关当前详情窗（mac 肌肉记忆；close 经渲染期直赋镜像防陈旧闭包）
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    const push = listen<{ size: number }>(DETAIL_FONT_SIZE_EVENT, (event) => {
      setFontSize(clampDetailFontSize(event.payload.size));
    });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      push.then((stop) => stop());
    };
  }, []);

  // 拖拽本地图片进窗（Tauri 层接管 file drop，HTML5 drop 收不到路径）。
  // 回调是首帧闭包：判定与追加全部只读 ref。
  useEffect(() => {
    const un = getCurrentWebviewWindow().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter") {
        setDropActive(
          previewIsEditable(noteRef.current) &&
            imageFilePaths(payload.paths).length > 0
        );
        return;
      }
      if (payload.type === "leave") {
        setDropActive(false);
        return;
      }
      if (payload.type === "drop") {
        setDropActive(false);
        if (!previewIsEditable(noteRef.current)) return;
        importDroppedImages(payload.paths);
      }
    });
    return () => {
      un.then((stop) => stop());
    };
    // importDroppedImages 只读 ref，首帧闭包安全
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const invalidate = () => {
      releaseEditorSession(noteRef.current);
      editSessionTokenRef.current += 1;
      sessionPastedImagesRef.current.clear();
      noteRef.current = null;
      setNote(null);
      setEditing(false);
      void getCurrentWebviewWindow().hide();
    };
    const activity = listen<{ locked: boolean }>(DATA_ACTIVITY_EVENT, (event) => {
      if (event.payload.locked) invalidate();
    });
    const changed = listen(DATA_LOCATION_CHANGED_EVENT, invalidate);
    const invalidated = listen(DATA_CONTEXT_INVALIDATED_EVENT, invalidate);
    return () => {
      activity.then((stop) => stop());
      changed.then((stop) => stop());
      invalidated.then((stop) => stop());
    };
  }, []);

  // 工具条只在「选中文字」状态存在：除工具条自身外，任何位置鼠标按下都先
  // 收起（正文里点选/拖选会经 onSelect/selectionchange 重新弹出）。点正文
  // 空白处 WebKit 可能不塌缩 DOM 选区、点按钮又不转移焦点，只有这种
  // 「按下即收」才能保证取消选中时工具条立刻消失
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      // 手势起点落在正文滚动区内才算「选择手势」：pointerup 兜底同步只认它，
      // 页脚/标题栏/工具条上的按下不会在抬起时把刚收起的工具条又拉回来
      selectionGestureRef.current = !!(
        target && bodyRef.current?.contains(target)
      );
      // 选词模式选区由键帽点击驱动、Esc 撤选，另有通道，勿在按下时抢清
      if (pickModeRef.current) return;
      if (!target) return;
      if (target.closest?.('[role="toolbar"]')) return;
      setTextSelection(null);
    };
    // 拖选的抬手点经常落在正文区外（页脚/标题栏/缩略条/窗口边缘甚至窗外），
    // 只挂在正文 div 的 onPointerUp 收不到 → 文本已选中但工具条不弹（偶发）。
    // 窗口级捕获监听兜底，顺带对子元素 stopPropagation 免疫
    const onPointerUp = () => {
      if (!selectionGestureRef.current) return;
      selectionGestureRef.current = false;
      syncPreviewSelectionRef.current();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
    };
  }, []);

  // 兜底：查看态 DOM 选区一塌缩（点正文任意处/空白处取消选中）立刻收工具条。
  // 选词模式的选区不走 DOM Selection、编辑态由 textarea onSelect 负责，均不受影响。
  // 编辑态屏障必须用渲染期直赋的镜像（pickModeRef 同款），不能读 editSessionRef：
  // 那个 ref 靠 useEffect 异步镜像，与 selectionchange 任务无顺序保证——查看态
  // 双击进编辑时正文 DOM 卸载、选区塌缩，事件若抢在镜像 effect 前到达，会把
  // 刚随选区出现的工具条误杀（闪出即消失）
  const pickModeRef = useRef(pickMode);
  pickModeRef.current = pickMode;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const selectionGestureRef = useRef(false);
  // syncPreviewSelection 每轮渲染重建（闭包持有 note/editing），窗口级监听经
  // 渲染期直赋镜像取最新实现，避免 [] effect 里的陈旧闭包
  const syncPreviewSelectionRef = useRef<() => void>(() => {});

  // 无界剧场 chrome 唤出：光标移动/按下、任意按键、焦点进入任一控件都算活跃，
  // 静止 2.5s 或光标离窗淡出；编辑/选词/标签输入由 chromeVisible 兜底常显。
  // 一律窗口级 capture 监听（WKWebView 焦点不可赌的项目约定；textarea 的
  // stopPropagation 也拦不住 capture 阶段）。
  useEffect(() => {
    let lastPoke = 0;
    let pointerInside = false;
    const poke = () => {
      const now = performance.now();
      if (now - lastPoke < 250) return;
      lastPoke = now;
      setChromeOn(true);
      if (chromeHideTimerRef.current) {
        window.clearTimeout(chromeHideTimerRef.current);
      }
      // 光标仍在窗内时不因静止淡出（反复出没的闪烁感即用户反馈的「不丝滑」）；
      // 键盘唤出（光标在外）静止 2.5s 后收
      chromeHideTimerRef.current = window.setTimeout(() => {
        if (!pointerInside) setChromeOn(false);
      }, 2500);
    };
    const pointerPoke = () => {
      pointerInside = true;
      poke();
    };
    const hide = () => {
      pointerInside = false;
      if (chromeHideTimerRef.current) {
        window.clearTimeout(chromeHideTimerRef.current);
      }
      setChromeOn(false);
    };
    window.addEventListener("pointermove", pointerPoke, { capture: true });
    window.addEventListener("pointerdown", pointerPoke, { capture: true });
    window.addEventListener("keydown", poke, { capture: true });
    window.addEventListener("focusin", poke, { capture: true });
    document.documentElement.addEventListener("mouseleave", hide);
    return () => {
      window.removeEventListener("pointermove", pointerPoke, { capture: true });
      window.removeEventListener("pointerdown", pointerPoke, { capture: true });
      window.removeEventListener("keydown", poke, { capture: true });
      window.removeEventListener("focusin", poke, { capture: true });
      document.documentElement.removeEventListener("mouseleave", hide);
      if (chromeHideTimerRef.current) {
        window.clearTimeout(chromeHideTimerRef.current);
      }
    };
  }, []);

  // 毛玻璃开关（设置项）：开着时膜层半透明透出系统模糊；关着时透明窗没有
  // 模糊垫底，必须退回不透明底，否则桌面直接透进来
  useEffect(() => {
    void api.getVibrancyEnabled().then(setGlassOn).catch(() => {});
  }, []);

  // 多详情窗（📌 并存）：把本窗 {pinned, noteId} 上报主面板——
  // 首报兼作「新窗就绪」信号（主面板冲洗排队中的 note-preview 载荷）
  const winLabel = useMemo(() => {
    try {
      return getCurrentWebviewWindow().label;
    } catch {
      return "textpreview";
    }
  }, []);
  useEffect(() => {
    void emitTo("main", DETAIL_STATE_EVENT, {
      label: winLabel,
      pinned: winPinned,
      noteId: note?.id ?? null,
    }).catch(() => {});
  }, [winLabel, winPinned, note?.id]);

  // 大文渲染 memo：chrome 唤出/淡出只改顶条与坞的 opacity，正文的
  // Markdown/代码高亮不许跟着重算（动画首帧掉帧的主因）
  const mdHtml = useMemo(
    () => (note && !note.codeLang ? renderMarkdown(note.text) : ""),
    [note]
  );
  const codeHtml = useMemo(
    () => (note?.codeLang ? highlightCode(note.text, note.codeLang) : ""),
    [note]
  );

  useEffect(() => {
    const onSelectionChange = () => {
      if (pickModeRef.current || editingRef.current) return;
      const domSelection = document.getSelection();
      if (!domSelection || domSelection.isCollapsed || !domSelection.rangeCount) {
        setTextSelection(null);
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  // 选中工具条就近浮动：编辑态用 textarea 镜像测量、查看态用 DOM Range 矩形，
  // 都换算到正文容器坐标；滚动实时跟随。取不到（选词模式等）回退底部居中。
  useEffect(() => {
    const compute = () => {
      const frame = contentFrameRef.current;
      if (!frame || !textSelection) {
        setToolbarAnchor(null);
        return;
      }
      const frameRect = frame.getBoundingClientRect();
      if (editing) {
        const textarea = textareaRef.current;
        if (!textarea || textarea.classList.contains("hidden")) {
          setToolbarAnchor(null);
          return;
        }
        const anchor = textareaSelectionAnchor(textarea, textSelection);
        if (!anchor) {
          setToolbarAnchor(null);
          return;
        }
        const taRect = textarea.getBoundingClientRect();
        setToolbarAnchor({
          left: taRect.left - frameRect.left + anchor.left,
          top: taRect.top - frameRect.top + anchor.top,
          bottom: taRect.top - frameRect.top + anchor.bottom,
        });
        return;
      }
      if (pickMode) {
        // 选词模式没有 DOM Selection：用选中键帽的并集矩形做锚点，
        // 工具条贴着选中词浮动（与普通划选一致），不再退到底部与坞叠置
        const chips =
          previewContentRef.current?.querySelectorAll("[data-pick-selected]");
        if (chips && chips.length) {
          let left = Infinity;
          let right = -Infinity;
          let top = Infinity;
          let bottom = -Infinity;
          chips.forEach((chip) => {
            const r = chip.getBoundingClientRect();
            left = Math.min(left, r.left);
            right = Math.max(right, r.right);
            top = Math.min(top, r.top);
            bottom = Math.max(bottom, r.bottom);
          });
          setToolbarAnchor({
            left: (left + right) / 2 - frameRect.left,
            top: top - frameRect.top,
            bottom: bottom - frameRect.top,
          });
          return;
        }
        setToolbarAnchor(null);
        return;
      }
      const domSelection = document.getSelection();
      if (domSelection && domSelection.rangeCount && !domSelection.isCollapsed) {
        const rect = domSelection.getRangeAt(0).getBoundingClientRect();
        if (rect.width || rect.height) {
          setToolbarAnchor({
            left: rect.left - frameRect.left + rect.width / 2,
            top: rect.top - frameRect.top,
            bottom: rect.bottom - frameRect.top,
          });
          return;
        }
      }
      setToolbarAnchor(null);
    };
    compute();
    const body = bodyRef.current;
    const textarea = textareaRef.current;
    body?.addEventListener("scroll", compute, { passive: true });
    textarea?.addEventListener("scroll", compute, { passive: true });
    return () => {
      body?.removeEventListener("scroll", compute);
      textarea?.removeEventListener("scroll", compute);
    };
  }, [textSelection, editing, gen, pickMode, pick]);

  // 锚点 → 工具条定位样式：上方优先，顶部放不下改到选区下方；水平方向钳入容器
  const toolbarAnchorStyle = useMemo(() => {
    if (!toolbarAnchor) return null;
    const frame = contentFrameRef.current;
    const width = frame?.clientWidth ?? 0;
    const height = frame?.clientHeight ?? 0;
    // token-exception: 158px≈工具条半宽估值，纯定位钳制非视觉样式
    const left = width
      ? Math.min(Math.max(toolbarAnchor.left, 158), Math.max(width - 158, 158))
      : toolbarAnchor.left;
    if (toolbarAnchor.top > 52) {
      const top = Math.min(Math.max(toolbarAnchor.top - 6, 44), height || 9999);
      return { left, top, transform: "translate(-50%, -100%)" };
    }
    const top = Math.max(toolbarAnchor.bottom + 6, 8);
    return { left, top, transform: "translate(-50%, 0)" };
  }, [toolbarAnchor]);

  // 标签输入聚焦（WKWebView 焦点惰性 → 延时；autoFocus 在 DOM 复用下不重触发）
  const tagInputOpen = tagDraft !== null;
  useEffect(() => {
    if (tagInputOpen) {
      window.setTimeout(() => tagInputRef.current?.focus(), 30);
    }
  }, [tagInputOpen]);

  // 编辑态聚焦（WKWebView 焦点惰性 → 延时）
  useEffect(() => {
    if (editing) {
      window.setTimeout(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const pendingEdit = pendingTextEditRef.current;
        if (pendingEdit) {
          checkpointTextEdit(
            textEditHistoryRef.current,
            pendingTextEditBeforeRef.current ??
              snapshotTextarea(textarea, draftImagesRef.current)
          );
          applyTextareaEdit(textarea, pendingEdit);
          draftRef.current = pendingEdit.text;
          const pendingImages = pendingTextEditImagesRef.current;
          if (pendingImages) {
            draftImagesRef.current = pendingImages;
            setDraftImages(pendingImages);
          }
          setDraftEmpty(!pendingEdit.text.trim());
          setTextSelection(pendingEdit.selection);
          pendingTextEditRef.current = null;
          pendingTextEditImagesRef.current = null;
          pendingTextEditBeforeRef.current = null;
          pendingSelectionRef.current = null;
          return;
        }
        textarea.focus();
        const selection = pendingSelectionRef.current;
        if (selection) textarea.setSelectionRange(selection.start, selection.end);
        pendingSelectionRef.current = null;
      }, 30);
    }
  }, [editing, note?.id]);

  /** 收尾无改动/取消时，把编辑中已静默写库的内容还原回本次编辑前。 */
  const revertAutosavedDraft = () => {
    const session = autosaveSessionRef.current;
    const current = noteRef.current;
    if (!session || !previewIsEditable(current)) return;
    if (session.origin.blocks) {
      const originJson = JSON.stringify(
        normalizeNoteContentBlocks(session.origin.blocks)
      );
      if (session.persistedBlocksJson === originJson) return;
      void emitTo("main", "toskr://note-edit", {
        format: "blocks",
        id: current.id,
        contentBlocks: session.origin.blocks,
        dataGeneration: current.dataGeneration,
        autosave: true,
      } satisfies NoteEditPayload);
      session.persistedBlocksJson = originJson;
      return;
    }
    if (
      session.persistedText === session.origin.text &&
      sameFiles(session.persistedImages, session.origin.images)
    ) {
      return;
    }
    void emitTo("main", "toskr://note-edit", {
      format: "flat",
      id: current.id,
      text: session.origin.text,
      images: session.origin.images,
      dataGeneration: current.dataGeneration,
      autosave: true,
    } satisfies NoteEditPayload);
    session.persistedText = session.origin.text;
    session.persistedImages = [...session.origin.images];
  };

  const close = () => {
    if (editing && previewIsEditable(noteRef.current)) {
      // 关窗不再丢草稿：与 Esc 同语义收尾（保留内容；空草稿还原原文）
      exitEditing();
    }
    releaseEditorSession(noteRef.current);
    // 空白「新笔记」占位回收：本次是新建流程（selectAll 标记）且关窗时
    // 一个字没改 → 请主面板删掉这张占位卡，列表不留壳（校验在主面板侧）
    const current = noteRef.current;
    if (
      blankDraftRef.current &&
      current &&
      current.text.trim() === "新笔记" &&
      current.images.length === 0
    ) {
      void emitTo("main", "toskr://note-discard-blank", {
        id: current.id,
        dataGeneration: current.dataGeneration,
      }).catch(() => {});
    }
    blankDraftRef.current = false;
    // 📌 只对本次打开生效（用户 2026-08-27）：关窗即复位，重开同卡/换卡都不继承
    setWinPinned(false);
    void getCurrentWebviewWindow().hide();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  /** 放弃修改：还原到本次编辑前内容（清空草稿退出、数据失效等兜底路径）。 */
  const cancelEditing = () => {
    const current = noteRef.current;
    if (!current) return;
    // 先还原再报废弃图片：主面板按到达顺序处理，GC 复查时引用已回到原状
    revertAutosavedDraft();
    editSessionTokenRef.current += 1;
    discardDraftImages(
      current.images,
      [...sessionPastedImagesRef.current],
      current.dataGeneration
    );
    sessionPastedImagesRef.current.clear();
    releaseEditorSession(current);
    draftRef.current = current.text;
    setDraftEmpty(!current.text.trim());
    textEditHistoryRef.current = freshTextEditHistory();
    draftImagesRef.current = current.images;
    setDraftImages(current.images);
    draftContentBlocksRef.current = current.contentBlocks ?? [];
    setDraftContentBlocks(current.contentBlocks ?? []);
    setTextSelection(null);
    setEditing(false);
    // 编辑完自动回渲染视图（Typora 心智，2026-08-27 用户指定）：源码只在编辑时可见
    setMdView(
      !current.codeLang && current.kind !== "link" && looksLikeMarkdown(current.text)
    );
  };

  const save = () => {
    const current = noteRef.current;
    if (!previewIsEditable(current)) return;
    const session = autosaveSessionRef.current;
    if (hasOrderedRichLayout(current.contentBlocks) && current.contentBlocks) {
      const contentBlocks = normalizeNoteContentBlocks(
        draftContentBlocksRef.current
      );
      const changed =
        JSON.stringify(contentBlocks) !== JSON.stringify(current.contentBlocks);
      editSessionTokenRef.current += 1;
      if (changed) {
        const text = textFromContentBlocks(contentBlocks);
        const next = refreshPreviewPayload({ ...current, contentBlocks }, text);
        void emitTo(
          "main",
          "toskr://note-edit",
          {
            format: "blocks",
            id: current.id,
            sessionId: current.sessionId,
            contentBlocks,
            dataGeneration: current.dataGeneration,
            origin: session?.origin.blocks
              ? { contentBlocks: session.origin.blocks }
              : undefined,
          } satisfies NoteEditPayload
        );
        setNote(next.payload);
        noteRef.current = next.payload;
        draftContentBlocksRef.current = contentBlocks;
        setDraftContentBlocks(contentBlocks);
        draftRef.current = next.payload.text;
        setDraftEmpty(!next.payload.text.trim());
        setMdView(next.markdownView);
      } else {
        revertAutosavedDraft();
        releaseEditorSession(current);
        // 无变更退出同样自动回渲染视图（编辑完 = 看到渲染结果）
        setMdView(
          !current.codeLang &&
            current.kind !== "link" &&
            looksLikeMarkdown(current.text)
        );
      }
      setTextSelection(null);
      setEditing(false);
      return;
    }
    const text = draftRef.current.trim();
    const images = draftImagesRef.current;
    if (!text && images.length === 0) {
      tip("warn", "笔记内容不能为空");
      return;
    }
    const imagesChanged =
      images.length !== current.images.length ||
      images.some((file, index) => file !== current.images[index]);
    const discardedImages = [
      ...new Set([...current.images, ...sessionPastedImagesRef.current]),
    ].filter((file) => !images.includes(file));
    editSessionTokenRef.current += 1;
    if (text !== current.text || imagesChanged) {
      const next = refreshPreviewPayload({ ...current, images }, text);
      void emitTo(
        "main",
        "toskr://note-edit",
        {
          format: "flat",
          id: current.id,
          sessionId: current.sessionId,
          text: next.payload.text,
          images,
          discardedImages,
          dataGeneration: current.dataGeneration,
          origin: session
            ? { text: session.origin.text, images: session.origin.images }
            : undefined,
        } satisfies NoteEditPayload
      );
      setNote(next.payload);
      noteRef.current = next.payload;
      draftRef.current = next.payload.text;
      setDraftEmpty(!next.payload.text.trim());
      setMdView(next.markdownView);
    } else {
      revertAutosavedDraft();
      discardDraftImages(images, discardedImages, current.dataGeneration);
      releaseEditorSession(current);
      // 无变更退出同样自动回渲染视图（编辑完 = 看到渲染结果）
      setMdView(
        !current.codeLang &&
          current.kind !== "link" &&
          looksLikeMarkdown(current.text)
      );
    }
    sessionPastedImagesRef.current.clear();
    setTextSelection(null);
    textEditHistoryRef.current = freshTextEditHistory();
    setEditing(false);
  };

  /**
   * 渲染态核对清单点选：切换原文/草稿里第 N 个任务项的勾选。
   * 查看态直接静默落库（高频微操作不出气泡）；编辑预览态改草稿并同步
   * 隐藏 textarea（随自动保存持久化）。
   */
  const onMarkdownClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = (event.target as HTMLElement).closest?.(".md-task-checkbox");
    if (!box) return;
    const index = Number(box.getAttribute("data-task-index"));
    if (!Number.isFinite(index)) return;
    const current = noteRef.current;
    if (!previewIsEditable(current)) return;
    if (editSessionRef.current.editing) {
      const next = toggleTaskListItem(draftRef.current, index);
      if (next === null) return;
      const textarea = textareaRef.current;
      if (textarea) {
        checkpointTextEdit(
          textEditHistoryRef.current,
          snapshotTextarea(textarea, draftImagesRef.current)
        );
        textarea.value = next;
      }
      draftRef.current = next;
      setDraftEmpty(!next.trim());
      setTaskTick((t) => t + 1);
      return;
    }
    const next = toggleTaskListItem(current.text, index);
    if (next === null) return;
    void emitTo("main", "toskr://note-edit", {
      format: "flat",
      id: current.id,
      text: next,
      images: current.images,
      dataGeneration: current.dataGeneration,
      autosave: true,
    } satisfies NoteEditPayload);
    const refreshed = refreshPreviewPayload({ ...current }, next);
    setNote(refreshed.payload);
    noteRef.current = refreshed.payload;
    draftRef.current = refreshed.payload.text;
  };

  /** 标签写回主面板并同步本地 payload（详情窗只发事件，不直接写库）。 */
  const applyTags = (tags: string[]) => {
    const current = noteRef.current;
    if (!previewIsEditable(current)) return;
    void emitTo("main", NOTE_TAGS_EVENT, {
      id: current.id,
      tags,
      dataGeneration: current.dataGeneration,
    } satisfies NoteTagsPayload);
    const next = { ...current, tags };
    setNote(next);
    noteRef.current = next;
  };

  const removeTag = (tag: string) =>
    applyTags((noteRef.current?.tags ?? []).filter((item) => item !== tag));

  /** 提交内联标签输入：去 # 前缀去重；提交后保持输入开启便于连续添加。 */
  const commitTagDraft = () => {
    const value = (tagDraft ?? "").trim().replace(/^#+/, "").trim();
    if (!value) {
      setTagDraft(null);
      return;
    }
    const current = noteRef.current?.tags ?? [];
    if (!current.includes(value) && current.length < NOTE_TAG_MAX_COUNT) {
      applyTags([...current, value]);
    }
    setTagDraft("");
  };

  /** 退出编辑（Esc/关窗/切卡）：自动保存语义下保留内容；清空草稿视为放弃。 */
  const exitEditing = () => {
    const current = noteRef.current;
    if (!previewIsEditable(current)) return;
    const flatEmpty =
      !hasOrderedRichLayout(current.contentBlocks) &&
      !draftRef.current.trim() &&
      draftImagesRef.current.length === 0;
    if (flatEmpty) cancelEditing();
    else save();
  };

  /**
   * 把已入库图片追加到当前卡（四类卡统一入口，只读 ref 可被事件闭包调用）：
   * 编辑态进草稿（自动保存持久化、取消可废弃）；查看态直接落库（收尾可撤销）。
   * flat 卡追加为尾部附件，有序图文卡追加为末尾图片块。
   */
  const addImagesToCard = (images: PastedImage[]) => {
    const current = noteRef.current;
    if (!previewIsEditable(current)) return;
    const editingNow = editSessionRef.current.editing;
    if (hasOrderedRichLayout(current.contentBlocks) && current.contentBlocks) {
      const baseBlocks = editingNow
        ? draftContentBlocksRef.current
        : current.contentBlocks;
      const existing = new Set(
        baseBlocks.flatMap((b) => (b.type === "image" ? [b.file] : []))
      );
      const fresh = images.filter((i) => !existing.has(i.file));
      if (!fresh.length) {
        tip("duplicate", "");
        return;
      }
      const appended: NoteContentBlock[] = [
        ...baseBlocks,
        ...fresh.map((i) => ({
          type: "image" as const,
          file: i.file,
          width: i.width,
          height: i.height,
        })),
      ];
      if (editingNow) {
        fresh.forEach((i) => sessionPastedImagesRef.current.add(i.file));
        draftContentBlocksRef.current = appended;
        setDraftContentBlocks(appended);
        return;
      }
      void emitTo("main", "toskr://note-edit", {
        format: "blocks",
        id: current.id,
        contentBlocks: appended,
        dataGeneration: current.dataGeneration,
        origin: { contentBlocks: current.contentBlocks },
      } satisfies NoteEditPayload);
      const next = refreshPreviewPayload(
        {
          ...current,
          contentBlocks: appended,
          images: [...current.images, ...fresh.map((i) => i.file)],
        },
        textFromContentBlocks(appended)
      );
      setNote(next.payload);
      noteRef.current = next.payload;
      draftContentBlocksRef.current = appended;
      setDraftContentBlocks(appended);
      draftRef.current = next.payload.text;
      setDraftEmpty(!next.payload.text.trim());
      draftImagesRef.current = next.payload.images;
      setDraftImages(next.payload.images);
      return;
    }
    const baseImages = editingNow ? draftImagesRef.current : current.images;
    const fresh = images.map((i) => i.file).filter((f) => !baseImages.includes(f));
    if (!fresh.length) {
      tip("duplicate", "");
      return;
    }
    const nextImages = [...baseImages, ...fresh];
    if (editingNow) {
      const textarea = textareaRef.current;
      if (textarea) {
        checkpointTextEdit(
          textEditHistoryRef.current,
          snapshotTextarea(textarea, baseImages)
        );
      }
      fresh.forEach((f) => sessionPastedImagesRef.current.add(f));
      draftImagesRef.current = nextImages;
      setDraftImages(nextImages);
      return;
    }
    void emitTo("main", "toskr://note-edit", {
      format: "flat",
      id: current.id,
      text: current.text,
      images: nextImages,
      dataGeneration: current.dataGeneration,
      origin: { text: current.text, images: current.images },
    } satisfies NoteEditPayload);
    const next = refreshPreviewPayload({ ...current, images: nextImages }, current.text);
    setNote(next.payload);
    noteRef.current = next.payload;
    draftRef.current = next.payload.text;
    setDraftEmpty(!next.payload.text.trim());
    draftImagesRef.current = nextImages;
    setDraftImages(nextImages);
  };

  /** 图片导入公共壳：等待期间换卡/换编辑会话则废弃刚入库的文件。 */
  const importAndAdd = async (
    fetchImages: () => Promise<PastedImage[]>,
    emptyTip: string
  ) => {
    const before = noteRef.current;
    if (!previewIsEditable(before)) return;
    const sessionToken = editSessionTokenRef.current;
    try {
      const images = await fetchImages();
      if (!images.length) {
        tip("info", emptyTip);
        return;
      }
      const current = noteRef.current;
      if (
        current?.id !== before.id ||
        (editSessionRef.current.editing &&
          sessionToken !== editSessionTokenRef.current)
      ) {
        discardDraftImages([], images.map((i) => i.file), before.dataGeneration);
        return;
      }
      addImagesToCard(images);
    } catch (error) {
      tip("warn", `图片导入失败：${error}`);
    }
  };

  /** 从系统剪贴板粘贴图片（位图或 Finder 复制的本地图片文件，可多张）。 */
  const pasteImage = () =>
    importAndAdd(() => api.pasteImagesFromClipboard(), "剪贴板里没有可用图片");

  /** 拖入的本地文件：筛图片扩展名后入库追加。 */
  const importDroppedImages = (paths: string[]) => {
    const files = imageFilePaths(paths);
    if (!files.length) {
      tip("info", "仅支持图片文件");
      return;
    }
    void importAndAdd(() => api.importImageFiles(files), "没有可导入的图片");
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = [...event.clipboardData.items];
    const hasImage = items.some(
      (item) => item.type.startsWith("image/") || item.kind === "file"
    );
    const textEmpty = !event.clipboardData.getData("text/plain").trim();
    if (hasImage || textEmpty) {
      event.preventDefault();
      void pasteImage();
    }
  };

  const syncTextareaSelection = (textarea: HTMLTextAreaElement) => {
    const selection = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
    setTextSelection(selection.start === selection.end ? null : selection);
  };

  // —— 选词模式：Intl.Segmenter 分词（旧 WebKit 退回空白/标点粗分） ——
  const noteText = note?.text ?? "";
  const pickSegments = useMemo(() => {
    if (!pickMode || !noteText) return [];
    const out: PickSegment[] = [];
    if (pickGranularity === "paragraph") {
      // 段粒度：按换行切分；空行归入分隔符，可选段保留段内换行
      let cursor = 0;
      for (const part of noteText.split(/(\n+)/)) {
        if (!part) continue;
        out.push({
          text: part,
          start: cursor,
          end: cursor + part.length,
          wordLike: !/^\n+$/.test(part) && !!part.trim(),
        });
        cursor += part.length;
      }
      return out;
    }
    if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
      const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
      for (const item of segmenter.segment(noteText)) {
        out.push({
          text: item.segment,
          start: item.index,
          end: item.index + item.segment.length,
          wordLike: !!item.isWordLike,
        });
      }
      return out;
    }
    let cursor = 0;
    for (const part of noteText.split(/([\s，。、；;,.!？?：:（）()[\]{}"'「」]+)/)) {
      if (!part) continue;
      out.push({
        text: part,
        start: cursor,
        end: cursor + part.length,
        wordLike: !/^[\s，。、；;,.!？?：:（）()[\]{}"'「」]+$/.test(part),
      });
      cursor += part.length;
    }
    return out;
  }, [pickMode, pickGranularity, noteText]);

  /**
   * 图文卡的选词布局：键帽按文字块回到各自图片之间，图文顺序不被打散；
   * 非图文卡返回 null，走原来的整段平铺。
   */
  const pickBlocks = useMemo(() => {
    const blocks = note?.contentBlocks;
    if (!pickMode || !blocks || !hasOrderedRichLayout(blocks)) return null;
    // 区间是相对块投影算的，正文却来自 payload.text。两者本该同源（Store 一律
    // 走 projectNoteContent），万一不是就退回平铺——宁可图片不内联，也不能让
    // 选中的词和实际发出的片段错位
    if (textFromContentBlocks(blocks) !== noteText) return null;
    const rangeByBlock = new Map(
      textBlockRanges(blocks).map((range) => [range.blockIndex, range])
    );
    let imageIndex = 0;
    return blocks.map((block, blockIndex) => {
      if (block.type === "image") {
        return {
          kind: "image" as const,
          blockIndex,
          block,
          imageIndex: imageIndex++,
        };
      }
      const range = rangeByBlock.get(blockIndex);
      return {
        kind: "text" as const,
        blockIndex,
        // 保留全局下标：点选驱动的 pick.anchor/focus 是 pickSegments 的索引
        segments: pickSegments.flatMap((segment, index) =>
          range && segment.start >= range.start && segment.end <= range.end
            ? [{ segment, index }]
            : []
        ),
      };
    });
  }, [note?.contentBlocks, noteText, pickMode, pickSegments]);

  const pickImageFiles = useMemo(
    () =>
      (note?.contentBlocks ?? []).flatMap((block) =>
        block.type === "image" ? [block.file] : []
      ),
    [note?.contentBlocks]
  );

  /** 键帽/分隔符单元；index 必须是 pickSegments 的全局下标。 */
  const renderPickSegment = (segment: PickSegment, index: number) => {
    const inRange =
      !!pick &&
      index >= Math.min(pick.anchor, pick.focus) &&
      index <= Math.max(pick.anchor, pick.focus);
    if (!segment.wordLike) {
      // 段粒度下换行分隔符不渲染（段块自带间距），词粒度保留原文标点
      if (pickGranularity === "paragraph") return null;
      return (
        <span
          key={`${segment.start}-${index}`}
          className={cn("text-muted-foreground", inRange && "text-primary")}
        >
          {segment.text}
        </span>
      );
    }
    return (
      <button
        key={`${segment.start}-${index}`}
        type="button"
        data-pick-selected={inRange || undefined}
        onClick={() => onPickToken(index)}
        className={cn(
          // token-exception: 键帽方块（用户选定模板 B）——底边厚度/按压位移/
          // 内高光为立体质感所需的一次性物理值，主题色仍走 token
          "rounded-[7px] border border-border/50 bg-muted font-[inherit] text-inherit outline-none",
          "shadow-[0_2.5px_0_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)]",
          "transition-[transform,box-shadow,background-color] duration-75",
          "hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          "active:translate-y-[1.5px] active:shadow-[0_1px_0_rgba(0,0,0,0.35)]",
          pickGranularity === "paragraph"
            ? "my-1 block w-full whitespace-pre-wrap px-2.5 py-1.5 text-left"
            : "mx-[3px] my-[2px] inline px-[7px] py-px",
          inRange &&
            "translate-y-[1.5px] border-primary/60 bg-primary text-primary-foreground shadow-[0_1px_0_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.3)] hover:brightness-105"
        )}
      >
        {segment.text}
      </button>
    );
  };

  const onPickToken = (index: number) => {
    setPick((previous) => {
      if (!previous) return { anchor: index, focus: index };
      if (previous.anchor === index && previous.focus === index) return null;
      return { anchor: previous.anchor, focus: index };
    });
  };

  useEffect(() => {
    if (!pickMode) return;
    if (!pick || !pickSegments.length) {
      setTextSelection(null);
      return;
    }
    const low = Math.min(pick.anchor, pick.focus);
    const high = Math.max(pick.anchor, pick.focus);
    const start = pickSegments[low]?.start;
    const end = pickSegments[high]?.end;
    if (start === undefined || end === undefined) {
      setPick(null);
      return;
    }
    setTextSelection({ start, end });
  }, [pick, pickMode, pickSegments]);

  const exitPickMode = () => {
    setPickMode(false);
    setPick(null);
    setTextSelection(null);
  };

  const enterPickMode = () => {
    setPickMode(true);
    setPick(null);
    setTextSelection(null);
  };

  // W 键切换选词模式（非编辑态；条件与工具条按钮一致）。
  // WKWebView 点击按钮不给焦点，快捷键一律窗口级 keydown，不赌焦点。
  useEffect(() => {
    if (editing) return;
    const onPickModeKey = (event: KeyboardEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.key.toLowerCase() !== "w"
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const current = noteRef.current;
      if (
        !current ||
        current.codeLang ||
        (current.kind === "link" && !!current.url)
      ) {
        return;
      }
      event.preventDefault();
      if (pickMode) exitPickMode();
      else enterPickMode();
    };
    window.addEventListener("keydown", onPickModeKey);
    return () => window.removeEventListener("keydown", onPickModeKey);
  }, [editing, pickMode]);

  const addSelectionToAliasDictionary = (originalText: string, category: string) => {
    // 词典写入必须在主面板原子取号，这里只发语义事件；HUD 回执全局可见
    requestAliasQuickAdd({ originalText, category });
    setPick(null);
    setTextSelection(null);
  };

  const syncPreviewSelection = () => {
    if (pickMode) return;
    if (
      editing ||
      !note ||
      note.codeLang ||
      note.kind === "link" ||
      hasOrderedRichLayout(note.contentBlocks)
    ) return;
    const root = previewContentRef.current;
    const domSelection = window.getSelection();
    if (!root || !domSelection || domSelection.isCollapsed || !domSelection.rangeCount) {
      setTextSelection(null);
      pendingSelectionRef.current = null;
      return;
    }
    const range = domSelection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setTextSelection(null);
      pendingSelectionRef.current = null;
      return;
    }
    const full = document.createRange();
    full.selectNodeContents(root);
    const prefix = full.cloneRange();
    prefix.setEnd(range.startContainer, range.startOffset);
    const visibleText = full.toString();
    const start = prefix.toString().length;
    const mapped = resolveSourceSelection(note.text, visibleText, {
      start,
      end: start + range.toString().length,
    });
    setTextSelection(mapped);
    pendingSelectionRef.current = mapped;
  };
  syncPreviewSelectionRef.current = syncPreviewSelection;

  const applySelectionEdit = (edit: SelectionEdit) => {
    if (!previewIsEditable(note) || hasOrderedRichLayout(note.contentBlocks)) {
      return;
    }
    setTextSelection(edit.selection);
    pendingSelectionRef.current = edit.selection;
    if (!editing) {
      // 先以旧正文挂载 textarea，再走原生命令应用修改，才能让 ⌘Z 回到旧正文。
      pendingTextEditRef.current = edit;
      setEditing(true);
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) return;
    checkpointTextEdit(
      textEditHistoryRef.current,
      snapshotTextarea(textarea, draftImagesRef.current)
    );
    applyTextareaEdit(textarea, edit);
    draftRef.current = edit.text;
    setDraftEmpty(!edit.text.trim());
    pendingSelectionRef.current = null;
  };

  const copy = async () => {
    if (!note) return;
    try {
      const richBlocks = !editing && hasOrderedRichLayout(note.contentBlocks)
        ? note.contentBlocks
        : null;
      if (richBlocks) {
        await api.copyRichClipboard(
          richBlocks.map((block) =>
            block.type === "text"
              ? { kind: "text" as const, text: block.text }
              : {
                  kind: "image" as const,
                  file: block.file,
                  ...(block.alt ? { alt: block.alt } : {}),
                }
          )
        );
        tip("ok", "已复制图文");
      } else {
        await api.copyText(editing ? draftRef.current : note.text);
        tip("ok", "已复制");
      }
    } catch (e) {
      tip("warn", `复制失败：${e}`);
    }
  };

  const send = () => {
    if (!previewIsEditable(note)) return;
    if (!winPinned) close();
    void emitTo("main", "toskr://note-send", {
      id: note.id,
      dataGeneration: note.dataGeneration,
    });
  };

  // 片段发送：只发选中文字（选词/选段驱动），仍以本卡为来源；发完关窗与整卡发送一致
  const sendSelection = (fragment: string) => {
    if (!note || !fragment.trim()) return;
    if (!winPinned) close();
    void emitTo("main", "toskr://note-send", {
      id: note.id,
      dataGeneration: note.dataGeneration,
      text: fragment,
    });
  };

  const copySelection = (fragment: string) => {
    if (!fragment) return;
    void api
      .copyText(fragment)
      .then(() => tip("ok", "已复制选中片段"))
      .catch((e) => tip("warn", `复制失败：${e}`));
  };

  // 文本编辑态由本窗口接管撤销/重做：连续输入按 1 秒内同类输入合并，
  // 工具栏格式化是独立一步；不再落到主面板的卡片级撤销。
  useEffect(() => {
    if (!editing) return;
    const onHistoryKey = (event: KeyboardEvent) => {
      if (
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.toLowerCase() !== "z"
      ) {
        return;
      }
      const textarea = textareaRef.current;
      if (
        !textarea ||
        event.target !== textarea ||
        event.isComposing ||
        composingRef.current
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const history = textEditHistoryRef.current;
      const current = snapshotTextarea(textarea, draftImagesRef.current);
      const target = event.shiftKey ? history.redo.pop() : history.undo.pop();
      if (!target) return;

      if (event.shiftKey) {
        history.undo.push(current);
      } else {
        history.redo.push(current);
      }
      trimTextEditHistory(history);
      history.group = null;
      applyTextareaEdit(textarea, target);
      draftRef.current = target.text;
      draftImagesRef.current = target.images;
      setDraftImages(target.images);
      setDraftEmpty(!target.text.trim());
      setTextSelection(
        target.selection.start === target.selection.end ? null : target.selection
      );
      pendingSelectionRef.current = null;
    };
    window.addEventListener("keydown", onHistoryKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onHistoryKey, { capture: true });
  }, [editing]);

  // 窗口级 Esc / Space 关闭（Quick Look 心智：空格查看、再按空格收起）。
  // 编辑态：Esc 由 textarea 截获为退出编辑，Space 正常输入不关窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc 逐层退：选词有选中时先撤选（关联 textSelection 由既有 effect 清），
      // 再按才关窗——选错一个词不该连详情窗一起丢掉。
      // 工具条自己的浮层（链接/词典/格式）在 capture 阶段已先吃掉 Esc
      if (e.key === "Escape" && !editing && pick) {
        e.preventDefault();
        setPick(null);
        return;
      }
      // 分词（选词）模式本身也是一层：先退分词状态，再按 Esc 才关窗
      if (e.key === "Escape" && !editing && pickMode) {
        e.preventDefault();
        exitPickMode();
        return;
      }
      // 查看态 ⌘Z：撤销最近的可撤销动作（编辑保存/图片添加等，与 HUD「撤销」同路）
      if (
        e.metaKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        e.key.toLowerCase() === "z" &&
        !editing
      ) {
        e.preventDefault();
        void emitTo("main", RUN_PENDING_UNDO_EVENT, {}).catch(() => {});
        return;
      }
      // 查看态 ⌘V：把剪贴板图片（位图/本地文件）直接追加进当前卡
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "v" &&
        !editing &&
        previewIsEditable(noteRef.current)
      ) {
        e.preventDefault();
        void pasteImage();
        return;
      }
      // 编辑态下焦点不在 textarea（如 Markdown 预览）时的 Esc：先退预览，
      // 再退编辑（自动保存语义保留内容），不再直接关窗丢会话
      if (e.key === "Escape" && editing) {
        e.preventDefault();
        if (editPreviewOn) setEditPreviewOn(false);
        else exitEditing();
        return;
      }
      if (e.key === "Escape" || (e.key === " " && !editing)) {
        e.preventDefault();
        const current = editSessionRef.current;
        if (current.editing) {
          editSessionTokenRef.current += 1;
          discardDraftImages(current.original, [
            ...sessionPastedImagesRef.current,
          ]);
          sessionPastedImagesRef.current.clear();
        }
        releaseEditorSession(noteRef.current);
        void getCurrentWebviewWindow().hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // pick/pickMode 必须在依赖里：漏了会让 handler 闭包读到旧状态，退层后
    // 第二次 Esc 又被当成"还在上一层"而关不掉窗
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, pick, pickMode, editPreviewOn]);

  if (!note) {
    // 内容未达的兜底空态：仍给关闭按钮 + 可拖动，不至于出现关不掉的白框
    return (
      <DetailWindowFrame surfaceClassName="items-center justify-center bg-background">
        <DataReadOnlyGuard />
        <button
          aria-label="关闭"
          onClick={close}
          className="absolute right-2 top-2 rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          <X className="size-3.5" />
        </button>
        <span className="text-body text-muted-foreground">加载中…</span>
      </DetailWindowFrame>
    );
  }

  const isLink = note.kind === "link" && !!note.url;
  const orderedRich = hasOrderedRichLayout(note.contentBlocks);
  const writable = previewIsEditable(note);
  const editable = writable;
  const flatEditable = writable && !orderedRich;
  const isMd = !note.codeLang && !isLink && looksLikeMarkdown(note.text);
  const s = stats(note.text);
  // 编辑/选词/标签输入期间 chrome 常显（有操作要落地）；其余靠活跃度唤出
  const chromeVisible = chromeOn || editing || pickMode || tagDraft !== null;
  // 选区工具条一露面，页脚的「发送」就和它的「发送选中」同屏了，两个发送必须
  // 一眼分辨发的是什么——此时页脚改口「发送整卡」，与「发送选中」动宾对仗
  const selectionToolbarOpen =
    (flatEditable || pickMode) && !!textSelection && !note.codeLang && !isLink;
  const shownImages = orderedRich ? [] : editing ? draftImages : note.images;
  const imagePreviewSource = writable && !editing
    ? {
        id: note.id,
        text: note.text,
        dataGeneration: note.dataGeneration,
      }
    : undefined;
  const imageEditContext: ImagePreviewEditContext | undefined =
    writable && editing
      ? {
          kind: "note",
          noteId: note.id,
          dataGeneration: note.dataGeneration,
        }
      : undefined;
  /**
   * 编辑器里的图片可能刚粘贴、尚未等到 2s 自动保存。先把当前草稿按同一
   * autosave 协议推给主窗口，再开放图片编辑，保证 owner 的来源 CAS 可命中。
   */
  const openEditingImage = async (files: string[], index: number) => {
    const current = noteRef.current;
    if (!editing || !previewIsEditable(current)) {
      await api.quickLook(files, index, imagePreviewSource, imageEditContext);
      return;
    }
    const session = autosaveSessionRef.current;
    try {
      if (hasOrderedRichLayout(current.contentBlocks) && current.contentBlocks) {
        const contentBlocks = normalizeNoteContentBlocks(
          draftContentBlocksRef.current
        );
        const applied = await emitNoteEditWithAck({
          format: "blocks",
          id: current.id,
          contentBlocks,
          dataGeneration: current.dataGeneration,
          autosave: true,
        } satisfies NoteEditPayload);
        if (!applied) {
          tip("warn", "图片编辑未打开：当前草稿尚未同步");
          return;
        }
        if (session) session.persistedBlocksJson = JSON.stringify(contentBlocks);
      } else {
        const text = draftRef.current;
        const images = [...draftImagesRef.current];
        const applied = await emitNoteEditWithAck({
          format: "flat",
          id: current.id,
          text,
          images,
          dataGeneration: current.dataGeneration,
          autosave: true,
        } satisfies NoteEditPayload);
        if (!applied) {
          tip("warn", "图片编辑未打开：当前草稿尚未同步");
          return;
        }
        if (session) {
          session.persistedText = text;
          session.persistedImages = images;
        }
      }
      await api.quickLook(files, index, undefined, {
        kind: "note",
        noteId: current.id,
        dataGeneration: current.dataGeneration,
      });
    } catch {
      tip("warn", "图片编辑未打开，当前草稿仍保留");
    }
  };
  // 与来源卡片通栏同色：主面板决议的分组色/中性灰优先，应用主色兜底。
  // 无界剧场后该色只保留两处：顶部晕光 + 阅读进度线（A×E 用户选定）
  const accent = note.headerColor ?? icon?.color ?? "#7c8494";
  const glowBackground = `linear-gradient(180deg, color-mix(in srgb, ${accent} 26%, transparent), transparent 80%)`;

  return (
    <DetailWindowFrame
      surfaceClassName={cn(
        "select-none text-foreground",
        // 毛玻璃开启时半透明膜层透出系统模糊（与主面板同款材质）；关闭退回不透明。
        // 60%：用户 2026-08-27 要求比首版（75%）更通透
        glassOn ? "bg-background/60" : "bg-background"
      )}
    >
      <DataReadOnlyGuard />
      {dropActive && (
        // 拖拽悬停提示：pointer-events-none 不拦 Tauri 层的 drop 事件
        <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-primary/5">
          <span className="rounded-md bg-background/95 px-3 py-1.5 text-body font-medium text-foreground shadow-sm">
            松开以添加图片
          </span>
        </div>
      )}
      {/* ——— 无界剧场（A×E）：零标题栏。常驻元素只有顶部晕光；信息条/操作坞随 chromeVisible 贴缘唤出 ——— */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-32"
        style={{ background: glowBackground }}
      />
      {/* 无标题栏后的拖动区：顶部 40px 皆可拖窗（正文首行从其下开始） */}
      <div
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-20 h-10 cursor-grab active:cursor-grabbing"
      />
      <div
        // 容器也要标拖动区：Tauri 判定只看点击目标自身（不冒泡），唤出态它
        // 盖在下方拖动条上，不标的话顶部只剩标题文字一小条能拖窗
        data-tauri-drag-region
        className={cn(
          "absolute inset-x-0 top-0 z-30 flex cursor-grab items-center gap-2 px-3 py-2 active:cursor-grabbing",
          "transition-[opacity,transform] duration-(--duration-overlay) ease-(--ease-standard) motion-reduce:transition-none",
          chromeVisible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-1 opacity-0"
        )}
      >
        <MacTrafficLights onClose={close} />
        {editing && (
          // 编辑态指示：一枚呼吸主色点 + 小字（类型徽标已按用户要求移除）
          <span className="flex shrink-0 items-center gap-1.5 text-micro font-medium text-primary">
            <span
              aria-hidden
              className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px_1px_var(--primary)]"
            />
            编辑中
          </span>
        )}
        <p
          data-tauri-drag-region
          className="min-w-0 flex-1 truncate text-micro text-muted-foreground"
          title={`${s.chars} 字符 · ${s.words} 词 · ${s.lines} 行`}
        >
          {note.title && (
            <span className="font-medium text-foreground">{note.title} · </span>
          )}
          {note.subtitle ??
            [
              note.sourceApp ? `来自 ${note.sourceApp}` : "笔记",
              note.createdAt ? `创建 ${timeAgo(note.createdAt)}` : null,
              note.updatedAt && note.updatedAt > (note.createdAt ?? 0)
                ? `改于 ${timeAgo(note.updatedAt)}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          {` · ${s.chars} 字`}
        </p>
        {icon && <img src={icon.url} alt="" className="size-5 rounded-[5px]" />}
        <IconButton
          label={winPinned ? "取消固定（发送后恢复自动关窗）" : "固定窗口：发送后保持打开"}
          size="xs"
          pressed={winPinned}
          onClick={() => setWinPinned((value) => !value)}
        >
          <Pin className="size-3.5" fill={winPinned ? "currentColor" : "none"} />
        </IconButton>
      </div>
      {/* 标签行：chips 可摘除 + 内联新增；写回主面板持久化（详情窗不直接写库）。
          无界剧场后是随 chrome 唤出的浮层（tagDraft 输入期间 chromeVisible 兜底常显） */}
      {writable && (
        <div
          data-tauri-drag-region
          className={cn(
            "absolute inset-x-0 top-9 z-30 flex flex-wrap items-center gap-1 px-3 py-1",
            "transition-[opacity,transform] duration-(--duration-overlay) ease-(--ease-standard) motion-reduce:transition-none",
            chromeVisible
              ? "translate-y-0 opacity-100"
              : "pointer-events-none -translate-y-1 opacity-0"
          )}
        >
          {(note.tags ?? []).map((tag) => (
            <span
              key={tag}
              className="group/tag inline-flex items-center gap-0.5 rounded-full bg-black/5 px-1.5 py-0.5 text-label text-muted-foreground dark:bg-white/10"
            >
              #{tag}
              <button
                aria-label={`移除标签 ${tag}`}
                onClick={() => removeTag(tag)}
                className="rounded-full p-px opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/tag:opacity-100"
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}
          {tagDraft === null ? (
            (note.tags?.length ?? 0) < NOTE_TAG_MAX_COUNT && (
              <button
                onClick={() => setTagDraft("")}
                className="rounded-full px-1.5 py-0.5 text-label text-muted-foreground/70 outline-none hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10"
              >
                ＋ 标签
              </button>
            )
          ) : (
            <input
              ref={tagInputRef}
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitTagDraft();
                else if (e.key === "Escape") setTagDraft(null);
              }}
              onBlur={() => {
                if (!tagDraft?.trim()) setTagDraft(null);
              }}
              placeholder="标签名，回车添加"
              className="w-28 bg-transparent text-label outline-none placeholder:text-muted-foreground/50"
            />
          )}
        </div>
      )}

      {/* 正文：预览（Markdown 渲染 / 代码高亮 / 原文）或编辑；双击进入编辑 */}
      <div ref={contentFrameRef} className="relative min-h-0 flex-1">
        <motion.div
          key={gen}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={springSnappy}
          ref={bodyRef}
          data-detail-font
          style={{ "--detail-font-size": `${fontSize}px` } as React.CSSProperties}
          // 编辑态一圈内嵌描边 + 浅蓝底（用户指定保留旧样式）；上下留白给
          // 贴缘 chrome 让位（可编辑卡多让 16px：标签行浮在 top-9）
          className={cn(
            "h-full select-text overflow-y-auto px-5 pb-16",
            writable ? "pt-16" : "pt-12",
            editing && "bg-primary/[0.04] ring-1 ring-inset ring-primary/25"
          )}
          onDoubleClick={() => {
            if (editable && !editing) setEditing(true);
          }}
        >
          {editing && orderedRich && note.contentBlocks ? (
            <RichNoteTextEditor
              key={note.id}
              blocks={draftContentBlocks}
              previewSource={imagePreviewSource}
              editContext={imageEditContext}
              onOpenImage={(files, index) => {
                void openEditingImage(files, index);
              }}
              onChange={(blocks) => {
                draftContentBlocksRef.current = blocks;
                setDraftContentBlocks(blocks);
              }}
              onSave={save}
              onCancel={exitEditing}
            />
          ) : editing ? (
            <>
            <textarea
              ref={textareaRef}
              // 保持 DOM 原生编辑历史；受控 value 每次重写会把连续输入拆成逐字撤销。
              defaultValue={note.text}
              onBeforeInput={(event) => {
                if (composingRef.current) return;
                if (skipNextBeforeInputRef.current) {
                  skipNextBeforeInputRef.current = false;
                  return;
                }
                const native = event.nativeEvent as InputEvent;
                const kind = inputEditGroup(
                  native.inputType || (native.data !== null ? "insertText" : "")
                );
                beginTextEditGroup(
                  textEditHistoryRef.current,
                  snapshotTextarea(event.currentTarget, draftImagesRef.current),
                  kind,
                  performance.now()
                );
              }}
              onCompositionStart={(event) => {
                if (composingRef.current) return;
                composingRef.current = true;
                checkpointTextEdit(
                  textEditHistoryRef.current,
                  snapshotTextarea(event.currentTarget, draftImagesRef.current)
                );
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
                textEditHistoryRef.current.group = null;
                // WebKit 可能在 compositionend 后补一条 insertFromComposition。
                skipNextBeforeInputRef.current = true;
                window.setTimeout(() => {
                  skipNextBeforeInputRef.current = false;
                }, 0);
              }}
              onChange={(event) => {
                draftRef.current = event.target.value;
                setDraftEmpty(!event.target.value.trim());
                syncTextareaSelection(event.currentTarget);
              }}
              onSelect={(event) => syncTextareaSelection(event.currentTarget)}
              onPaste={handlePaste}
              onPointerDown={() => {
                textEditHistoryRef.current.group = null;
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.nativeEvent.isComposing || composingRef.current) return;
                const keyGroup =
                  e.key === "Backspace"
                    ? ("backspace" as const)
                    : e.key === "Delete"
                      ? ("delete" as const)
                      : e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey
                        ? ("insert" as const)
                        : null;
                if (keyGroup) {
                  beginTextEditGroup(
                    textEditHistoryRef.current,
                    snapshotTextarea(e.currentTarget, draftImagesRef.current),
                    keyGroup,
                    performance.now()
                  );
                }
                if (
                  [
                    "ArrowLeft",
                    "ArrowRight",
                    "ArrowUp",
                    "ArrowDown",
                    "Home",
                    "End",
                    "PageUp",
                    "PageDown",
                  ].includes(e.key) ||
                  (e.metaKey && e.key.toLowerCase() === "a")
                ) {
                  textEditHistoryRef.current.group = null;
                }
                if (e.key === "Enter" && e.metaKey) {
                  e.preventDefault();
                  save();
                } else if (e.key === "Escape") {
                  // 自动保存语义：Esc 退出编辑保留内容（清空草稿才视为放弃还原）
                  exitEditing();
                }
              }}
              className={cn(
                "h-full min-h-40 w-full resize-none bg-transparent font-mono text-body leading-relaxed outline-none",
                // 预览时隐藏而非卸载：卸载会重置 defaultValue、丢原生撤销分组
                editPreviewOn && "hidden"
              )}
            />
            {editPreviewOn && (
              // 草稿的只读 Markdown 预览（核对清单可点选）；再按「原文」回编辑
              <div
                className="md-preview text-title leading-relaxed"
                onClick={onMarkdownClick}
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(draftRef.current),
                }}
              />
            )}
            </>
          ) : note.codeLang ? (
            <pre className="hljs whitespace-pre-wrap [overflow-wrap:anywhere] !bg-transparent font-mono text-body leading-relaxed">
              <code
                dangerouslySetInnerHTML={{ __html: codeHtml }}
              />
            </pre>
          ) : pickMode ? (
            // 选词优先于图文渲染：图文卡也要能选词，只是键帽按块回到图片之间
            <div
              ref={previewContentRef as React.RefObject<HTMLDivElement>}
              aria-label={
                pickGranularity === "paragraph"
                  ? "选段模式：点选段落，可再点另一段扩展范围"
                  : "选词模式：点选词语，可再点另一词扩展范围"
              }
              className={cn(
                "[overflow-wrap:anywhere] font-mono text-body",
                pickGranularity === "paragraph"
                  ? "leading-relaxed"
                  : "whitespace-pre-wrap leading-[2.2]"
              )}
            >
              {!pick && (
                // 只在还没选之前出现：选词模式最难懂的是「选完去哪操作」
                <p className="mb-2 text-micro text-muted-foreground">
                  {`点${pickGranularity === "paragraph" ? "段落" : "词块"}选中 · 再点另一${
                    pickGranularity === "paragraph" ? "段" : "块"
                  }扩展范围 · 选好后底部工具条可发送或复制`}
                </p>
              )}
              {pickBlocks
                ? pickBlocks.map((entry) =>
                    entry.kind === "image" ? (
                      <RichImageBlock
                        key={`image-${entry.blockIndex}-${entry.block.file}`}
                        block={entry.block}
                        files={pickImageFiles}
                        index={entry.imageIndex}
                        previewSource={imagePreviewSource}
                      />
                    ) : (
                      <p key={`text-${entry.blockIndex}`}>
                        {entry.segments.map(({ segment, index }) =>
                          renderPickSegment(segment, index)
                        )}
                      </p>
                    )
                  )
                : pickSegments.map((segment, index) =>
                    renderPickSegment(segment, index)
                  )}
            </div>
          ) : orderedRich && note.contentBlocks ? (
            <RichNoteContent
              blocks={note.contentBlocks}
              previewSource={imagePreviewSource}
            />
          ) : mdView ? (
            <div
              ref={previewContentRef as React.RefObject<HTMLDivElement>}
              className="md-preview text-title leading-relaxed"
              onClick={onMarkdownClick}
              dangerouslySetInnerHTML={{ __html: mdHtml }}
            />
          ) : (
            <pre
              ref={previewContentRef as React.RefObject<HTMLPreElement>}
              className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-body leading-relaxed"
            >
              {note.text}
            </pre>
          )}
        </motion.div>

        {selectionToolbarOpen && textSelection && (
          <TextSelectionToolbar
            text={editing ? draftRef.current : note.text}
            selection={textSelection}
            anchorStyle={toolbarAnchorStyle}
            onApply={applySelectionEdit}
            onAddAlias={editing ? undefined : addSelectionToAliasDictionary}
            onSendSelection={writable ? sendSelection : undefined}
            onCopySelection={copySelection}
            sendDisabledReason={targetReady ? null : targetBlockedMessage}
            readOnly={!flatEditable}
          />
        )}
      </div>

      {/* 图片附件缩略条（组合卡）：常显在正文与页脚之间，点击 Quick Look 原图，
          悬停 ⊗ 从卡片移除。移除本身回主面板执行（唯一持久化写入方），这里
          先本地摘掉该图，界面不等回程 */}
      {shownImages.length > 0 && (
        // mb-12 给底部操作坞让位：坞是浮层，不让位时盖住缩略图，悬停 ⊗ 点不到
        <div className="mb-12 flex shrink-0 gap-1.5 overflow-x-auto border-t border-black/5 px-3 py-2 dark:border-white/5">
          {shownImages.map((f, i) => (
            <AttachThumb
              key={f}
              file={f}
              onClick={() => {
                if (editing) {
                  void openEditingImage(shownImages, i);
                  return;
                }
                void api.quickLook(
                  shownImages,
                  i,
                  imagePreviewSource,
                  imageEditContext
                );
              }}
              onRemove={editable ? () => {
                if (editing) {
                  const current = draftImagesRef.current;
                  const textarea = textareaRef.current;
                  if (textarea) {
                    checkpointTextEdit(
                      textEditHistoryRef.current,
                      snapshotTextarea(textarea, current)
                    );
                  }
                  const next = current.filter((file) => file !== f);
                  draftImagesRef.current = next;
                  setDraftImages(next);
                  return;
                }
                void emitTo("main", "toskr://note-image-remove", {
                  id: note.id,
                  file: f,
                  dataGeneration: note.dataGeneration,
                });
                const rest = note.images.filter((x) => x !== f);
                // 图没了、文字也没了 → 主面板会把整张卡删掉，详情窗跟着关
                if (!rest.length && !note.text.trim()) {
                  close();
                  return;
                }
                setNote({ ...note, images: rest });
                draftImagesRef.current = rest;
                setDraftImages(rest);
              } : undefined}
            />
          ))}
        </div>
      )}

      {/* 底部操作坞（E）：贴缘唤出、语境切换（查看/编辑），发送键前置目标名 */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-30 flex items-center justify-center gap-1 px-4 pb-3 pt-10",
          "bg-gradient-to-t from-background/90 via-background/55 to-transparent",
          "transition-[opacity,transform] duration-(--duration-overlay) ease-(--ease-standard) motion-reduce:transition-none",
          chromeVisible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-1.5 opacity-0"
        )}
      >
        {editing ? (
          <>
            {!orderedRich && !note.codeLang && !isLink && (
              <DockOp
                active={editPreviewOn}
                onClick={() => setEditPreviewOn((v) => !v)}
              >
                {editPreviewOn ? "原文" : "渲染"}
              </DockOp>
            )}
            <IconButton label="粘贴图片（⌘V）" onClick={() => void pasteImage()}>
              <ImagePlus className="size-3.5" />
            </IconButton>
            <Button
              className="rounded-full px-5 shadow-(--shadow-card)"
              disabled={!orderedRich && draftEmpty && draftImages.length === 0}
              onClick={save}
            >
              <Check className="size-3" /> 保存
              {/* token-exception: 9px 为重塑前原始尺寸，用户指定还原 */}
              <Kbd inline className="text-[9px]">⌘⏎</Kbd>
            </Button>
          </>
        ) : (
          <>
            {!isLink && !note.codeLang && (
              <>
                <DockOp
                  active={pickMode}
                  title={
                    pickMode
                      ? "退出选词模式（W）"
                      : "选词模式：点选词/段，可发送或复制选中片段（W）"
                  }
                  onClick={() => {
                    if (pickMode) exitPickMode();
                    else enterPickMode();
                  }}
                >
                  选词
                </DockOp>
                {pickMode && (
                  <Segmented
                    ariaLabel="选取粒度"
                    size="xs"
                    value={pickGranularity}
                    options={[
                      { value: "word", label: "词" },
                      { value: "paragraph", label: "段" },
                    ]}
                    onChange={(value) => {
                      setPickGranularity(value);
                      setPick(null);
                      setTextSelection(null);
                    }}
                  />
                )}
              </>
            )}
            {!orderedRich && isMd && !pickMode && (
              <DockOp onClick={() => setMdView(!mdView)}>
                {mdView ? "原文" : "渲染"}
              </DockOp>
            )}
            {isLink && (
              <DockOp onClick={() => void api.openUrl(note.url!)}>打开链接</DockOp>
            )}
            <DockOp onClick={() => void copy()}>复制</DockOp>
            {editable && (
              <DockOp
                title={orderedRich ? "编辑文字（图片位置固定）" : undefined}
                onClick={() => setEditing(true)}
              >
                编辑
              </DockOp>
            )}
            {writable && (
              <>
                <p
                  id="text-preview-target-status"
                  role="status"
                  aria-live="polite"
                  className="sr-only"
                >
                  {targetBlockedMessage ?? ""}
                </p>
                <SimpleMenu
                  align="end"
                  side="top"
                  menuClassName="max-h-64 w-48 overflow-y-auto"
                  trigger={({ toggle }) => {
                    const openTargetMenu = () => {
                      void api
                        .listSendTargets()
                        .then((list) => {
                          setSendTargets(list);
                          toggle();
                        })
                        .catch(() => {});
                    };
                    return (
                      <Button
                        className={cn(
                          "rounded-full px-5 shadow-(--shadow-card)",
                          !targetReady && "opacity-60"
                        )}
                        aria-label={
                          targetReady
                            ? selectionToolbarOpen
                              ? "发送整卡到当前目标（不是选中片段）；长按换目标"
                              : "发送到当前目标；长按换目标"
                            : `目标不可用（点击换目标）：${targetBlockedMessage}`
                        }
                        aria-describedby={
                          targetReady ? undefined : "text-preview-target-status"
                        }
                        onPointerDown={() => {
                          sendLongPressFiredRef.current = false;
                          sendLongPressTimerRef.current = window.setTimeout(
                            () => {
                              sendLongPressFiredRef.current = true;
                              openTargetMenu();
                            },
                            450
                          );
                        }}
                        onPointerUp={() => {
                          if (sendLongPressTimerRef.current) {
                            window.clearTimeout(sendLongPressTimerRef.current);
                          }
                        }}
                        onPointerLeave={() => {
                          if (sendLongPressTimerRef.current) {
                            window.clearTimeout(sendLongPressTimerRef.current);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          openTargetMenu();
                        }}
                        onClick={() => {
                          // 长按已弹选单：这次抬起的 click 不当作发送
                          if (sendLongPressFiredRef.current) {
                            sendLongPressFiredRef.current = false;
                            return;
                          }
                          // 目标失效时点击直接弹目标选单，免去先点一次目标应用
                          if (!targetReady) {
                            openTargetMenu();
                            return;
                          }
                          send();
                        }}
                      >
                        <Send className="size-3" />{" "}
                        {selectionToolbarOpen
                          ? "发送整卡"
                          : targetAppName
                            ? `发送到 ${targetAppName}`
                            : "发送"}
                        {/* token-exception: 9px 为重塑前原始尺寸，用户指定还原 */}
                        <Kbd inline className="text-[9px]">⌘⏎</Kbd>
                      </Button>
                    );
                  }}
                >
                  {(close) => (
                    <>
                      <p className="px-2 py-1 text-micro font-medium text-muted-foreground">
                        发送到…
                      </p>
                      {sendTargets.map((t) => (
                        <SimpleMenuItem
                          key={t.pid}
                          onClick={() => {
                            close();
                            void api.adoptSendTarget(t.pid).then((snap) => {
                              if (!snap?.ready) {
                                tip("warn", "该应用暂不可作为发送目标");
                                return;
                              }
                              // 等 target 事件先落主面板 store 再发
                              window.setTimeout(() => send(), 60);
                            });
                          }}
                        >
                          <span className="truncate">{t.name}</span>
                        </SimpleMenuItem>
                      ))}
                    </>
                  )}
                </SimpleMenu>
              </>
            )}
          </>
        )}
      </div>
    </DetailWindowFrame>
  );
}
