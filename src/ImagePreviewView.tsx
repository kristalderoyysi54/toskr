import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { emitToMain as emitTo } from "@/lib/previewEvents";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { motion } from "motion/react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Pin,
  CircleHelp,
  Loader2,
  Redo2,
  Send,
  Shield,
  Sparkles,
  Undo2,
} from "lucide-react";

import {
  NOTE_EDIT_AUTOSAVE_INTERVAL_MS,
  type NoteEditPayload,
} from "@/lib/actions";
import { imageFilePaths } from "@/lib/imageFiles";
import { tip } from "@/lib/tip";
import {
  FIT_VIEW,
  wheelZoomFactor,
  zoomViewAround,
  type ZoomView,
} from "@/lib/imageZoom";
import { springSnappy } from "@/lib/motion";
import { DataReadOnlyGuard } from "@/components/DataReadOnlyGuard";
import { DetailWindowFrame } from "@/components/DetailWindowFrame";
import {
  ManualRedactionCanvas,
  RedactionStyleGlyph,
  type RedactionCandidate,
} from "@/components/ManualRedactionCanvas";
import { floatingSurface } from "@/components/ui/floating-surface";
import { focusRing } from "@/components/ui/focus-ring";
import { FIREWALL_CATEGORY_LABEL } from "@/lib/delivery/firewall";
import { Button } from "@/components/ui/button";
import { MacTrafficLights, PlatinumTrailingBoxes } from "@/components/ui/mac-close-button";
import { useColorScheme } from "@/lib/colorScheme";
import { IconButton } from "@/components/ui/icon-button";
import {
  DATA_ACTIVITY_EVENT,
  DATA_LOCATION_CHANGED_EVENT,
} from "@/lib/dataOperations";
import { DATA_CONTEXT_INVALIDATED_EVENT } from "@/lib/dataGeneration";
import {
  DRAFT_IMAGE_REPLACED_EVENT,
  IMAGE_EDIT_CANCEL_EVENT,
  IMAGE_EDIT_CANCEL_RESULT_EVENT,
  IMAGE_EDIT_REQUEST_EVENT,
  IMAGE_EDIT_RESULT_EVENT,
  NOTE_IMAGE_REPLACED_EVENT,
  REDACTION_BLACK,
  REDACTION_STYLE_OPTIONS,
  advanceNoteImageEditSequence,
  failedRegionNumbers,
  imageEditRequestId,
  loadRedactionStyle,
  sameRedactionStyle,
  saveRedactionStyle,
  type DraftImageReplacedPayload,
  type ImageEditCancelResultPayload,
  type ImageEditResultPayload,
  type ImageEditTarget,
  type ImagePreviewEditContext,
  type NoteImageReplacedPayload,
} from "@/lib/imageEditor";
import {
  api,
  TARGET_CHANGED_EVENT,
  type PastedImage,
  type RedactionRegion,
  type RedactionStyle,
  type TargetSnapshot,
} from "@/lib/tauri";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  applyTargetEvent,
  readTarget,
  targetBlockMessage,
  useTargetStore,
} from "@/store/targetStore";
// 事件监听回调里取调用时的语言，不必把 t 列入依赖重挂监听
import { t as translateNow } from "@/lib/i18n";

type RedactionHistory = {
  past: RedactionRegion[][];
  present: RedactionRegion[];
  future: RedactionRegion[][];
};


const freshRedactionHistory = (): RedactionHistory => ({
  past: [],
  present: [],
  future: [],
});

/**
 * 图片原尺寸预览窗（独立 webview，Paste 风格）：
 * 标题栏与图片区均可拖动窗口、可缩放；⊗ / Esc / Space 关闭（隐藏复用）。
 * 组合卡多图：←/→ 或两侧按钮翻看，标题与底栏显示第几张。
 * 滚轮以鼠标为锚缩放（0.2×–8×，1× 以下居中缩小）；放大后拖拽平移图片（≤1× 时拖拽仍是拖窗），
 * 双击 2× ⇄ 复位，翻页/重开自动回到适配。
 * 刻意不做失焦关闭——可拖动窗口的语义是「摆在一边对照看」。
 * 带笔记上下文（noteId）时底部显示文字备注条：查看 / 内联编辑，
 * ⌘⏎ 保存经 toskr://note-edit 回传主面板（主面板是唯一持久化写入方）。
 * 编辑态每 2s 静默自动保存；Esc/关窗/切换都保留内容，收尾气泡可撤销。
 */
