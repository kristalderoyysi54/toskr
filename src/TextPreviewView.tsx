import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { motion } from "motion/react";
import {
  Check,
  Copy,
  ExternalLink,
  ImagePlus,
  Pencil,
  Send,
  X,
} from "lucide-react";

import { headerGradient } from "@/components/NoteCard";
import { DataReadOnlyGuard } from "@/components/DataReadOnlyGuard";
import { DetailWindowFrame } from "@/components/DetailWindowFrame";
import { stats } from "@/components/PreviewOverlay";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { TextSelectionToolbar } from "@/components/TextSelectionToolbar";
import type { NotePreviewPayload } from "@/lib/actions";
import { highlightCode, langLabel } from "@/lib/code";
import { NOTE_EDITOR_SESSION_RELEASE_EVENT } from "@/lib/editorSessionMedia";
import { useAppIcon } from "@/lib/icons";
import { useNoteThumb } from "@/lib/media";
import { looksLikeMarkdown, renderMarkdown } from "@/lib/markdown";
import { springSnappy } from "@/lib/motion";
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
  type TargetSnapshot,
} from "@/lib/tauri";
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
          "focus-visible:ring-2 focus-visible:ring-primary/50"
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
            "focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/50"
          )}
        >
          <X className="size-2.5" />
        </button>
      )}
    </div>
  );
}

/** 详情窗只上报本次编辑新增且放弃的文件；主窗口会再按全库引用过滤后删盘。 */
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

