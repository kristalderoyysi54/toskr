import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, ExternalLink, Pencil, Send, Trash2, X } from "lucide-react";

import { tip } from "@/lib/tip";
import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { deleteNotesWithUndo, enrichLinkMeta, sendNotesToChat } from "@/lib/actions";
import { highlightCode, langLabel } from "@/lib/code";
import { looksLikeMarkdown, renderMarkdown } from "@/lib/markdown";
import { useAppIcon } from "@/lib/icons";
import { useNoteImage, useNoteThumb } from "@/lib/media";
import { springModal, tweenFade } from "@/lib/motion";
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
  // 手写模态语义：Radix Dialog 的 portal/焦点锁在此窗口类会吞点击（同 SimpleMenu 成因），
  // 自管 Tab 循环 + 开合时的焦点交还；Esc/Space/↑↓ 仍由 App 级捕获处理，互不重叠
  const cardModalRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const hasNote = !!note;
  useEffect(() => {
    if (hasNote) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      window.setTimeout(() => cardModalRef.current?.focus(), 30);
    } else if (restoreFocusRef.current) {
      // 尽力交还（WKWebView 点击常不给焦点，还不回去就静默作罢）
      restoreFocusRef.current.focus?.();
      restoreFocusRef.current = null;
    }
  }, [hasNote]);
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
          transition={tweenFade}
          className="absolute inset-0 z-40 flex flex-col bg-black/40 p-3 backdrop-blur-[2px]"
          onClick={() => useUIStore.getState().closePreview()}
        >
          <motion.div
            key={note.id}
            ref={cardModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-title"
            tabIndex={-1}
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={springModal}
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl outline-none",
              floatingSurface(3)
            )}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // 只管 Tab 循环；其余键位归 App 级预览层捕获处理
              if (e.key !== "Tab") return;
              const focusables = cardModalRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])'
              );
              if (!focusables?.length) return;
              const first = focusables[0];
              const last = focusables[focusables.length - 1];
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
              }
            }}
          >
            <header
              className="flex items-center gap-2 px-3 py-2"
              style={{ backgroundColor: icon?.color ?? "#5b5b60" }}
            >
              <div className="min-w-0 flex-1 leading-tight">
                <p id="preview-title" className="truncate text-body font-semibold text-white">
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
                <p className="truncate text-micro text-white/70">
                  {note.sourceApp ? `来自 ${note.sourceApp}` : "笔记"}
                </p>
              </div>
              {icon && <img src={icon.url} alt="" className="size-6 rounded-[5px]" />}
              <button
                aria-label="关闭"
                onClick={() => useUIStore.getState().closePreview()}
                className="rounded-sm p-1 text-white/70 hover:text-white"
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
                      onClick={() => note.imageFile && void api.quickLook(images)}
                      className="max-h-full max-w-full cursor-zoom-in object-contain"
                    />
                  ) : (
                    <span className="text-body text-muted-foreground">加载中…</span>
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
                  className="md-preview text-title leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(note.text) }}
                />
              ) : (
                <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-body leading-relaxed">
                  {note.text}
                </pre>
              )}

              {extraImages.length > 0 && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {extraImages.map((f) => (
                    <PreviewThumb key={f} files={images} index={images.indexOf(f)} />
                  ))}
                </div>
              )}
            </div>

            <footer className="flex items-center gap-1 border-t border-black/5 px-3 py-2 dark:border-white/5">
              <span className="text-micro tabular-nums text-muted-foreground">
                {isImage
                  ? `图片 ${note.imageW ?? "?"} × ${note.imageH ?? "?"}`
                  : s
                    ? `${s.chars} 字符 · ${s.words} 词 · ${s.lines} 行`
                    : ""}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {editing ? (
                  <Button size="xs" onClick={save}>
                    <Check className="size-3" /> 保存
                    {/* token-exception: 9px 为重塑前原始尺寸，用户指定还原 */}
                    <Kbd inline className="text-[9px]">⌘⏎</Kbd>
                  </Button>
                ) : (
                  <>
                    {isMd && (
                      <button
                        onClick={() => setMdView(!mdView)}
                        className="rounded-md px-1.5 py-0.5 text-micro text-muted-foreground outline-none hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 dark:hover:bg-white/10"
                      >
                        {mdView ? "原文" : "渲染"}
                      </button>
                    )}
                    {isLink && (
                      <IconButton label="打开链接" onClick={() => void api.openUrl(note.url!)}>
                        <ExternalLink className="size-3.5" />
                      </IconButton>
                    )}
                    {!isImage && (
                      <IconButton
                        label="编辑"
                        onClick={() => useUIStore.getState().setPreviewEditing(true)}
                      >
                        <Pencil className="size-3.5" />
                      </IconButton>
                    )}
                    <IconButton label="复制" onClick={copy}>
                      <Copy className="size-3.5" />
                    </IconButton>
                    <IconButton label="删除" onClick={remove}>
                      <Trash2 className="size-3.5" />
                    </IconButton>
                    <Button
                      size="xs"
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

/** 预览层里的附件图片（点击从该张起原尺寸预览，可 ←/→ 翻看全组）。 */
function PreviewThumb({ files, index }: { files: string[]; index: number }) {
  const url = useNoteThumb(files[index]);
  return (
    <div
      title="点击原尺寸预览"
      onClick={() => void api.quickLook(files, Math.max(0, index))}
      className="flex cursor-zoom-in items-center justify-center overflow-hidden rounded-lg bg-black/[0.05] p-1 dark:bg-white/[0.08]"
    >
      {url ? (
        <img src={url} alt="" className="max-h-40 max-w-full object-contain" />
      ) : (
        <span className="p-4 text-label text-muted-foreground">加载中…</span>
      )}
    </div>
  );
}
