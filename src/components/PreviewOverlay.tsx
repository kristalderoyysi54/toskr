import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, ExternalLink, Pencil, Send, Trash2, X } from "lucide-react";

import { tip } from "@/lib/tip";
import { Button } from "@/components/ui/button";
import { deleteNotesWithUndo, enrichLinkMeta, sendNotesToChat } from "@/lib/actions";
import { highlightCode, langLabel } from "@/lib/code";
import { looksLikeMarkdown, renderMarkdown } from "@/lib/markdown";
import { useAppIcon } from "@/lib/icons";
import { useNoteImage } from "@/lib/media";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { noteImages, useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 文本统计（Paste 风格）：字符 / 单词（CJK 按字计）/ 行。 */
function stats(text: string) {
  const chars = [...text].length;
  const words = (text.match(/[一-鿿぀-ヿ]|[a-zA-Z0-9_'-]+/g) ?? []).length;
  const lines = text.split("\n").length;
  return { chars, words, lines };
}

/**
 * 全文预览层（Space 弹出，Paste App 风格）：
 * 完整内容 + 字符统计 + 编辑/复制/发送/删除；↑↓ 切换卡片、Esc/Space 关闭。
 */
export function PreviewOverlay() {
  const previewId = useUIStore((s) => s.previewId);
  const editing = useUIStore((s) => s.previewEditing);
  const note = useNotesStore((s) => s.notes.find((n) => n.id === previewId));
  const icon = useAppIcon(note?.sourceBundle);
  const isImage = note?.kind === "image";
  const isLink = note?.kind === "link" && !!note?.url;
  const images = note ? noteImages(note) : [];
  const extraImages = isImage ? images.slice(1) : images;
  const imageUrl = useNoteImage(isImage ? note?.imageFile : undefined);
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Markdown 渲染视图：像 Markdown 的文本卡默认渲染，可切回原文（代码卡不参与）
  const [mdView, setMdView] = useState(false);
  const isMd = !!note && !isImage && !isLink && !note.codeLang && looksLikeMarkdown(note.text);

  useEffect(() => {
    setMdView(isMd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id]);

  useEffect(() => {
    if (editing && note) {
      setDraft(note.text);
      window.setTimeout(() => textareaRef.current?.focus(), 30);
    }
  }, [editing, note?.id]);

  const save = () => {
    if (note && draft.trim() && draft !== note.text) {
      useNotesStore.getState().updateNoteText(note.id, draft);
      // 编辑成链接（或改了 URL）时补抓网页标题/图标（幂等）
      void enrichLinkMeta(note.id);
      tip("ok", "已保存");
    }
    useUIStore.getState().setPreviewEditing(false);
  };

  const copy = async () => {
    if (!note) return;
    try {
      await api.copyText(note.text);
      tip("ok", "已复制");
    } catch (e) {
      tip("warn", `复制失败：${e}`);
    }
  };

  const remove = () => {
    if (!note) return;
    useUIStore.getState().closePreview();
    deleteNotesWithUndo([note.id], "已删除 1 条");
  };

  const s = note ? stats(note.text) : null;

  return (
    <AnimatePresence>
      {note && (
        <motion.div
          key="preview-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="absolute inset-0 z-40 flex flex-col bg-black/40 p-3 backdrop-blur-[2px]"
          onClick={() => useUIStore.getState().closePreview()}
        >
          <motion.div
            key={note.id}
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 38 }}
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border",
              "border-black/10 bg-white/95 shadow-2xl dark:border-white/10 dark:bg-zinc-900/95"
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <header
              className="flex items-center gap-2 px-3 py-2"
              style={{ backgroundColor: icon?.color ?? "#5b5b60" }}
            >
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[12px] font-semibold text-white">
                  {isImage
                    ? images.length > 1
                      ? `图片 ×${images.length}`
                      : "图片"
                    : isLink
                      ? "链接"
                      : note.codeLang
                        ? langLabel(note.codeLang)
                        : "文本"}
                </p>
                <p className="truncate text-[10px] text-white/70">
                  {note.sourceApp ? `来自 ${note.sourceApp}` : "笔记"}
                </p>
              </div>
              {icon && <img src={icon.url} alt="" className="size-6 rounded-[5px]" />}
              <button
                aria-label="关闭"
                onClick={() => useUIStore.getState().closePreview()}
                className="rounded p-1 text-white/70 hover:text-white"
              >
                <X className="size-3.5" />
              </button>
            </header>

            <div
              className="min-h-0 flex-1 overflow-y-auto p-3"
              onDoubleClick={() => {
                // 双击正文直接进入编辑（图片卡无文本编辑）
                if (!isImage && !editing) {
                  useUIStore.getState().setPreviewEditing(true);
                }
              }}
            >
              {isImage ? (
                <div className="flex h-full items-center justify-center">
                  {imageUrl ? (
                    <img
                      src={imageUrl}
                      alt="捕获的图片"
                      title="点击原尺寸预览"
                      onClick={() => note.imageFile && void api.quickLook(note.imageFile)}
                      className="max-h-full max-w-full cursor-zoom-in object-contain"
                    />
                  ) : (
                    <span className="text-[12px] text-muted-foreground">加载中…</span>
                  )}
                </div>
              ) : editing ? (
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter" && e.metaKey) {
                      e.preventDefault();
                      save();
                    } else if (e.key === "Escape") {
                      useUIStore.getState().setPreviewEditing(false);
                    }
                  }}
                  className="h-full min-h-40 w-full resize-none bg-transparent font-mono text-[12.5px] leading-relaxed outline-none"
                />
              ) : note.codeLang ? (
                <pre className="hljs whitespace-pre-wrap [overflow-wrap:anywhere] !bg-transparent font-mono text-[12.5px] leading-relaxed">
                  <code
                    dangerouslySetInnerHTML={{
                      __html: highlightCode(note.text, note.codeLang),
                    }}
                  />
                </pre>
              ) : mdView ? (
                <div
                  className="md-preview text-[13px] leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(note.text) }}
                />
              ) : (
                <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[12.5px] leading-relaxed">
                  {note.text}
                </pre>
              )}

              {extraImages.length > 0 && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {extraImages.map((f) => (
                    <PreviewThumb key={f} file={f} />
                  ))}
                </div>
              )}
            </div>

            <footer className="flex items-center gap-1 border-t border-black/5 px-3 py-2 dark:border-white/5">
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {isImage
                  ? `图片 ${note.imageW ?? "?"} × ${note.imageH ?? "?"}`
                  : s
                    ? `${s.chars} 字符 · ${s.words} 词 · ${s.lines} 行`
                    : ""}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {editing ? (
                  <Button size="sm" className="h-6 gap-1 rounded-lg px-2 text-[11px]" onClick={save}>
                    <Check className="size-3" /> 保存
                    <kbd className="text-[9px] opacity-70">⌘⏎</kbd>
                  </Button>
                ) : (
                  <>
                    {isMd && (
                      <button
                        onClick={() => setMdView(!mdView)}
                        className="rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                      >
                        {mdView ? "原文" : "渲染"}
                      </button>
                    )}
                    {isLink && (
                      <IconBtn label="打开链接" onClick={() => void api.openUrl(note.url!)}>
                        <ExternalLink className="size-3.5" />
                      </IconBtn>
                    )}
                    {!isImage && (
                      <IconBtn
                        label="编辑"
                        onClick={() => useUIStore.getState().setPreviewEditing(true)}
                      >
                        <Pencil className="size-3.5" />
                      </IconBtn>
                    )}
                    <IconBtn label="复制" onClick={copy}>
                      <Copy className="size-3.5" />
                    </IconBtn>
                    <IconBtn label="删除" onClick={remove}>
                      <Trash2 className="size-3.5" />
                    </IconBtn>
                    <Button
                      size="sm"
                      className="h-6 gap-1 rounded-lg px-2 text-[11px]"
                      onClick={() => {
                        useUIStore.getState().closePreview();
                        void sendNotesToChat([note.id]);
                      }}
                    >
                      <Send className="size-3" /> 发送
                    </Button>
                  </>
                )}
              </div>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 预览层里的附件图片（点击 Quick Look 原尺寸）。 */
function PreviewThumb({ file }: { file: string }) {
  const url = useNoteImage(file);
  return (
    <div
      title="点击原尺寸预览"
      onClick={() => void api.quickLook(file)}
      className="flex cursor-zoom-in items-center justify-center overflow-hidden rounded-lg bg-black/[0.05] p-1 dark:bg-white/[0.08]"
    >
      {url ? (
        <img src={url} alt="" className="max-h-40 max-w-full object-contain" />
      ) : (
        <span className="p-4 text-[11px] text-muted-foreground">加载中…</span>
      )}
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-md p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
    >
      {children}
    </button>
  );
}
