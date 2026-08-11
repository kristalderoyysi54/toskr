import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { motion } from "motion/react";
import { Check, ChevronLeft, ChevronRight, Pencil, X } from "lucide-react";

import { springSnappy } from "@/lib/motion";
import { DataReadOnlyGuard } from "@/components/DataReadOnlyGuard";
import { DetailWindowFrame } from "@/components/DetailWindowFrame";
import {
  DATA_ACTIVITY_EVENT,
  DATA_LOCATION_CHANGED_EVENT,
} from "@/lib/dataOperations";
import { DATA_CONTEXT_INVALIDATED_EVENT } from "@/lib/dataGeneration";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * 图片原尺寸预览窗（独立 webview，Paste 风格）：
 * 标题栏与图片区均可拖动窗口、可缩放；⊗ / Esc / Space 关闭（隐藏复用）。
 * 组合卡多图：←/→ 或两侧按钮翻看，标题与底栏显示第几张。
 * 刻意不做失焦关闭——可拖动窗口的语义是「摆在一边对照看」。
 * 带笔记上下文（noteId）时底部显示文字备注条：查看 / 内联编辑，
 * ⌘⏎ 保存经 toskr://note-edit 回传主面板（主面板是唯一持久化写入方）。
 */
export default function ImagePreviewView() {
  const [files, setFiles] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [dims, setDims] = useState("");
  // 每次唤起自增：窗口隐藏复用，重开同一张图也要重播入场动效
  const [gen, setGen] = useState(0);
  // 笔记上下文（备注编辑；null = 无编辑条，纯看图）
  const [noteId, setNoteId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [dataGeneration, setDataGeneration] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const un = listen<{
      files: string[];
      index: number;
      noteId: string | null;
      noteText: string | null;
      dataGeneration: number | null;
      edit?: boolean;
    }>("toskr://preview-image", (e) => {
      setFiles(e.payload.files);
      setIdx(Math.min(e.payload.index, Math.max(0, e.payload.files.length - 1)));
      setNoteId(e.payload.noteId ?? null);
      setNoteText(e.payload.noteText ?? "");
      setDraft(e.payload.noteText ?? "");
      setDataGeneration(e.payload.dataGeneration ?? null);
      setEditing(e.payload.edit ?? false);
      setGen((g) => g + 1);
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
      .imageDataUrl(file)
      .then((u) => setUrl(u))
      .catch(() => setUrl(null));
  }, [file]);

  // 编辑态聚焦（WKWebView 焦点惰性 → 延时）
  useEffect(() => {
    if (editing) {
      window.setTimeout(() => textareaRef.current?.focus(), 30);
    }
  }, [editing]);

  const close = () => void getCurrentWebviewWindow().hide();
  const many = files.length > 1;

  const save = () => {
    if (!noteId || dataGeneration === null) return;
    if (draft !== noteText) {
      // 主面板 updateNoteText 持久化 + HUD「已保存」；空文本 = 清除备注
      void emitTo("main", "toskr://note-edit", {
        id: noteId,
        text: draft,
        dataGeneration,
      });
      setNoteText(draft);
    }
    setEditing(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 编辑态接管：Esc 退出编辑（不关窗）、⌘⏎ 保存；翻页/空格关窗全部让位
      if (editing) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setDraft(noteText);
          setEditing(false);
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
        return;
      }
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        close();
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
      {/* 标题栏：可拖动窗口 */}
      <div
        data-tauri-drag-region
        className="flex h-8 shrink-0 cursor-grab items-center gap-1.5 px-2 active:cursor-grabbing"
      >
        <button
          aria-label="关闭预览"
          onClick={close}
          className="rounded-full p-0.5 text-white/60 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <X className="size-3.5" />
        </button>
        <span data-tauri-drag-region className="select-none text-body font-medium text-white/80">
          {many ? `图片 ${idx + 1}/${files.length}` : "图片"}
        </span>
      </div>
      {/* 图片区：同样可拖动窗口（img 关闭指针事件，拖拽落在容器上） */}
      <div
        data-tauri-drag-region
        className="relative flex min-h-0 flex-1 cursor-grab items-center justify-center p-2 active:cursor-grabbing"
      >
        {url ? (
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
            className="pointer-events-none max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="flex h-24 w-32 animate-pulse items-center justify-center rounded-lg bg-white/10">
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
        <div className="shrink-0 border-t border-white/10 px-3 py-1.5">
          {editing ? (
            <div className="flex items-end gap-1.5">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                placeholder="给这张图片写点文字…"
                className={cn(
                  "min-h-0 flex-1 resize-none rounded-md bg-white/10 px-2 py-1 text-body text-white/90",
                  "placeholder:text-white/35 outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                )}
              />
              <button
                aria-label="保存备注（⌘⏎）"
                title="保存（⌘⏎）；Esc 取消"
                onClick={save}
                className="rounded-md bg-white/15 p-1.5 text-white/85 outline-none hover:bg-white/25 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
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
                "hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40"
              )}
            >
              <Pencil className="size-3 shrink-0 text-white/40 group-hover:text-white/80" />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-body",
                  noteText ? "text-white/85" : "text-white/35"
                )}
              >
                {noteText || "添加文字备注…"}
              </span>
            </button>
          )}
        </div>
      )}
      <div className="flex h-6 shrink-0 items-center justify-center text-label tabular-nums text-white/60">
        {many ? `${idx + 1} / ${files.length}${dims ? ` · ${dims}` : ""}` : dims}
      </div>
    </DetailWindowFrame>
  );
}