export default function TextPreviewView() {
  const [note, setNote] = useState<NotePreviewPayload | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftEmpty, setDraftEmpty] = useState(true);
  const [draftImages, setDraftImages] = useState<string[]>([]);
  const [mdView, setMdView] = useState(false);
  const [textSelection, setTextSelection] = useState<TextSelection | null>(null);
  // 每次唤起自增：窗口隐藏复用，重开也要重播内容浮现
  const [gen, setGen] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 正文由 textarea DOM 持有，避免每次按键的 React 回写切断原生撤销分组。
  const draftRef = useRef("");
  const draftImagesRef = useRef<string[]>([]);
  const sessionPastedImagesRef = useRef<Set<string>>(new Set());
  const editSessionTokenRef = useRef(0);
  const composingRef = useRef(false);
  const skipNextBeforeInputRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const previewContentRef = useRef<HTMLElement>(null);
  const pendingSelectionRef = useRef<TextSelection | null>(null);
  const pendingTextEditRef = useRef<SelectionEdit | null>(null);
  const pendingTextEditImagesRef = useRef<string[] | null>(null);
  const pendingTextEditBeforeRef = useRef<TextEditSnapshot | null>(null);
  const appliedInsertOperationsRef = useRef(new Map<string, number>());
  const noteRef = useRef<NotePreviewPayload | null>(null);
  const textEditHistoryRef = useRef<TextEditHistory>(freshTextEditHistory());
  const editSessionRef = useRef({
    original: [] as string[],
    editing: false,
    dataGeneration: undefined as number | undefined,
  });
  const icon = useAppIcon(note?.sourceBundle ?? undefined);
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

  useEffect(() => {
    const changed = listen<TargetSnapshot>(TARGET_CHANGED_EVENT, (event) => {
      applyTargetEvent(event.payload);
    });
    return () => {
      changed.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    const un = listen<NotePreviewPayload>("toskr://note-preview", (e) => {
      const p = e.payload;
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
      draftRef.current = p.text;
      setDraftEmpty(!p.text.trim());
      draftImagesRef.current = p.images;
      setDraftImages(p.images);
      setEditing(previewIsEditable(p) && p.edit);
      setMdView(!p.codeLang && p.kind !== "link" && looksLikeMarkdown(p.text));
      setTextSelection(null);
      pendingSelectionRef.current = null;
      pendingTextEditRef.current = null;
      pendingTextEditImagesRef.current = null;
      pendingTextEditBeforeRef.current = null;
      textEditHistoryRef.current = freshTextEditHistory();
      setGen((g) => g + 1);
      bodyRef.current?.scrollTo({ top: 0 });
      // 独立 WebView 只读同步当前 token；先注册 target event，让在途旧响应
      // 服从更新事件，但不能因打开详情窗轮换 Native token。
      void readTarget();
    });
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

  const close = () => {
    if (editing && note) {
      editSessionTokenRef.current += 1;
      discardDraftImages(
        note.images,
        [...sessionPastedImagesRef.current],
        note.dataGeneration
      );
      sessionPastedImagesRef.current.clear();
    }
    releaseEditorSession(note);
    void getCurrentWebviewWindow().hide();
  };

  const save = () => {
    if (!previewIsEditable(note)) return;
    const text = draftRef.current.trim();
    const images = draftImagesRef.current;
    if (!text && images.length === 0) {
      tip("warn", "笔记内容不能为空");
      return;
    }
    const imagesChanged =
      images.length !== note.images.length ||
      images.some((file, index) => file !== note.images[index]);
    const discardedImages = [
      ...new Set([...note.images, ...sessionPastedImagesRef.current]),
    ].filter((file) => !images.includes(file));
    editSessionTokenRef.current += 1;
    if (text !== note.text || imagesChanged) {
      const next = refreshPreviewPayload({ ...note, images }, text);
      void emitTo("main", "toskr://note-edit", {
        id: note.id,
        sessionId: note.sessionId,
        text: next.payload.text,
        images,
        discardedImages,
        dataGeneration: note.dataGeneration,
      });
      setNote(next.payload);
      noteRef.current = next.payload;
      draftRef.current = next.payload.text;
      setDraftEmpty(!next.payload.text.trim());
      setMdView(next.markdownView);
    } else {
      discardDraftImages(images, discardedImages, note.dataGeneration);
      releaseEditorSession(note);
    }
    sessionPastedImagesRef.current.clear();
    setTextSelection(null);
    textEditHistoryRef.current = freshTextEditHistory();
    setEditing(false);
  };

  /** 从系统剪贴板粘贴图片，先作为编辑草稿附件，保存时再写回主 store。 */
  const pasteImage = async () => {
    if (!previewIsEditable(note)) return;
    const sessionToken = editSessionTokenRef.current;
    try {
      const image = await api.pasteImageFromClipboard();
      if (!image) {
        tip("info", "剪贴板里没有可用图片");
        return;
      }
      if (sessionToken !== editSessionTokenRef.current) {
        discardDraftImages([], [image.file], note?.dataGeneration);
        return;
      }
      const current = draftImagesRef.current;
      if (current.includes(image.file)) return;
      const textarea = textareaRef.current;
      if (textarea) {
        checkpointTextEdit(
          textEditHistoryRef.current,
          snapshotTextarea(textarea, current)
        );
      }
      const next = [...current, image.file];
      sessionPastedImagesRef.current.add(image.file);
      draftImagesRef.current = next;
      setDraftImages(next);
    } catch (error) {
      tip("warn", `粘贴图片失败：${error}`);
    }
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

  const syncPreviewSelection = () => {
    if (editing || !note || note.codeLang || note.kind === "link") return;
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

  const applySelectionEdit = (edit: SelectionEdit) => {
    if (!previewIsEditable(note)) return;
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
      await api.copyText(editing ? draftRef.current : note.text);
      tip("ok", "已复制");
    } catch (e) {
      tip("warn", `复制失败：${e}`);
    }
  };

  const send = () => {
    if (!previewIsEditable(note)) return;
    close();
    void emitTo("main", "toskr://note-send", {
      id: note.id,
      dataGeneration: note.dataGeneration,
    });
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
  }, [editing]);

  if (!note) {
    // 内容未达的兜底空态：仍给关闭按钮 + 可拖动，不至于出现关不掉的白框
    return (
      <DetailWindowFrame surfaceClassName="items-center justify-center bg-background">
        <DataReadOnlyGuard />
        <button
          aria-label="关闭"
          onClick={close}
          className="absolute right-2 top-2 rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <X className="size-3.5" />
        </button>
        <span className="text-body text-muted-foreground">加载中…</span>
      </DetailWindowFrame>
    );
  }

  const isLink = note.kind === "link" && !!note.url;
  const editable = previewIsEditable(note);
  const isMd = !note.codeLang && !isLink && looksLikeMarkdown(note.text);
  const typeLabel = isLink
    ? "链接"
    : note.kind === "image"
      ? "图片"
    : note.codeLang
      ? langLabel(note.codeLang)
      : "文本";
  const s = stats(note.text);
  const shownImages = editing ? draftImages : note.images;
  const detailHeaderBackground = headerGradient(icon?.color ?? "#5b5b60");

  return (
    <DetailWindowFrame
      surfaceClassName="select-none bg-background text-foreground"
    >
      <DataReadOnlyGuard />
      {/* 标题栏：应用主色渐变（与卡顶同款）+ 顶缘内嵌高光（HUD 气泡同款
          玻璃质感）+ 与正文交界的一丝落影；可拖动窗口 */}
      <header
        data-tauri-drag-region
        className="relative z-10 flex h-11 shrink-0 cursor-grab items-center gap-2 px-3 shadow-[inset_0_1px_0_oklch(1_0_0/0.2),0_1px_3px_oklch(0_0_0/0.12)] active:cursor-grabbing"
        style={{ backgroundImage: detailHeaderBackground }}
      >
        <div data-tauri-drag-region className="min-w-0 flex-1 leading-tight">
          <p
            data-tauri-drag-region
            className="truncate text-body font-semibold text-white"
          >
            {note.title || typeLabel}
          </p>
          <p data-tauri-drag-region className="truncate text-micro text-white/70">
            {note.subtitle ?? (note.sourceApp ? `来自 ${note.sourceApp}` : "笔记")}
          </p>
        </div>
        {icon && <img src={icon.url} alt="" className="size-6 rounded-[5px]" />}
        <button
          aria-label="关闭"
          onClick={close}
          className="rounded-sm p-1 text-white/70 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <X className="size-3.5" />
        </button>
      </header>

      {/* 正文：预览（Markdown 渲染 / 代码高亮 / 原文）或编辑；双击进入编辑 */}
      <div className="relative min-h-0 flex-1">
        <motion.div
          key={gen}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={springSnappy}
          ref={bodyRef}
          className="h-full select-text overflow-y-auto p-4"
          onPointerUp={syncPreviewSelection}
          onDoubleClick={() => {
            if (editable && !editing) setEditing(true);
          }}
        >
          {editing ? (
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
                  editSessionTokenRef.current += 1;
                  discardDraftImages(note.images, [
                    ...sessionPastedImagesRef.current,
                  ]);
                  sessionPastedImagesRef.current.clear();
                  releaseEditorSession(note);
                  draftRef.current = note.text;
                  setDraftEmpty(!note.text.trim());
                  textEditHistoryRef.current = freshTextEditHistory();
                  draftImagesRef.current = note.images;
                  setDraftImages(note.images);
                  setTextSelection(null);
                  setEditing(false);
                }
              }}
              className="h-full min-h-40 w-full resize-none bg-transparent font-mono text-body leading-relaxed outline-none"
            />
          ) : note.codeLang ? (
            <pre className="hljs whitespace-pre-wrap [overflow-wrap:anywhere] !bg-transparent font-mono text-body leading-relaxed">
              <code
                dangerouslySetInnerHTML={{
                  __html: highlightCode(note.text, note.codeLang),
                }}
              />
            </pre>
          ) : mdView ? (
            <div
              ref={previewContentRef as React.RefObject<HTMLDivElement>}
              className="md-preview text-title leading-relaxed"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(note.text) }}
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

        {editable && textSelection && !note.codeLang && !isLink && (
          <TextSelectionToolbar
            text={editing ? draftRef.current : note.text}
            selection={textSelection}
            onApply={applySelectionEdit}
          />
        )}
      </div>

      {/* 图片附件缩略条（组合卡）：常显在正文与页脚之间，点击 Quick Look 原图，
          悬停 ⊗ 从卡片移除。移除本身回主面板执行（唯一持久化写入方），这里
          先本地摘掉该图，界面不等回程 */}
      {shownImages.length > 0 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-black/5 px-3 py-2 dark:border-white/5">
          {shownImages.map((f, i) => (
            <AttachThumb
              key={f}
              file={f}
              onClick={() => void api.quickLook(shownImages, i)}
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

      <footer className="flex items-center gap-1 border-t border-black/5 px-3 py-2 dark:border-white/5">
        <span className="text-micro tabular-nums text-muted-foreground">
          {`${s.chars} 字符 · ${s.words} 词 · ${s.lines} 行`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {editing ? (
            <>
              <IconButton label="粘贴图片（⌘V）" onClick={() => void pasteImage()}>
                <ImagePlus className="size-3.5" />
              </IconButton>
              <Button
                size="xs"
                disabled={draftEmpty && draftImages.length === 0}
                onClick={save}
              >
                <Check className="size-3" /> 保存
                {/* token-exception: 9px 为重塑前原始尺寸，用户指定还原 */}
                <Kbd inline className="text-[9px]">⌘⏎</Kbd>
              </Button>
            </>
          ) : (
            <>
              {isMd && (
                <button
                  onClick={() => setMdView(!mdView)}
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-micro text-muted-foreground outline-none",
                    "hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 dark:hover:bg-white/10"
                  )}
                >
                  {mdView ? "原文" : "渲染"}
                </button>
              )}
              {isLink && (
                <IconButton label="打开链接" onClick={() => void api.openUrl(note.url!)}>
                  <ExternalLink className="size-3.5" />
                </IconButton>
              )}
              {editable && (
                <IconButton label="编辑" onClick={() => setEditing(true)}>
                  <Pencil className="size-3.5" />
                </IconButton>
              )}
              <IconButton label="复制" onClick={() => void copy()}>
                <Copy className="size-3.5" />
              </IconButton>
              {editable && (
                <>
                  <p
                    id="text-preview-target-status"
                    role="status"
                    aria-live="polite"
                    className="sr-only"
                  >
                    {targetBlockedMessage ?? ""}
                  </p>
                  <Button
                    size="xs"
                    disabled={!targetReady}
                    aria-label={
                      targetReady
                        ? "发送到当前目标"
                        : `发送不可用：${targetBlockedMessage}`
                    }
                    aria-describedby={
                      targetReady ? undefined : "text-preview-target-status"
                    }
                    onClick={send}
                  >
                    <Send className="size-3" /> 发送
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </footer>
    </DetailWindowFrame>
  );
}
