import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { motion } from "motion/react";
import { Check, Copy, ExternalLink, Pencil, Send, X } from "lucide-react";

import { headerGradient } from "@/components/NoteCard";
import { stats } from "@/components/PreviewOverlay";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import type { NotePreviewPayload } from "@/lib/actions";
import { highlightCode, langLabel } from "@/lib/code";
import { useAppIcon } from "@/lib/icons";
import { useNoteThumb } from "@/lib/media";
import { looksLikeMarkdown, renderMarkdown } from "@/lib/markdown";
import { springSnappy } from "@/lib/motion";
import { api } from "@/lib/tauri";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";

/**
 * 文本详情窗（独立 webview，桌面居中）：窄面板放不下长文，文字类卡片的
 * 预览与编辑都在这里。标题栏可拖动窗口；Esc 关闭（编辑态先退编辑）；
 * ⌘⏎ 保存。窗口隐藏复用，内容经 toskr://note-preview 事件下发；
 * 编辑保存 / 发送经事件回传主面板执行（主面板是唯一持久化写入方）。
 */
/** 附件缩略块：懒取缩略图，点击 Quick Look。 */
function AttachThumb({ file, onClick }: { file: string; onClick: () => void }) {
  const url = useNoteThumb(file);
  return (
    <button
      aria-label="查看图片"
      onClick={onClick}
      className={cn(
        "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md",
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
  );
}

export default function TextPreviewView() {
  const [note, setNote] = useState<NotePreviewPayload | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [mdView, setMdView] = useState(false);
  // 每次唤起自增：窗口隐藏复用，重开也要重播内容浮现
  const [gen, setGen] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const icon = useAppIcon(note?.sourceBundle ?? undefined);

  useEffect(() => {
    const un = listen<NotePreviewPayload>("toskr://note-preview", (e) => {
      const p = e.payload;
      setNote(p);
      setDraft(p.text);
      setEditing(p.edit);
      setMdView(!p.codeLang && p.kind !== "link" && looksLikeMarkdown(p.text));
      setGen((g) => g + 1);
      bodyRef.current?.scrollTo({ top: 0 });
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 编辑态聚焦（WKWebView 焦点惰性 → 延时）
  useEffect(() => {
    if (editing) {
      window.setTimeout(() => textareaRef.current?.focus(), 30);
    }
  }, [editing, note?.id]);

  const close = () => void getCurrentWebviewWindow().hide();

  const save = () => {
    if (!note) return;
    if (draft.trim() && draft !== note.text) {
      void emitTo("main", "toskr://note-edit", { id: note.id, text: draft });
      setNote({ ...note, text: draft });
    }
    setEditing(false);
  };

  const copy = async () => {
    if (!note) return;
    try {
      await api.copyText(editing ? draft : note.text);
      tip("ok", "已复制");
    } catch (e) {
      tip("warn", `复制失败：${e}`);
    }
  };

  const send = () => {
    if (!note) return;
    close();
    void emitTo("main", "toskr://note-send", { id: note.id });
  };

  // 窗口级 Esc / Space 关闭（Quick Look 心智：空格查看、再按空格收起）。
  // 编辑态：Esc 由 textarea 截获为退出编辑，Space 正常输入不关窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.key === " " && !editing)) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  if (!note) {
    // 内容未达的兜底空态：仍给关闭按钮 + 可拖动，不至于出现关不掉的白框
    return (
      <div
        data-tauri-drag-region
        className="flex h-screen w-screen items-center justify-center rounded-xl bg-background"
      >
        <button
          aria-label="关闭"
          onClick={close}
          className="absolute right-2 top-2 rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <X className="size-3.5" />
        </button>
        <span className="text-body text-muted-foreground">加载中…</span>
      </div>
    );
  }

  const isLink = note.kind === "link" && !!note.url;
  const isMd = !note.codeLang && !isLink && looksLikeMarkdown(note.text);
  const typeLabel = isLink
    ? "链接"
    : note.codeLang
      ? langLabel(note.codeLang)
      : "文本";
  const s = stats(note.text);

  return (
    // 无描边：窗体轮廓交给 macOS 原生投影（conf shadow: true），内部只做质感层
    <div className="flex h-screen w-screen select-none flex-col overflow-hidden rounded-xl bg-background text-foreground">
      {/* 标题栏：应用主色渐变（与卡顶同款）+ 顶缘内嵌高光（HUD 气泡同款
          玻璃质感）+ 与正文交界的一丝落影；可拖动窗口 */}
      <header
        data-tauri-drag-region
        className="relative z-10 flex h-11 shrink-0 cursor-grab items-center gap-2 px-3 shadow-[inset_0_1px_0_oklch(1_0_0/0.2),0_1px_3px_oklch(0_0_0/0.12)] active:cursor-grabbing"
        style={{ backgroundImage: headerGradient(icon?.color ?? "#5b5b60") }}
      >
        <div data-tauri-drag-region className="min-w-0 flex-1 leading-tight">
          <p
            data-tauri-drag-region
            className="truncate text-body font-semibold text-white"
          >
            {note.title || typeLabel}
          </p>
          <p data-tauri-drag-region className="truncate text-micro text-white/70">
            {note.sourceApp ? `来自 ${note.sourceApp}` : "笔记"}
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
      <motion.div
        key={gen}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={springSnappy}
        ref={bodyRef}
        className="min-h-0 flex-1 select-text overflow-y-auto p-4"
        onDoubleClick={() => {
          if (!editing) setEditing(true);
        }}
      >
        {editing ? (
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
                setDraft(note.text);
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
            className="md-preview text-title leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(note.text) }}
          />
        ) : (
          <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-body leading-relaxed">
            {note.text}
          </pre>
        )}
      </motion.div>

      {/* 图片附件缩略条（组合卡）：常显在正文与页脚之间，点击 Quick Look 原图 */}
      {!editing && note.images.length > 0 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-black/5 px-3 py-2 dark:border-white/5">
          {note.images.map((f, i) => (
            <AttachThumb
              key={f}
              file={f}
              onClick={() => void api.quickLook(note.images, i)}
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
              <IconButton label="编辑" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" />
              </IconButton>
              <IconButton label="复制" onClick={() => void copy()}>
                <Copy className="size-3.5" />
              </IconButton>
              <Button size="xs" onClick={send}>
                <Send className="size-3" /> 发送
              </Button>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
