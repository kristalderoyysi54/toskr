import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { motion } from "motion/react";
import { Check, ChevronLeft, ChevronRight, Pencil, Send, X } from "lucide-react";

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
import { IconButton } from "@/components/ui/icon-button";
import {
  DATA_ACTIVITY_EVENT,
  DATA_LOCATION_CHANGED_EVENT,
} from "@/lib/dataOperations";
import { DATA_CONTEXT_INVALIDATED_EVENT } from "@/lib/dataGeneration";
import {
  api,
  TARGET_CHANGED_EVENT,
  type PastedImage,
  type TargetSnapshot,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  applyTargetEvent,
  readTarget,
  targetBlockMessage,
  useTargetStore,
} from "@/store/targetStore";

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
  const [files, setFiles] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [dims, setDims] = useState("");
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
  // 笔记上下文（备注编辑；null = 无编辑条，纯看图）
  const [noteId, setNoteId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [dataGeneration, setDataGeneration] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 拖拽图片悬停提示（松开添加）
  const [dropActive, setDropActive] = useState(false);
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
    }>("toskr://preview-image", (e) => {
      // 换内容先收尾旧备注编辑会话：自动保存语义下切换不丢稿
      if (captionRef.current.editing) {
        emitCaptionFinish(captionRef.current, captionSessionRef.current);
      }
      setFiles(e.payload.files);
      setIdx(Math.min(e.payload.index, Math.max(0, e.payload.files.length - 1)));
      setNoteId(e.payload.noteId ?? null);
      setNoteText(e.payload.noteText ?? "");
      setDraft(e.payload.noteText ?? "");
      setDataGeneration(e.payload.dataGeneration ?? null);
      setEditing(e.payload.edit ?? false);
      setGen((g) => g + 1);
      // 独立 WebView 只读同步当前目标；发送仍由主面板统一执行。
      void readTarget();
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const invalidate = () => {
      setFiles([]);
      setNoteId(null);
      setDataGeneration(null);
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

  const file = files[idx] ?? null;
  useEffect(() => {
    if (!file) return;
    setUrl(null);
    setDims("");
    void api
      .deliveryImageDataUrl(file, true)
      .then((u) => setUrl(u))
      .catch(() => setUrl(null));
  }, [file]);

  // 翻页 / 重新唤起：缩放回适配（缩放是单次查看态，不跨图残留）
  useEffect(() => {
    setView(FIT_VIEW);
    panDragRef.current = null;
  }, [gen, idx]);

  // 滚轮缩放：原生监听（passive:false 才能 preventDefault），鼠标位置为锚
  useEffect(() => {
    const area = zoomAreaRef.current;
    if (!area) return;
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
  }, []);

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
      tip("warn", `图片导入失败：${error}`);
    }
  };

  const pasteImages = () =>
    importAndAdd(() => api.pasteImagesFromClipboard(), "剪贴板里没有可用图片");

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
          tip("info", "仅支持图片文件");
          return;
        }
        void importAndAdd(() => api.importImageFiles(paths), "没有可导入的图片");
      }
    });
    return () => {
      un.then((stop) => stop());
    };
    // importAndAdd 只读 ref，首帧闭包安全
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    // 关窗不丢备注草稿：编辑态先按保存收尾（自动保存语义）
    if (captionRef.current.editing) save();
    void getCurrentWebviewWindow().hide();
  };
  const many = files.length > 1;
  const sendLabel = many
    ? `发送整张卡片（含 ${files.length} 张图片）`
    : "发送当前图片卡片";

  const send = () => {
    if (!noteId || dataGeneration === null) return;
    close();
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
      if (e.key === "Escape" || e.key === " ") {
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
  }, [files.length, editing, noteText, noteId, draft, dataGeneration]);

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
            松开以添加图片
          </span>
        </div>
      )}
      {/* 标题栏：可拖动窗口 */}
      <div
        data-tauri-drag-region
        className="flex h-8 shrink-0 cursor-grab items-center gap-1.5 px-2 active:cursor-grabbing"
      >
        <button
          aria-label="关闭预览"
          onClick={close}
          className="rounded-full p-0.5 text-foreground/60 outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" />
        </button>
        <span data-tauri-drag-region className="select-none text-body font-medium text-foreground/80">
          {many ? `图片 ${idx + 1}/${files.length}` : "图片"}
        </span>
        {!editing && noteId && dataGeneration !== null && (
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
                  : `发送不可用：${targetBlockedMessage}`
              }
              size="xs"
              disabled={!targetReady}
              aria-describedby={
                targetReady ? undefined : "image-preview-target-status"
              }
              onClick={send}
              className="ml-auto text-foreground/60 hover:bg-foreground/10 hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-0"
            >
              <Send className="size-3.5" />
            </IconButton>
          </>
        )}
      </div>
      {/* 图片区：适配态整体拖窗；放大后拖拽转为平移图片（img 关闭指针事件） */}
      <div
        ref={zoomAreaRef}
        data-tauri-drag-region={zoomed ? undefined : true}
        onPointerDown={onZoomPointerDown}
        onPointerMove={onZoomPointerMove}
        onPointerUp={onZoomPointerEnd}
        onPointerCancel={onZoomPointerEnd}
        onDoubleClick={onZoomDoubleClick}
        className="relative flex min-h-0 flex-1 cursor-grab touch-none items-center justify-center overflow-hidden p-2 active:cursor-grabbing"
      >
        {url ? (
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
              onLoad={(e) =>
                setDims(
                  `${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`
                )
              }
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : (
          <div className="flex h-24 w-32 animate-pulse items-center justify-center rounded-lg bg-foreground/10">
            <span className="sr-only">加载中…</span>
          </div>
        )}
        {many && (
          <>
            <button
              aria-label="上一张"
              disabled={idx === 0}
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white/80 outline-none hover:bg-black/60 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              aria-label="下一张"
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
      {noteId && (
        <div className="shrink-0 border-t border-border px-3 py-1.5">
          {editing ? (
            <div className="flex items-end gap-1.5">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                placeholder="给这张图片写点文字…"
                className={cn(
                  "min-h-0 flex-1 resize-none rounded-md bg-foreground/5 px-2 py-1 text-body text-foreground/90",
                  "placeholder:text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                )}
              />
              <button
                aria-label="保存备注（⌘⏎）"
                title="保存（⌘⏎）；Esc 取消"
                onClick={save}
                className="rounded-md bg-foreground/10 p-1.5 text-foreground/85 outline-none hover:bg-foreground/15 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Check className="size-3.5" />
              </button>
            </div>
          ) : (
            <button
              aria-label={noteText ? "编辑文字备注" : "添加文字备注"}
              title={noteText ? "编辑文字备注" : "添加文字备注"}
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
                {noteText || "添加文字备注…"}
              </span>
            </button>
          )}
        </div>
      )}
      <div className="flex h-6 shrink-0 items-center justify-center text-label tabular-nums text-muted-foreground">
        {[
          many ? `${idx + 1} / ${files.length}` : null,
          dims || null,
          zoomed ? `${Math.round(view.zoom * 100)}%` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </DetailWindowFrame>
  );
}
