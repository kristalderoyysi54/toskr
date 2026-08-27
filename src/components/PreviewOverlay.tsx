import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { Check, Copy, ExternalLink, Pencil, Send, Trash2, X } from "lucide-react";

import { imageCaption } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import {
  RichNoteContent,
  RichNoteTextEditor,
} from "@/components/RichNoteContent";
import {
  armNoteEditUndo,
  copyNoteContent,
  deleteNotesWithUndo,
  enrichLinkMeta,
  NOTE_EDIT_AUTOSAVE_INTERVAL_MS,
  sendNotesToChat,
  undoableTip,
} from "@/lib/actions";
import { highlightCode, langLabel } from "@/lib/code";
import { looksLikeMarkdown, renderMarkdown } from "@/lib/markdown";
import { useAppIcon } from "@/lib/icons";
import { useNoteImage, useNoteThumb } from "@/lib/media";
import { springModal, tweenFade } from "@/lib/motion";
import { api, type ImagePreviewSource } from "@/lib/tauri";
import { currentDataGeneration } from "@/lib/dataGeneration";
import {
  hasOrderedRichLayout,
  normalizeNoteContentBlocks,
  type NoteContentBlock,
} from "@/lib/noteContentBlocks";
import { cn } from "@/lib/utils";
import { headerGradient } from "@/components/NoteCard";
import {
  CLIPBOARD_ID,
  noteImages,
  useNotesStore,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import { useTargetStore } from "@/store/targetStore";

/** 文本统计（Paste 风格）：字符 / 单词（CJK 按字计）/ 行。 */
export function stats(text: string) {
  const chars = [...text].length;
  const words = (text.match(/[一-鿿぀-ヿ]|[a-zA-Z0-9_'-]+/g) ?? []).length;
  const lines = text.split("\n").length;
  return { chars, words, lines };
}

type Rect = { top: number; left: number; width: number; height: number };

/** 按 id 反查卡片当前视口矩形（开合形变的锚点；找不到/太小则退回淡入淡出）。 */
function cardRect(id: string | null): Rect | null {
  if (!id) return null;
  const el = document.querySelector(`[data-note-id="${CSS.escape(id)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/** 预览层四周留白（原 p-3 的 12px）。 */
const MODAL_MARGIN = 12;

/**
 * 全文预览层（Space 弹出，Paste App 风格）：
 * 完整内容 + 字符统计 + 编辑/复制/发送/删除；↑↓ 切换卡片、Esc/Space 关闭。
 */
export function PreviewOverlay() {
  const previewId = useUIStore((s) => s.previewId);
  const editing = useUIStore((s) => s.previewEditing);
  const profileChanged = useTargetStore((s) => s.profileOverrideNeedsConfirmation);
  const targetReady = useTargetStore(
    (s) => s.status === "ready" && !s.profileOverrideNeedsConfirmation
  );
  const note = useNotesStore((s) => s.notes.find((n) => n.id === previewId));
  const internalSendAvailable = note?.sectionId === CLIPBOARD_ID;
  const canSend = targetReady || internalSendAvailable;
  const icon = useAppIcon(note?.sourceBundle);
  const isImage = note?.kind === "image";
  const isLink = note?.kind === "link" && !!note?.url;
  const orderedRich = hasOrderedRichLayout(note?.contentBlocks);
  const activeEditing = editing && !isImage;
  const imagePreviewSource: ImagePreviewSource | undefined =
    note && !activeEditing
      ? {
          id: note.id,
          text: note.text,
          dataGeneration: currentDataGeneration(),
        }
      : undefined;
  const images = note ? noteImages(note) : [];
  const extraImages = isImage ? images.slice(1) : images;
  const imageUrl = useNoteImage(isImage ? note?.imageFile : undefined);
  const [draft, setDraft] = useState("");
  const [draftBlocks, setDraftBlocks] = useState<NoteContentBlock[]>(
    () => note?.contentBlocks ?? []
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 手写模态语义：Radix Dialog 的 portal/焦点锁在此窗口类会吞点击（同 SimpleMenu 成因），
  // 自管 Tab 循环 + 开合时的焦点交还；Esc/Space/↑↓ 仍由 App 级捕获处理，互不重叠
  const cardModalRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // ↑↓ 导航原地换内容（形变层不重挂载），滚动位置手动归零
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [previewId]);
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
  }, [note, isMd]);

  useEffect(() => {
    if (activeEditing && note) {
      if (orderedRich && note.contentBlocks) {
        setDraftBlocks(note.contentBlocks);
        return;
      }
      setDraft(note.text);
      window.setTimeout(() => textareaRef.current?.focus(), 30);
    }
    // 只认「会话身份」：note 是 store 活引用，自动保存每次写库都会换对象，
    // 让它进依赖会把正在输入的草稿重置回已落库文本
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEditing, note?.id, orderedRich]);

  // 草稿镜像：自动保存的 interval 与收尾 cleanup 只读 ref，不受闭包旧 state 影响
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftBlocksRef = useRef(draftBlocks);
  draftBlocksRef.current = draftBlocks;

  // 编辑自动保存（面板内预览层，直接写 store）：进入编辑快照原文，每 2s 把
  // 草稿静默落库；一切退出路径（⌘⏎/Esc/关层/切卡）都汇到 cleanup 收尾——
  // 有改动补落库并出可撤销「已保存」（撤销 = 回到本次编辑前），草稿被清空
  // 则还原原文。防写一半白写：崩溃/误关最多丢一个间隔内的输入。
  useEffect(() => {
    if (!activeEditing || !note) return;
    const id = note.id;
    const originBlocks =
      orderedRich && note.contentBlocks ? note.contentBlocks : null;
    const originBlocksJson = originBlocks
      ? JSON.stringify(normalizeNoteContentBlocks(originBlocks))
      : null;
    const session = {
      originText: note.text,
      persistedText: note.text,
      persistedBlocksJson: originBlocksJson,
    };
    const noteExists = () =>
      useNotesStore.getState().notes.some((n) => n.id === id);
    const persistDraft = () => {
      if (!noteExists()) return;
      if (originBlocks) {
        const next = normalizeNoteContentBlocks(draftBlocksRef.current);
        const json = JSON.stringify(next);
        if (json === session.persistedBlocksJson) return;
        useNotesStore.getState().updateNoteContent(id, next);
        session.persistedBlocksJson = json;
        return;
      }
      const text = draftRef.current;
      // 清空态不落库：未写完的空草稿覆盖原文只会造成二次事故
      if (!text.trim() || text === session.persistedText) return;
      useNotesStore.getState().updateNoteText(id, text);
      session.persistedText = text;
    };
    const timer = window.setInterval(
      persistDraft,
      NOTE_EDIT_AUTOSAVE_INTERVAL_MS
    );
    return () => {
      window.clearInterval(timer);
      if (!noteExists()) return;
      if (originBlocks) {
        const next = normalizeNoteContentBlocks(draftBlocksRef.current);
        const json = JSON.stringify(next);
        if (json !== session.persistedBlocksJson) {
          useNotesStore.getState().updateNoteContent(id, next);
        }
        if (json !== originBlocksJson) {
          void enrichLinkMeta(id);
          armNoteEditUndo(id, { contentBlocks: originBlocks });
        }
        return;
      }
      // 清空草稿 = 放弃：还原原文（不出气泡）
      const text = draftRef.current.trim()
        ? draftRef.current
        : session.originText;
      if (text !== session.persistedText) {
        useNotesStore.getState().updateNoteText(id, text);
      }
      if (text.trim() !== session.originText) {
        // 编辑成链接（或改了 URL）时补抓网页标题/图标（幂等）
        void enrichLinkMeta(id);
        armNoteEditUndo(id, { text: session.originText });
      }
    };
    // 同上：只认会话身份，origin 在会话内必须保持稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEditing, note?.id, orderedRich]);

  /** 保存按钮/⌘⏎：真正的落库与「已保存」气泡由编辑会话 cleanup 统一收尾。 */
  const save = () => useUIStore.getState().setPreviewEditing(false);

  const copy = () => {
    if (!note) return;
    void copyNoteContent(note);
  };

  const remove = () => {
    if (!note) return;
    useUIStore.getState().closePreview();
    deleteNotesWithUndo([note.id], "已删除 1 条");
  };

  /** 从组合卡里移除一张图（可撤销）；移到最后一张连卡片一起没了就关预览层。 */
  const removeImage = (file: string) => {
    if (!note) return;
    const { noteDeleted } = useNotesStore.getState().removeNoteImage(note.id, file);
    if (noteDeleted) useUIStore.getState().closePreview();
    undoableTip(noteDeleted ? "已删除 1 条" : "已移除图片");
  };

  const s = note ? stats(note.text) : null;

  // ===== 开合形变（Aceternity expandable-card 的手感，手动 FLIP 实现）=====
  // 打开：从被点卡片的实测矩形弹性生长为整层；关闭：收缩回卡片当前位置。
  // 不用 layoutId 共享布局：卡片根节点已被 dnd-kit 接管 transform，双方会打架。
  const openRect = useMemo(() => cardRect(previewId), [previewId]);
  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (previewId) lastIdRef.current = previewId;
  }, [previewId]);
  // 退场矩形在「previewId 刚清空」的那次渲染实测（↑↓ 导航后收回到最后所在卡）
  const exitRect = previewId ? openRect : cardRect(lastIdRef.current);
  const openTarget = {
    top: MODAL_MARGIN,
    left: MODAL_MARGIN,
    width: window.innerWidth - MODAL_MARGIN * 2,
    height: window.innerHeight - MODAL_MARGIN * 2,
    opacity: 1,
    scale: 1,
  };
  const modalVariants: Variants = {
    from: (r: Rect | null) =>
      r ? { ...r, opacity: 1, scale: 1 } : { ...openTarget, opacity: 0, scale: 0.96 },
    open: { ...openTarget, transition: springModal },
    exit: (r: Rect | null) =>
      r
        ? { ...r, opacity: 1, scale: 1, transition: springModal }
        : { ...openTarget, opacity: 0, scale: 0.96, transition: tweenFade },
  };

  return (
    <AnimatePresence custom={exitRect}>
      {/* 遮罩与详情层是同级兄弟：嵌套的话遮罩先淡完会把还在收缩的详情层一起藏掉 */}
      {note && (
        <motion.div
          key="preview-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={tweenFade}
          className="absolute inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
          onClick={() => useUIStore.getState().closePreview()}
        />
      )}
      {note && (
          <motion.div
            key="preview-modal"
            ref={cardModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-title"
            tabIndex={-1}
            custom={openRect}
            variants={modalVariants}
            initial="from"
            animate="open"
            exit="exit"
            className={cn(
              "absolute z-40 flex flex-col overflow-hidden rounded-xl outline-none",
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
            {/* 内容随形变淡入（略延迟让矩形先立起来）；关闭时先速隐再收缩 */}
            <motion.div
              className="flex min-h-0 flex-1 flex-col"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { delay: 0.06, duration: 0.18 } }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
            >
            <header
              className="flex items-center gap-2 px-3 py-2"
              style={{ backgroundImage: headerGradient(icon?.color ?? "#7c8494") }}
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
              ref={bodyRef}
              className="min-h-0 flex-1 overflow-y-auto p-3"
              onDoubleClick={() => {
                // 双击正文直接进入编辑（图片卡无文本编辑）
                if (!isImage && !activeEditing) {
                  useUIStore.getState().setPreviewEditing(true);
                }
              }}
            >
              {isImage ? (
                <div className="flex h-full items-center justify-center">
                  {imageUrl ? (
                    <motion.img
                      // 按 url 重挂载：↑↓ 切到别的图片卡时同样重播浮现
                      key={imageUrl}
                      initial={{ opacity: 0, scale: 0.97 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={springModal}
                      src={imageUrl}
                      alt="捕获的图片"
                      title="点击原尺寸预览"
                      onClick={() =>
                        note.imageFile &&
                        void api.quickLook(images, 0, {
                          id: note.id,
                          text: imageCaption(note),
                          dataGeneration: currentDataGeneration(),
                        })
                      }
                      className="max-h-full max-w-full cursor-zoom-in object-contain"
                    />
                  ) : (
                    <span className="text-body text-muted-foreground">加载中…</span>
                  )}
                </div>
              ) : activeEditing && orderedRich && note.contentBlocks ? (
                <RichNoteTextEditor
                  key={note.id}
                  blocks={draftBlocks}
                  onOpenImage={(files, index) => {
                    // 先结束文字编辑会话，避免图片独立保存后被旧草稿收尾覆盖。
                    save();
                    window.setTimeout(() => {
                      void api.quickLook(files, index, {
                        id: note.id,
                        text: note.text,
                        dataGeneration: currentDataGeneration(),
                      });
                    }, 0);
                  }}
                  onChange={setDraftBlocks}
                  onSave={save}
                  // 自动保存语义：Esc 退出编辑保留内容，收尾气泡可撤销
                  onCancel={save}
                />
              ) : activeEditing ? (
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
              ) : orderedRich && note.contentBlocks ? (
                <RichNoteContent
                  blocks={note.contentBlocks}
                  previewSource={imagePreviewSource}
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

              {!orderedRich && extraImages.length > 0 && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {extraImages.map((f) => (
                    <PreviewThumb
                      key={f}
                      files={images}
                      index={images.indexOf(f)}
                      previewSource={imagePreviewSource}
                      onRemove={() => removeImage(f)}
                    />
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
                {activeEditing ? (
                  <Button size="xs" onClick={save}>
                    <Check className="size-3" /> 保存
                    {/* token-exception: 9px 为重塑前原始尺寸，用户指定还原 */}
                    <Kbd inline className="text-[9px]">⌘⏎</Kbd>
                  </Button>
                ) : (
                  <>
                    {!orderedRich && isMd && (
                      <button
                        onClick={() => setMdView(!mdView)}
                        className="rounded-md px-1.5 py-0.5 text-micro text-muted-foreground outline-none hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background dark:hover:bg-white/10"
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
                        label={orderedRich ? "编辑文字（图片位置固定）" : "编辑"}
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
                      disabled={!canSend}
                      aria-label={
                        targetReady
                          ? "发送到当前目标"
                          : internalSendAvailable
                            ? "优先添加到当前卡片编辑器"
                          : profileChanged
                            ? "发送不可用：原临时发送方案已暂停"
                            : "发送不可用：发送目标未就绪"
                      }
                      onClick={() => {
                        useUIStore.getState().closePreview();
                        void sendNotesToChat([note.id]);
                      }}
                    >
                      <Send className="size-3" />
                      {internalSendAvailable ? "发送 / 添加" : "发送"}
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

/** 预览层里的附件图片（点击从该张起原尺寸预览，可 ←/→ 翻看全组；
 *  悬停右上角 ⊗ 从卡片移除该图）。 */
function PreviewThumb({
  files,
  index,
  previewSource,
  onRemove,
}: {
  files: string[];
  index: number;
  previewSource?: ImagePreviewSource;
  onRemove: () => void;
}) {
  const url = useNoteThumb(files[index]);
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={`原尺寸预览第 ${index + 1} 张图片`}
        title="点击原尺寸预览"
        onClick={() =>
          void api.quickLook(files, Math.max(0, index), previewSource)
        }
        className="flex w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-lg bg-black/[0.05] p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-white/[0.08]"
      >
        {url ? (
          <img src={url} alt="" className="max-h-40 max-w-full object-contain" />
        ) : (
          <span className="p-4 text-label text-muted-foreground">加载中…</span>
        )}
      </button>
      <IconButton
        label="从卡片移除这张图片"
        withTitle
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className={cn(
          "absolute right-1 top-1 bg-background/85 opacity-0 transition-opacity",
          "group-hover:opacity-100 focus-visible:opacity-100"
        )}
      >
        <X className="size-3" />
      </IconButton>
    </div>
  );
}