export default function ImagePreviewView() {
  const t = useT();
  const [files, setFiles] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [loadedImage, setLoadedImage] = useState<{
    file: string;
    url: string;
    width: number;
    height: number;
  } | null>(null);
  // 每次唤起自增：窗口隐藏复用，重开同一张图也要重播入场动效
  const [gen, setGen] = useState(0);
  const [view, setView] = useState<ZoomView>(FIT_VIEW);
  const zoomAreaRef = useRef<HTMLDivElement>(null);
  const panDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  // 悬停窥视瞬态形态：鼠标穿透、不抢焦点 → 任何按钮/编辑条都点不到，
  // 渲染成纯图（无标题栏/翻页钮/底栏），窗即图
  const [transientPeek, setTransientPeek] = useState(false);
  // 笔记上下文（备注编辑；null = 无编辑条，纯看图）
  const [noteId, setNoteId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [dataGeneration, setDataGeneration] = useState<number | null>(null);
  const [editContext, setEditContext] = useState<ImagePreviewEditContext | null>(null);
  const [imageEditing, setImageEditing] = useState(false);
  const [redactionHistory, setRedactionHistory] = useState<RedactionHistory>(
    freshRedactionHistory
  );
  const redactionRegions = redactionHistory.present;
  // 识别是异步的：回来时用最新框列表判断「已被遮挡」
  const redactionRegionsRef = useRef(redactionRegions);
  redactionRegionsRef.current = redactionRegions;
  const [drawStyle, setDrawStyleState] = useState<RedactionStyle>(loadRedactionStyle);
  const [selectedRegion, setSelectedRegion] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<RedactionCandidate[]>([]);
  const [detecting, setDetecting] = useState(false);
  /** 复检未通过的框（0 起），任何改动后清除。 */
  const [failedRegions, setFailedRegions] = useState<number[]>([]);
  const [imageEditBusy, setImageEditBusy] = useState(false);
  const pendingImageEditRef = useRef<string | null>(null);
  const pendingImageEditCancelRef = useRef<string | null>(null);
  const imageEditTimeoutRef = useRef<number | null>(null);
  const imageEditTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreImageEditFocusRef = useRef(false);
  const supersededImageEditRequestsRef = useRef(new Set<string>());
  const noteImageEditSequencesRef = useRef(new Map<string, number>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 拖拽图片悬停提示（松开添加）
  const [dropActive, setDropActive] = useState(false);
  // 📌 固定窗口：发送后不自动关窗；主动关闭（X/Esc/空格）与数据失效关窗不受影响
  const [winPinned, setWinPinned] = useState(false);
  const platinum = useColorScheme() === "platinum";
  // 备注编辑镜像 + 会话账本：interval / 事件监听闭包只读 ref，不受旧 state 影响
  const captionRef = useRef({
    editing,
    noteId,
    draft,
    noteText,
    dataGeneration,
    files,
  });
  captionRef.current = { editing, noteId, draft, noteText, dataGeneration, files };
  const captionSessionRef = useRef<{ origin: string; lastSent: string } | null>(
    null
  );
  const editContextRef = useRef(editContext);
  editContextRef.current = editContext;
  const targetReady = useTargetStore(
    (state) => state.status === "ready" && !state.profileOverrideNeedsConfirmation
  );
  const targetBlockedMessage = useTargetStore((state) =>
    state.profileOverrideNeedsConfirmation
      ? t("原临时发送方案已暂停")
      : state.status === "ready"
        ? null
        : targetBlockMessage(state.status, state.reason)
  );

  const clearImageEditWatchdog = useCallback(() => {
    if (imageEditTimeoutRef.current !== null) {
      window.clearTimeout(imageEditTimeoutRef.current);
      imageEditTimeoutRef.current = null;
    }
  }, []);

  const detachPendingImageEdit = useCallback(() => {
    const requestId = pendingImageEditRef.current;
    if (!requestId) return;
    pendingImageEditRef.current = null;
    pendingImageEditCancelRef.current = null;
    clearImageEditWatchdog();
    void emitTo("main", IMAGE_EDIT_CANCEL_EVENT, { requestId }).catch(() => {});
  }, [clearImageEditWatchdog]);

  const requestPendingImageEditCancellation = useCallback(() => {
    const requestId = pendingImageEditRef.current;
    if (!requestId || pendingImageEditCancelRef.current === requestId) return;
    pendingImageEditCancelRef.current = requestId;
    clearImageEditWatchdog();
    void emitTo("main", IMAGE_EDIT_CANCEL_EVENT, { requestId }).catch(() => {
      if (pendingImageEditRef.current !== requestId) return;
      pendingImageEditCancelRef.current = null;
      tip("warn", translateNow("图片仍在处理中，请等待主面板结果"));
    });
  }, [clearImageEditWatchdog]);

  useEffect(() => {
    const changed = listen<TargetSnapshot>(TARGET_CHANGED_EVENT, (event) => {
      applyTargetEvent(event.payload);
    });
    return () => {
      changed.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    const un = listen<{
      files: string[];
      index: number;
      noteId: string | null;
      noteText: string | null;
      dataGeneration: number | null;
      edit?: boolean;
      editContext?: ImagePreviewEditContext | null;
      transient?: boolean;
    }>("toskr://preview-image", (e) => {
      detachPendingImageEdit();
      // 换内容先收尾旧备注编辑会话：自动保存语义下切换不丢稿
      if (captionRef.current.editing) {
        emitCaptionFinish(captionRef.current, captionSessionRef.current);
      }
      setTransientPeek(e.payload.transient ?? false);
      setFiles(e.payload.files);
      setIdx(Math.min(e.payload.index, Math.max(0, e.payload.files.length - 1)));
      setNoteId(e.payload.noteId ?? null);
      setNoteText(e.payload.noteText ?? "");
      setDraft(e.payload.noteText ?? "");
      setDataGeneration(e.payload.dataGeneration ?? null);
      setEditing(e.payload.edit ?? false);
      const nextEditContext = e.payload.transient
        ? null
        : e.payload.editContext ?? null;
      setEditContext(nextEditContext);
      setImageEditing(Boolean(nextEditContext?.startEditing));
      setRedactionHistory(freshRedactionHistory());
      setImageEditBusy(false);
      clearImageEditWatchdog();
      pendingImageEditRef.current = null;
      pendingImageEditCancelRef.current = null;
      restoreImageEditFocusRef.current = false;
      supersededImageEditRequestsRef.current.clear();
      setGen((g) => g + 1);
      // 独立 WebView 只读同步当前目标；发送仍由主面板统一执行（窥视免同步）。
      if (!e.payload.transient) void readTarget();
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [detachPendingImageEdit, clearImageEditWatchdog]);

  useEffect(() => {
    const invalidate = () => {
      detachPendingImageEdit();
      setFiles([]);
      setNoteId(null);
      setDataGeneration(null);
      setEditing(false);
      setEditContext(null);
      setImageEditing(false);
      setImageEditBusy(false);
      clearImageEditWatchdog();
      pendingImageEditRef.current = null;
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
  }, [detachPendingImageEdit, clearImageEditWatchdog]);

  const file = files[idx] ?? null;
  const fileRef = useRef(file);
  fileRef.current = file;
  const visibleImage = loadedImage?.file === file ? loadedImage : null;
  const url = visibleImage?.url ?? null;
  const imageSize = visibleImage
    ? { width: visibleImage.width, height: visibleImage.height }
    : { width: 0, height: 0 };
  const dims = imageSize.width && imageSize.height
    ? `${imageSize.width} × ${imageSize.height}`
    : "";
  useEffect(() => {
    let active = true;
    setLoadedImage(null);
    if (!file) return () => { active = false; };
    void api
      .deliveryImageDataUrl(file, true)
      .then((loadedUrl) => {
        if (active && loadedUrl) {
          setLoadedImage({ file, url: loadedUrl, width: 0, height: 0 });
        }
      })
      .catch(() => {
        if (active) setLoadedImage(null);
      });
    return () => { active = false; };
  }, [file]);

  useEffect(() => {
    const result = listen<ImageEditResultPayload>(
      IMAGE_EDIT_RESULT_EVENT,
      (event) => {
        const payload = event.payload;
        if (payload.requestId !== pendingImageEditRef.current) return;
        clearImageEditWatchdog();
        pendingImageEditRef.current = null;
        pendingImageEditCancelRef.current = null;
        setImageEditBusy(false);
        if (
          !payload.ok || !payload.editedFile ||
          !payload.width || !payload.height
        ) {
          tip("warn", payload.message || translateNow("图片打码未保存"));
          // 发送副本路径会把自动遮挡框排在前面，序号对不上手动框，只标笔记 / 草稿
          if (editContextRef.current?.kind !== "delivery") {
            setFailedRegions(failedRegionNumbers(payload.message ?? "").map((n) => n - 1));
          }
          return;
        }
        const resultNoteOwner = editContextRef.current?.kind === "note"
          ? editContextRef.current
          : captionRef.current.noteId &&
              captionRef.current.dataGeneration !== null
            ? {
                noteId: captionRef.current.noteId,
                dataGeneration: captionRef.current.dataGeneration,
              }
            : null;
        if (payload.noteSequence !== undefined && resultNoteOwner) {
          if (!advanceNoteImageEditSequence(
            noteImageEditSequencesRef.current,
            resultNoteOwner.noteId,
            resultNoteOwner.dataGeneration,
            payload.noteSequence
          )) {
            supersededImageEditRequestsRef.current.delete(payload.requestId);
            restoreImageEditFocusRef.current = true;
            setImageEditing(false);
            setRedactionHistory(freshRedactionHistory());
            return;
          }
        }
        if (supersededImageEditRequestsRef.current.delete(payload.requestId)) {
          restoreImageEditFocusRef.current = true;
          setImageEditing(false);
          setRedactionHistory(freshRedactionHistory());
          return;
        }
        setFiles((current) => current.map((entry, index) =>
          index === idx ? payload.editedFile! : entry
        ));
        setEditContext((current) =>
          current?.kind === "delivery" && payload.draftRevision !== undefined
            ? { ...current, draftRevision: payload.draftRevision }
            : current
        );
        restoreImageEditFocusRef.current = true;
        setImageEditing(false);
        setRedactionHistory(freshRedactionHistory());
      }
    );
    return () => {
      result.then((stop) => stop());
    };
  }, [idx, clearImageEditWatchdog]);

  useEffect(() => {
    const cancelled = listen<ImageEditCancelResultPayload>(
      IMAGE_EDIT_CANCEL_RESULT_EVENT,
      (event) => {
        const payload = event.payload;
        if (
          payload.requestId !== pendingImageEditRef.current ||
          payload.requestId !== pendingImageEditCancelRef.current
        ) return;
        pendingImageEditCancelRef.current = null;
        if (payload.status === "settled") {
          tip("info", translateNow("图片已完成处理，正在同步结果"));
          return;
        }
        pendingImageEditRef.current = null;
        setImageEditBusy(false);
        tip("warn", translateNow("图片处理超时，结果未保存，请重试"));
      }
    );
    return () => {
      cancelled.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    const replaced = listen<DraftImageReplacedPayload>(
      DRAFT_IMAGE_REPLACED_EVENT,
      (event) => {
        const payload = event.payload;
        const owner = editContextRef.current;
        if (
          owner?.kind !== "draft" ||
          owner.dataGeneration !== payload.dataGeneration ||
          payload.direction !== "undo"
        ) return;
        supersededImageEditRequestsRef.current.add(payload.operationId);
        setFiles((entries) => entries.map((entry) =>
          entry === payload.sourceFile ? payload.editedFile : entry
        ));
      }
    );
    return () => {
      replaced.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    const replaced = listen<NoteImageReplacedPayload>(
      NOTE_IMAGE_REPLACED_EVENT,
      (event) => {
        const payload = event.payload;
        const current = captionRef.current;
        if (!advanceNoteImageEditSequence(
          noteImageEditSequencesRef.current,
          payload.noteId,
          payload.dataGeneration,
          payload.sequence
        )) return;
        const noteOwner = editContextRef.current?.kind === "note"
          ? editContextRef.current
          : current.noteId && current.dataGeneration !== null
            ? {
                noteId: current.noteId,
                dataGeneration: current.dataGeneration,
              }
            : null;
        if (
          noteOwner?.noteId !== payload.noteId ||
          noteOwner.dataGeneration !== payload.dataGeneration
        ) return;
        // 撤销可能先于保存回执到达；按操作 ID 拒绝对应旧回执，避免内容寻址
        // 生成同名文件时误伤后续合法编辑。
        if (payload.direction === "undo") {
          supersededImageEditRequestsRef.current.add(payload.operationId);
        }
        setFiles((entries) => entries.map((entry) =>
          entry === payload.sourceFile ? payload.editedFile : entry
        ));
      }
    );
    return () => {
      replaced.then((stop) => stop());
    };
  }, []);

  useEffect(() => () => {
    detachPendingImageEdit();
    clearImageEditWatchdog();
  }, [detachPendingImageEdit, clearImageEditWatchdog]);

  useEffect(() => {
    if (imageEditing || !restoreImageEditFocusRef.current) return;
    restoreImageEditFocusRef.current = false;
    const timer = window.setTimeout(() => imageEditTriggerRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [imageEditing]);

  // 翻页 / 重新唤起：缩放回适配（缩放是单次查看态，不跨图残留）
  useEffect(() => {
    setView(FIT_VIEW);
    panDragRef.current = null;
  }, [gen, idx]);

  // 滚轮缩放：原生监听（passive:false 才能 preventDefault），鼠标位置为锚
  useEffect(() => {
    const area = zoomAreaRef.current;
    if (!area || imageEditing) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = area.getBoundingClientRect();
      const anchor = {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      };
      setView((previous) =>
        zoomViewAround(
          previous,
          previous.zoom * wheelZoomFactor(event.deltaY),
          anchor
        )
      );
    };
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => area.removeEventListener("wheel", onWheel);
  }, [imageEditing]);

  const zoomed = view.zoom > 1;

  // 放大后拖拽 = 平移图片（1× 时该区域仍是 data-tauri-drag-region 拖窗）
  const onZoomPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!zoomed || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    panDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onZoomPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((previous) => ({
      zoom: previous.zoom,
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    }));
  };

  const onZoomPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panDragRef.current?.pointerId !== event.pointerId) return;
    panDragRef.current = null;
  };

  // 双击复位（放大/缩小态均可；适配态的双击属于 drag-region 的窗口原生行为，勿抢）
  const onZoomDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (view.zoom === 1) return;
    if ((event.target as HTMLElement).closest("button")) return;
    setView(FIT_VIEW);
  };

  // 编辑态聚焦（WKWebView 焦点惰性 → 延时）
  useEffect(() => {
    if (editing) {
      window.setTimeout(() => textareaRef.current?.focus(), 30);
    }
  }, [editing]);

  /** 备注编辑收尾（emit 部分）：改动过 → 收尾保存（可撤销）；手动改回原文
   *  而中途已自动保存 → 静默还原。setState 由调用方按场景处理。 */
  const emitCaptionFinish = (
    state: typeof captionRef.current,
    session: { origin: string; lastSent: string } | null
  ) => {
    if (!state.noteId || state.dataGeneration === null) return;
    if (state.draft !== state.noteText) {
      void emitTo("main", "toskr://note-edit", {
        format: "flat",
        id: state.noteId,
        text: state.draft,
        dataGeneration: state.dataGeneration,
        origin: { text: session?.origin ?? state.noteText },
      } satisfies NoteEditPayload);
    } else if (session && session.lastSent !== session.origin) {
      void emitTo("main", "toskr://note-edit", {
        format: "flat",
        id: state.noteId,
        text: session.origin,
        dataGeneration: state.dataGeneration,
        autosave: true,
      } satisfies NoteEditPayload);
    }
  };

  // 备注编辑自动保存：进入编辑记住原文，每 2s 把草稿静默写回主面板；
  // Esc/关窗/切换内容收尾保留内容，防写一半白写。
  useEffect(() => {
    if (!editing || !noteId || dataGeneration === null) return;
    const session = { origin: noteText, lastSent: noteText };
    captionSessionRef.current = session;
    const id = noteId;
    const generation = dataGeneration;
    const timer = window.setInterval(() => {
      const current = captionRef.current.draft;
      if (current === session.lastSent) return;
      void emitTo("main", "toskr://note-edit", {
        format: "flat",
        id,
        text: current,
        dataGeneration: generation,
        autosave: true,
      } satisfies NoteEditPayload);
      session.lastSent = current;
    }, NOTE_EDIT_AUTOSAVE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      captionSessionRef.current = null;
    };
    // 只认会话身份（进出编辑、换卡），origin 在会话内必须保持稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, noteId]);

  /**
   * 把已入库图片追加到当前图片卡（只读 ref，可被事件闭包调用）：
   * 直接经 note-edit 落库（主面板出可撤销「已保存」），本地同步 files。
   * 备注编辑中拖入时带上当前草稿文字，避免旧文覆盖草稿。
   */
  const addImagesToCard = (images: PastedImage[]) => {
    const state = captionRef.current;
    if (!state.noteId || state.dataGeneration === null) return;
    const fresh = images.map((i) => i.file).filter((f) => !state.files.includes(f));
    if (!fresh.length) {
      tip("duplicate", "");
      return;
    }
    const nextImages = [...state.files, ...fresh];
    const text = state.editing ? state.draft : state.noteText;
    void emitTo("main", "toskr://note-edit", {
      format: "flat",
      id: state.noteId,
      text,
      images: nextImages,
      dataGeneration: state.dataGeneration,
      origin: { text: state.noteText, images: state.files },
    } satisfies NoteEditPayload);
    const session = captionSessionRef.current;
    if (session) session.lastSent = text;
    setFiles(nextImages);
  };

  /** 图片导入公共壳：等待期间换卡则废弃刚入库的文件。 */
  const importAndAdd = async (
    fetchImages: () => Promise<PastedImage[]>,
    emptyTip: string
  ) => {
    const before = captionRef.current;
    if (!before.noteId || before.dataGeneration === null) return;
    try {
      const images = await fetchImages();
      if (!images.length) {
        tip("info", emptyTip);
        return;
      }
      if (captionRef.current.noteId !== before.noteId) {
        void emitTo("main", "toskr://note-image-discard", {
          files: images.map((i) => i.file),
          dataGeneration: before.dataGeneration,
        });
        return;
      }
      addImagesToCard(images);
    } catch (error) {
      tip("warn", t("图片导入失败：{error}", { error: String(error) }));
    }
  };

  const pasteImages = () =>
    importAndAdd(() => api.pasteImagesFromClipboard(), t("剪贴板里没有可用图片"));

  // 拖拽本地图片进窗：Tauri 层接管 file drop；回调是首帧闭包，只读 ref
  useEffect(() => {
    const un = getCurrentWebviewWindow().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter") {
        setDropActive(
          !!captionRef.current.noteId &&
            captionRef.current.dataGeneration !== null &&
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
        const paths = imageFilePaths(payload.paths);
        if (!captionRef.current.noteId) return;
        if (!paths.length) {
          tip("info", t("仅支持图片文件"));
          return;
        }
        void importAndAdd(() => api.importImageFiles(paths), t("没有可导入的图片"));
      }
    });
    return () => {
      un.then((stop) => stop());
    };
    // importAndAdd 只读 ref，首帧闭包安全
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const imageEditTarget: ImageEditTarget | null = editContext
    ? editContext.kind === "delivery"
      ? {
          kind: "delivery",
          draftId: editContext.draftId,
          draftRevision: editContext.draftRevision,
          originalFile: editContext.originalFile,
        }
      : editContext.kind === "draft"
        ? {
          kind: "draft",
          dataGeneration: editContext.dataGeneration,
        }
        : {
            kind: "note",
            noteId: editContext.noteId,
            dataGeneration: editContext.dataGeneration,
          }
    : noteId && dataGeneration !== null
      ? { kind: "note", noteId, dataGeneration }
      : null;

  const beginImageEdit = () => {
    if (
      !file || loadedImage?.file !== file || !url ||
      !imageSize.width || !imageSize.height || !imageEditTarget
    ) {
      tip("info", t("图片仍在加载，请稍后再编辑"));
      return;
    }
    setView(FIT_VIEW);
    supersededImageEditRequestsRef.current.clear();
    setRedactionHistory(freshRedactionHistory());
    resetRedactionUi();
    setImageEditing(true);
  };

  function resetRedactionUi() {
    setSelectedRegion(null);
    setCandidates([]);
    setDetecting(false);
    setFailedRegions([]);
  }

  /** 记一步撤销历史并更新框列表。 */
  const commitRegions = (update: (present: RedactionRegion[]) => RedactionRegion[]) => {
    setRedactionHistory((current) => ({
      past: [...current.past, current.present],
      present: update(current.present),
      future: [],
    }));
    setFailedRegions([]);
  };

  const setDrawStyle = (style: RedactionStyle) => {
    setDrawStyleState(style);
    saveRedactionStyle(style);
  };

  const removeRegion = (index: number) => {
    commitRegions((present) => present.filter((_, i) => i !== index));
    setSelectedRegion(null);
  };

  const acceptCandidates = (indices: number[]) => {
    const picked = indices.map((i) => candidates[i]).filter(Boolean) as RedactionCandidate[];
    if (!picked.length) return;
    commitRegions((present) => [...present, ...picked.map((c) => ({ ...c.box, style: drawStyle }))]);
    setCandidates((current) => current.filter((_, i) => !indices.includes(i)));
  };

  const detectSensitive = async () => {
    if (!file || detecting || imageEditBusy) return;
    const scannedFile = file;
    setDetecting(true);
    try {
      const result = await api.scanImageFirewall(scannedFile);
      if (scannedFile !== fileRef.current) return;
      const covered = (box: RedactionRegion) =>
        redactionRegionsRef.current.some((r) =>
          r.x <= box.x && r.y <= box.y &&
          r.x + r.width >= box.x + box.width && r.y + r.height >= box.y + box.height
        );
      const seen = new Set<string>();
      const next = result.findings
        .filter((finding) => {
          const key = `${finding.pixelBox.x}:${finding.pixelBox.y}:${finding.pixelBox.width}:${finding.pixelBox.height}`;
          if (seen.has(key) || covered(finding.pixelBox)) return false;
          seen.add(key);
          return true;
        })
        .map((finding) => ({
          box: finding.pixelBox,
          label: t(FIREWALL_CATEGORY_LABEL[finding.category]),
        }));
      setCandidates(next);
      if (!next.length) {
        tip("info", result.findings.length ? t("识别到的敏感文字都已遮挡") : t("没有发现敏感文字，可以手动框选"));
      }
    } catch (error) {
      tip("warn", t("识别失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setDetecting(false);
    }
  };

  const cancelImageEdit = () => {
    if (imageEditBusy) return;
    restoreImageEditFocusRef.current = true;
    setImageEditing(false);
    setRedactionHistory(freshRedactionHistory());
    resetRedactionUi();
  };

  const undoImageRegion = () => {
    if (imageEditBusy) return;
    setSelectedRegion(null);
    setFailedRegions([]);
    setRedactionHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      };
    });
  };

  const redoImageRegion = () => {
    if (imageEditBusy) return;
    setSelectedRegion(null);
    setFailedRegions([]);
    setRedactionHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return {
        past: [...current.past, current.present],
        present: next,
        future: current.future.slice(1),
      };
    });
  };

  const applyImageEdit = () => {
    if (
      imageEditBusy || !file || loadedImage?.file !== file || !imageEditTarget ||
      !redactionRegions.length
    ) return;
    const requestId = imageEditRequestId();
    pendingImageEditRef.current = requestId;
    pendingImageEditCancelRef.current = null;
    setImageEditBusy(true);
    clearImageEditWatchdog();
    imageEditTimeoutRef.current = window.setTimeout(() => {
      if (pendingImageEditRef.current !== requestId) return;
      imageEditTimeoutRef.current = null;
      requestPendingImageEditCancellation();
    }, 20_000);
    void emitTo("main", IMAGE_EDIT_REQUEST_EVENT, {
      requestId,
      target: imageEditTarget,
      sourceFile: file,
      regions: redactionRegions,
    }).catch(() => {
      if (pendingImageEditRef.current !== requestId) return;
      clearImageEditWatchdog();
      pendingImageEditRef.current = null;
      pendingImageEditCancelRef.current = null;
      setImageEditBusy(false);
      tip("warn", t("图片编辑窗口通信失败，请重试"));
    });
  };

  const close = () => {
    if (imageEditing) {
      cancelImageEdit();
      return;
    }
    // 关窗不丢备注草稿：编辑态先按保存收尾（自动保存语义）
    if (captionRef.current.editing) save();
    // 📌 只对本次打开生效（与文本详情窗同规则）：关窗即复位
    setWinPinned(false);
    void getCurrentWebviewWindow().hide();
  };
  const many = files.length > 1;
  const sendLabel = many
    ? t("发送整张卡片（含 {n} 张图片）", { n: files.length })
    : t("发送当前图片卡片");

  const send = () => {
    if (!noteId || dataGeneration === null) return;
    if (!winPinned) close();
    void emitTo("main", "toskr://note-send", {
      id: noteId,
      dataGeneration,
    });
  };

  const save = () => {
    if (!noteId || dataGeneration === null) return;
    // 主面板 updateNoteText 持久化 + HUD 可撤销「已保存」；空文本 = 清除备注
    emitCaptionFinish(captionRef.current, captionSessionRef.current);
    if (draft !== noteText) setNoteText(draft);
    setEditing(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey &&
        e.key.toLowerCase() === "w"
      ) {
        // ⌘W 与红点同效：打码态先取消编辑，否则关窗
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (imageEditing) {
        const typing = (e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable='true']");
        if (e.key === "Escape") {
          e.preventDefault();
          // 逐层退出：先取消选中，再收起候选，最后才退出打码
          if (selectedRegion !== null) setSelectedRegion(null);
          else if (candidates.length) setCandidates([]);
          else cancelImageEdit();
        } else if (
          (e.key === "Backspace" || e.key === "Delete") && !typing &&
          selectedRegion !== null && !imageEditBusy
        ) {
          e.preventDefault();
          removeRegion(selectedRegion);
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          applyImageEdit();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (e.shiftKey) redoImageRegion();
          else undoImageRegion();
        }
        return;
      }
      // 编辑态接管：Esc 退出编辑（不关窗）、⌘⏎ 保存；翻页/空格关窗全部让位
      if (editing) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          // 自动保存语义：Esc 退出编辑保留内容，收尾气泡可撤销
          save();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
        return;
      }
      const interactiveTarget = (e.target as HTMLElement | null)?.closest(
        "button, a, input, textarea, select, [role='button'], [contenteditable='true']"
      );
      if (e.key === "Escape" || (e.key === " " && !interactiveTarget)) {
        e.preventDefault();
        close();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        // 查看态 ⌘V：把剪贴板图片（位图/本地文件）追加进当前图片卡
        e.preventDefault();
        void pasteImages();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setIdx((i) => Math.min(files.length - 1, i + 1));
      }
    };
    // 捕获阶段：不赌焦点（WKWebView 点击 button 不给焦点的既有约定）
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    files.length,
    editing,
    imageEditing,
    imageEditBusy,
    noteText,
    noteId,
    draft,
    dataGeneration,
    redactionRegions,
    redactionHistory,
    selectedRegion,
    candidates,
  ]);

  return (
    <DetailWindowFrame
      tone="lightbox"
      surfaceClassName="bg-surface-lightbox"
    >
      <DataReadOnlyGuard />
      {dropActive && (
        // 拖拽悬停提示：pointer-events-none 不拦 Tauri 层的 drop 事件
        <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-primary/5">
          <span className="rounded-md bg-background/95 px-3 py-1.5 text-body font-medium text-foreground shadow-sm">
            {t("松开以添加图片")}
          </span>
        </div>
      )}
      {/* 标题栏：可拖动窗口（瞬态窥视纯图免标题栏——穿透窗按钮点不到） */}
      {!transientPeek && (
      <div
        data-tauri-drag-region
        className={cn(
          "flex h-8 shrink-0 cursor-grab items-center gap-1.5 px-2 active:cursor-grabbing",
          platinum && "platinum-detail-titlebar"
        )}
      >
        <MacTrafficLights
          closeLabel={imageEditing ? t("取消图片编辑") : t("关闭预览")}
          closeDisabled={imageEditBusy}
          onClose={close}
        />
        <span aria-hidden data-tauri-drag-region className="platinum-stripe platinum-stripe--lead" />
        <span data-tauri-drag-region className="select-none text-body font-medium text-foreground/80">
          {imageEditing
            ? t("图片打码")
            : many
              ? t("图片 {index}/{total}", { index: idx + 1, total: files.length })
              : t("图片")}
        </span>
        <span aria-hidden data-tauri-drag-region className="platinum-stripe" />
        {!imageEditing && !editing && (
          <div className="ml-auto flex items-center gap-1">
            {noteId && dataGeneration !== null && (
              <IconButton
                label={winPinned ? t("取消固定（发送后恢复自动关窗）") : t("固定窗口：发送后保持打开")}
                size="xs"
                pressed={winPinned}
                onClick={() => setWinPinned((value) => !value)}
                className={cn(
                  "text-foreground/60 hover:bg-foreground/10 hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-0",
                  winPinned && "bg-foreground/10 text-foreground"
                )}
              >
                <Pin className="size-3.5" fill={winPinned ? "currentColor" : "none"} />
              </IconButton>
            )}
            {imageEditTarget && (
              <IconButton
                ref={imageEditTriggerRef}
                label={t("图片打码")}
                size="xs"
                onClick={beginImageEdit}
                className="text-foreground/60 hover:bg-foreground/10 hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-0"
              >
                <Shield className="size-3.5" />
              </IconButton>
            )}
            {noteId && dataGeneration !== null && (
            <>
              <p
                id="image-preview-target-status"
              role="status"
              aria-live="polite"
              className="sr-only"
            >
              {targetBlockedMessage ?? ""}
            </p>
            <IconButton
              label={
                targetReady
                  ? sendLabel
                  : t("发送不可用：{reason}", { reason: String(targetBlockedMessage) })
              }
              size="xs"
              disabled={!targetReady}
              aria-describedby={
                targetReady ? undefined : "image-preview-target-status"
              }
              onClick={send}
              className="text-foreground/60 hover:bg-foreground/10 hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-0"
            >
              <Send className="size-3.5" />
            </IconButton>
            </>
            )}
          </div>
        )}
        <PlatinumTrailingBoxes />
      </div>
      )}
      {/* 图片区：适配态整体拖窗；放大后拖拽转为平移图片（img 关闭指针事件） */}
      <div
        ref={zoomAreaRef}
        data-tauri-drag-region={imageEditing || zoomed ? undefined : true}
        onPointerDown={imageEditing ? undefined : onZoomPointerDown}
        onPointerMove={imageEditing ? undefined : onZoomPointerMove}
        onPointerUp={imageEditing ? undefined : onZoomPointerEnd}
        onPointerCancel={imageEditing ? undefined : onZoomPointerEnd}
        onDoubleClick={imageEditing ? undefined : onZoomDoubleClick}
        className={cn(
          "relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden",
          imageEditing ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing",
          // 瞬态窥视窗即图：Rust 侧按零 chrome 定窗，去内边距保证「原始尺寸」
          transientPeek ? "p-0" : "p-2"
        )}
      >
        {imageEditing && url && imageSize.width > 0 && imageSize.height > 0 ? (
          <ManualRedactionCanvas
            url={url}
            imageWidth={imageSize.width}
            imageHeight={imageSize.height}
            regions={redactionRegions}
            drawStyle={drawStyle}
            selected={selectedRegion}
            candidates={candidates}
            failed={failedRegions}
            disabled={imageEditBusy}
            onSelect={setSelectedRegion}
            onAdd={(region) => {
              commitRegions((present) => [...present, region]);
              setSelectedRegion(redactionRegions.length);
            }}
            onChange={(index, region) => {
              commitRegions((present) => present.map((r, i) => (i === index ? region : r)))
            }}
            onRemove={removeRegion}
            onAcceptCandidate={(index) => acceptCandidates([index])}
          />
        ) : url ? (
          <div
            className="pointer-events-none flex h-full w-full items-center justify-center will-change-transform"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            }}
          >
            <motion.img
              // 按「唤起代数 + 张序」重挂载：打开、翻页、重开同图都有浮现过渡
              key={`${gen}-${idx}`}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={springSnappy}
              src={url}
              alt=""
              onLoad={(event) => {
                const width = event.currentTarget.naturalWidth;
                const height = event.currentTarget.naturalHeight;
                setLoadedImage((current) =>
                  current?.file === file
                    ? { ...current, width, height }
                    : current
                );
              }}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : (
          <div className="flex h-24 w-32 animate-pulse items-center justify-center rounded-lg bg-foreground/10">
            <span className="sr-only">{t("加载中…")}</span>
          </div>
        )}
        {imageEditing && !transientPeek && candidates.length > 0 && (
          <div
            role="status"
            className={cn(
              floatingSurface(2),
              "absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg py-1 pl-3 pr-1 text-label"
            )}
          >
            <span className="size-2 rounded-full bg-warning" aria-hidden />
            {t("识别到 {n} 处敏感文字，点虚线框逐个打码", { n: candidates.length })}
            <Button
              type="button"
              size="xs"
              disabled={imageEditBusy}
              onClick={() => acceptCandidates(candidates.map((_, i) => i))}
            >
              {t("全部打码")}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setCandidates([])}>
              {t("忽略")}
            </Button>
          </div>
        )}
        {imageEditing && !transientPeek && (
          <RedactionToolbar
            drawStyle={drawStyle}
            onDrawStyle={setDrawStyle}
            count={redactionRegions.length}
            busy={imageEditBusy}
            detecting={detecting}
            canUndo={redactionHistory.past.length > 0}
            canRedo={redactionHistory.future.length > 0}
            onDetect={() => void detectSensitive()}
            onUndo={undoImageRegion}
            onRedo={redoImageRegion}
            onCancel={cancelImageEdit}
            onApply={applyImageEdit}
          />
        )}
        {many && !transientPeek && !imageEditing && (
          <>
            <button
              aria-label={t("上一张")}
              disabled={idx === 0}
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white/80 outline-none hover:bg-black/60 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              aria-label={t("下一张")}
              disabled={idx === files.length - 1}
              onClick={() => setIdx((i) => Math.min(files.length - 1, i + 1))}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white/80 outline-none hover:bg-black/60 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </button>
          </>
        )}
      </div>
      {/* 备注条（有笔记上下文才显示）：查看态一行截断 + 铅笔；编辑态 textarea */}
      {noteId && !transientPeek && !imageEditing && (
        <div className="shrink-0 border-t border-border px-3 py-1.5">
          {editing ? (
            <div className="flex items-end gap-1.5">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                placeholder={t("给这张图片写点文字…")}
                className={cn(
                  "min-h-0 flex-1 resize-none rounded-md bg-foreground/5 px-2 py-1 text-body text-foreground/90",
                  "placeholder:text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                )}
              />
              <button
                aria-label={t("保存备注（⌘⏎）")}
                title={t("保存（⌘⏎）；Esc 保存并退出")}
                onClick={save}
                className="rounded-md bg-foreground/10 p-1.5 text-foreground/85 outline-none hover:bg-foreground/15 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Check className="size-3.5" />
              </button>
            </div>
          ) : (
            <button
              aria-label={noteText ? t("编辑文字备注") : t("添加文字备注")}
              title={noteText ? t("编辑文字备注") : t("添加文字备注")}
              onClick={() => {
                setDraft(noteText);
                setEditing(true);
              }}
              className={cn(
                "group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left outline-none",
                "hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/60"
              )}
            >
              <Pencil className="size-3 shrink-0 text-foreground/40 group-hover:text-foreground/80" />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-body",
                  noteText ? "text-foreground/85" : "text-muted-foreground"
                )}
              >
                {noteText || t("添加文字备注…")}
              </span>
            </button>
          )}
        </div>
      )}
      {!transientPeek && !imageEditing && (
        <div className="flex h-6 shrink-0 items-center justify-center text-label tabular-nums text-muted-foreground">
          {[
            many ? `${idx + 1} / ${files.length}` : null,
            dims || null,
            zoomed ? `${Math.round(view.zoom * 100)}%` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
    </DetailWindowFrame>
  );
}

/** 打码工具栏（浮在图片底部，用户 2026-10-21 选定方案 A）：新框样式 / 识别 / 撤销重做 / 应用。 */
function RedactionToolbar({
  drawStyle,
  onDrawStyle,
  count,
  busy,
  detecting,
  canUndo,
  canRedo,
  onDetect,
  onUndo,
  onRedo,
  onCancel,
  onApply,
}: {
  drawStyle: RedactionStyle;
  onDrawStyle: (style: RedactionStyle) => void;
  count: number;
  busy: boolean;
  detecting: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onDetect: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const t = useT();
  // 两组：马赛克 | 实色（实色下再选 黑 / 白 / 取色）
  const fillMode = drawStyle.kind !== "mosaic";
  const lastFill = useRef<RedactionStyle>(
    fillMode ? drawStyle : { kind: "solid", color: REDACTION_BLACK }
  );
  if (fillMode) lastFill.current = drawStyle;
  const segment = (active: boolean) =>
    cn(
      "flex h-6 items-center gap-1.5 rounded-md px-2 text-label",
      active
        ? "bg-background text-foreground shadow-sm"
        : "text-muted-foreground hover:text-foreground",
      focusRing
    );
  return (
    <div
      role="toolbar"
      aria-label={t("打码工具")}
      className={cn(
        floatingSurface(2),
        "absolute bottom-3 left-1/2 z-20 flex max-w-[calc(100%-16px)] -translate-x-1/2 items-center gap-1 overflow-x-auto whitespace-nowrap rounded-xl p-1 [&::-webkit-scrollbar]:hidden"
      )}
    >
      <div className="surface-inset flex items-center gap-px rounded-lg p-0.5">
        <button
          type="button"
          aria-pressed={!fillMode}
          disabled={busy}
          onClick={() => onDrawStyle({ kind: "mosaic" })}
          className={segment(!fillMode)}
        >
          <RedactionStyleGlyph style={{ kind: "mosaic" }} />
          {t("马赛克")}
        </button>
        <button
          type="button"
          aria-pressed={fillMode}
          disabled={busy}
          onClick={() => onDrawStyle(lastFill.current)}
          className={segment(fillMode)}
        >
          <RedactionStyleGlyph style={{ kind: "solid", color: REDACTION_BLACK }} />
          {t("实色")}
        </button>
      </div>
      {fillMode && (
        <div className="flex items-center" aria-label={t("填充颜色")}>
          {REDACTION_STYLE_OPTIONS.filter((o) => o.style.kind !== "mosaic").map((option) => {
            const active = sameRedactionStyle(drawStyle, option.style);
            return (
              <IconButton
                key={option.label}
                label={t(option.label)}
                pressed={active}
                disabled={busy}
                onClick={() => onDrawStyle(option.style)}
              >
                <RedactionStyleGlyph style={option.style} />
              </IconButton>
            );
          })}
        </div>
      )}
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={busy || detecting}
        onClick={onDetect}
        className="border-warning/50 text-warning"
      >
        {detecting ? <Loader2 className="animate-spin" /> : <Sparkles />}
        {detecting ? t("识别中…") : t("识别敏感文字")}
      </Button>
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
      <IconButton label={t("撤销（⌘Z）")} size="xs" disabled={busy || !canUndo} onClick={onUndo}>
        <Undo2 className="size-3.5" />
      </IconButton>
      <IconButton label={t("重做（⌘⇧Z）")} size="xs" disabled={busy || !canRedo} onClick={onRedo}>
        <Redo2 className="size-3.5" />
      </IconButton>
      <span className="min-w-8 text-center text-micro tabular-nums text-muted-foreground">
        {t("{n} 处", { n: count })}
      </span>
      <IconButton
        label={t("拖动画框 · 点框选中后可移动、拖角缩放、⌫ 删除 · 方向键微移（⇧ 加大步长）· 滚轮缩放 · 按住 Space 平移 · ⌘⏎ 应用 · Esc 逐层退出")}
        size="xs"
      >
        <CircleHelp className="size-3.5" />
      </IconButton>
      <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
        {t("取消")}
      </Button>
      <Button type="button" size="xs" disabled={busy || count === 0} onClick={onApply}>
        {busy ? t("复检中…") : t("应用")}
      </Button>
    </div>
  );
}

