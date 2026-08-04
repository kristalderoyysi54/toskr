import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  Copy,
  Expand,
  FolderInput,
  GripVertical,
  Inbox,
  ListOrdered,
  ListTodo,
  Merge,
  Pencil,
  PenLine,
  ExternalLink,
  Send,
  ScanText,
  Star,
  Trash2,
  Wand2,
} from "lucide-react";

import { tip } from "@/lib/tip";
import { IconButton } from "@/components/ui/icon-button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  convertNoteToTaskWithUndo,
  copyNotesAsList,
  deleteNotesWithUndo,
  mergeNoteWithChecked,
  sendNotesToChat,
  undoableTip,
} from "@/lib/actions";
import { TEXT_OPS, type TextOp } from "@/lib/textops";
import { langLabel } from "@/lib/code";
import { linkParts } from "@/lib/link";
import { useAppIcon } from "@/lib/icons";
import { timeAgo, useNoteThumb } from "@/lib/media";
import { splitHighlight } from "@/lib/search";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  CLIPBOARD_ID,
  INBOX_ID,
  noteImages,
  normalizeContextMenu,
  useNotesStore,
  type ContextMenuItemId,
  type Note,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 双击发送的第一击会塌掉多选：留档点击前的集合供 onDoubleClick 找回。 */
let lastMultiSelection: { ids: string[]; at: number } | null = null;

/** 组合卡并排缩略图（独立组件实例规避可变数量 hook；overlay 显示「+N」）。 */
function CardThumb({ file, overlay }: { file: string; overlay?: string }) {
  const url = useNoteThumb(file);
  return (
    <div className="relative flex h-full min-w-0 flex-1 items-center justify-center overflow-hidden rounded-sm bg-black/[0.04] dark:bg-white/[0.06]">
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-micro text-muted-foreground/60">…</span>
      )}
      {overlay && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-title font-medium text-white">
          {overlay}
        </span>
      )}
    </div>
  );
}

/**
 * 固定尺寸卡片瓷砖（Paste 风格）：统一高度、3 行截断展示；
 * 双击 = 直接发送到对话；完整内容与编辑通过预览层（Space / 放大按钮）。
 * memo：切页/勾选引发的父级重渲染不再波及未变化的卡片（大列表关键）。
 */
export const NoteCard = memo(function NoteCard({
  note,
  query = "",
}: {
  note: Note;
  query?: string;
}) {
  const checked = useNotesStore((s) => s.checkedIds.includes(note.id));
  const checkedCount = useNotesStore((s) => s.checkedIds.length);
  // 右键合并的目标集合 = 勾选项 ∪ 当前卡片
  const mergeCount = checked ? checkedCount : checkedCount + 1;
  const sections = useNotesStore((s) => s.sections);
  const focused = useUIStore((s) => s.focusedId === note.id);
  const flashing = useUIStore((s) => s.flashId === note.id);
  // ⌘ 按住时前 9 张卡显示 ⌘N 快发角标
  const quickSlot = useUIStore((s) => {
    if (!s.cmdHeld) return 0;
    const i = s.navIds.indexOf(note.id);
    return i >= 0 && i < 9 ? i + 1 : 0;
  });
  const { toggleChecked, toggleDone, toggleNoteKeep, moveNotes } =
    useNotesStore.getState();

  const cardRef = useRef<HTMLDivElement | null>(null);
  const icon = useAppIcon(note.sourceBundle);
  const cardTint = useNotesStore((s) => s.settings.cardTint);
  const cardOpacity = useNotesStore((s) => s.settings.cardOpacity);
  const compact = useNotesStore((s) => s.settings.cardDensity === "compact");
  const isImage = note.kind === "image";
  const isLink = note.kind === "link" && !!note.url;
  const images = noteImages(note);
  /** 组合卡片：既有正文又带图片附件 */
  const isComposite = !isImage && images.length > 0;
  const link = isLink ? linkParts(note.url!) : null;
  const imageUrl = useNoteThumb(isImage ? note.imageFile : undefined);
  const cardImages = isImage ? noteImages(note) : [];

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: note.id, disabled: note.done });

  // 键盘导航焦点滚动可见
  useEffect(() => {
    if (focused) {
      cardRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [focused]);

  const openPreview = (editing = false) => {
    // 链接卡「查看明细」= 直接打开网页；编辑仍走预览层编辑链接文本
    if (isLink && !editing) {
      void api.openUrl(note.url!);
      return;
    }
    // 图片卡「查看明细」= 系统 Quick Look 原尺寸预览（窄面板放不下大图）
    if (isImage && !editing && note.imageFile) {
      void api.quickLook(noteImages(note));
      return;
    }
    useUIStore.getState().openPreview(note.id, editing);
  };

  // 文本卡正文可直接拖出到外部应用输入框（WKWebView 原生桥接系统拖拽）；
  // onPointerDown 阻断冒泡：抓文字=拖出文本，抓卡片其余部分（含图片/链接区）=拖拽排序
  const dragOutProps =
    !isImage && !isLink
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData("text/plain", note.text);
            e.dataTransfer.effectAllowed = "copy" as const;
          },
          onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        }
      : {};

  // 只订阅稳定引用，派生数组用 useMemo——选择器里 new 数组会造成
  // getSnapshot 永不相等 → React 无限重渲染崩溃（主窗口白屏、面板无法唤起）
  const menuCfgRaw = useNotesStore((s) => s.settings.contextMenu);
  const menuIds = useMemo(
    () =>
      normalizeContextMenu(menuCfgRaw)
        .filter((i) => i.on)
        .map((i) => i.id),
    [menuCfgRaw]
  );

  /** 右键菜单中段：按配置顺序渲染，卡片类型不适用返回 null。 */
  const renderMenuItem = (id: ContextMenuItemId): React.ReactNode => {
    switch (id) {
      case "preview":
        if (isLink) {
          return (
            <ContextMenuItem key={id} onClick={() => void api.openUrl(note.url!)}>
              <ExternalLink className="size-3.5" /> 打开链接
            </ContextMenuItem>
          );
        }
        if (isImage && note.imageFile) {
          return (
            <ContextMenuItem key={id} onClick={() => openPreview()}>
              <Expand className="size-3.5" /> 原尺寸预览
            </ContextMenuItem>
          );
        }
        return (
          <ContextMenuItem key={id} onClick={() => openPreview()}>
            <Expand className="size-3.5" /> 预览
          </ContextMenuItem>
        );
      case "textops":
        if (isImage || isLink) return null;
        return (
          <ContextMenuSub key={id}>
            <ContextMenuSubTrigger>
              <Wand2 className="mr-2 size-3.5" /> 文本处理
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-36">
              {TEXT_OPS.map((tOp) => (
                <ContextMenuItem key={tOp.id} onClick={() => applyTextOp(tOp)}>
                  {tOp.label}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        );
      case "send":
        return (
          <ContextMenuItem key={id} onClick={() => sendNotesToChat([note.id])}>
            <Send className="size-3.5" /> 发送到对话
          </ContextMenuItem>
        );
      case "copy":
        return (
          <ContextMenuItem key={id} onClick={copyOne}>
            <Copy className="size-3.5" /> 复制内容
          </ContextMenuItem>
        );
      case "copy-list":
        return (
          <ContextMenuItem key={id} onClick={() => void copyWithChecked()}>
            <ListOrdered className="size-3.5" /> 复制为列表
          </ContextMenuItem>
        );
      case "edit":
        if (isImage) return null;
        return (
          <ContextMenuItem key={id} onClick={() => openPreview(true)}>
            <Pencil className="size-3.5" /> 编辑
          </ContextMenuItem>
        );
      case "ocr":
        if (!isImage || !note.imageFile) return null;
        return (
          <ContextMenuItem key={id} onClick={() => void runOcr()}>
            <ScanText className="size-3.5" /> 识别文字 (OCR)
          </ContextMenuItem>
        );
      case "done":
        return (
          <ContextMenuItem key={id} onClick={() => toggleDone(note.id)}>
            <Check className="size-3.5" /> {note.done ? "取消完成" : "标记完成"}
          </ContextMenuItem>
        );
      case "keep":
        return (
          <ContextMenuItem key={id} onClick={() => toggleNoteKeep(note.id)}>
            <Star className={cn("size-3.5", note.keep && "fill-current")} />{" "}
            {isClip
              ? note.keep
                ? "取消固定"
                : "固定 · 不被清理"
              : note.keep
                ? "取消常用"
                : "设为常用 · 发送后保留"}
          </ContextMenuItem>
        );
      case "rename":
        return (
          <ContextMenuItem key={id} onClick={startRename}>
            <PenLine className="size-3.5" /> 重命名
          </ContextMenuItem>
        );
      case "to-task":
        // 任务没有图片语义：图片卡/图文组合卡不提供转换
        if (isImage || isComposite) return null;
        return (
          <ContextMenuItem key={id} onClick={() => convertNoteToTaskWithUndo(note.id)}>
            <ListTodo className="size-3.5" /> 转为任务
          </ContextMenuItem>
        );
      case "move":
        if (sections.length <= 1) return null;
        return (
          <ContextMenuSub key={id}>
            <ContextMenuSubTrigger>
              <FolderInput className="mr-2 size-3.5" /> 移动到
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-36">
              {sections
                // 剪贴板是自动流水分组，不作为移动目标
                .filter((s) => s.id !== note.sectionId && s.id !== CLIPBOARD_ID)
                .map((s) => (
                  <ContextMenuItem key={s.id} onClick={() => moveNotes([note.id], s.id)}>
                    {s.name}
                  </ContextMenuItem>
                ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        );
    }
  };

  /** 复制为列表：勾选项 ∪ 当前卡（与右键合并同一语义）。 */
  const copyWithChecked = () => {
    const checkedNow = useNotesStore.getState().checkedIds;
    const pick = new Set([...checkedNow, note.id]);
    const ids = useNotesStore
      .getState()
      .notes.filter((n) => pick.has(n.id))
      .map((n) => n.id);
    return copyNotesAsList(ids);
  };

  const runOcr = async () => {
    if (!note.imageFile) return;
    tip("info", "正在识别文字…");
    try {
      const text = await api.ocrImage(note.imageFile);
      const { result, id } = useNotesStore.getState().addNote(text, {
        sectionId: note.sectionId,
        sourceApp: note.sourceApp,
        sourceBundle: note.sourceBundle,
      });
      if (result === "added" && id) {
        useUIStore.getState().setFlashId(id);
        tip("ok", "已识别为新卡片");
      } else if (result === "duplicate") {
        tip("duplicate", "");
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes("未识别到文字")) tip("info", "未识别到文字");
      else tip("warn", `识别失败：${msg}`);
    }
  };

  const applyTextOp = (textOp: TextOp) => {
    try {
      const next = textOp.apply(note.text);
      if (next === note.text) {
        tip("info", "内容无变化");
        return;
      }
      useNotesStore.getState().snapshot(`文本处理：${textOp.label}`);
      useNotesStore.getState().updateNoteText(note.id, next);
      undoableTip(`已处理 · ${textOp.label}`);
    } catch {
      tip("warn", `${textOp.label}失败：内容不符合格式`);
    }
  };

  const copyOne = async () => {
    try {
      await api.copyText(note.text);
      tip("ok", "已复制");
    } catch (e) {
      tip("warn", `复制失败：${e}`);
    }
  };

  const segments = splitHighlight(note.text, query);

  /** 通栏类型标签（无自定义标题时显示）。 */
  const typeLabel = isImage
    ? images.length > 1
      ? `图片 ×${images.length}`
      : "图片"
    : isComposite
      ? `图文 ×${images.length + 1}`
      : isLink
        ? "链接"
        : note.codeLang
          ? langLabel(note.codeLang)
          : "文本";

  // 重命名（点击通栏类型区 / 右键「重命名」）：行内编辑自定义标题
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const startRename = () => {
    setTitleDraft(note.title ?? "");
    setRenaming(true);
  };
  const commitRename = () => {
    useNotesStore.getState().updateNoteTitle(note.id, titleDraft);
    setRenaming(false);
  };

  /** 剪贴板历史卡：右键语义变化（固定/保存为笔记）。 */
  const isClip = note.sectionId === CLIPBOARD_ID;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={(el) => {
            setNodeRef(el);
            cardRef.current = el;
          }}
          style={{
            transform: CSS.Transform.toString(transform),
            transition,
            "--card-alpha": `${Math.round(cardOpacity * 100)}%`,
          } as React.CSSProperties}
          // 整卡可抓拖拽排序（4px 激活阈值不影响点击/双击）；键盘拾取仍走下方把手，
          // 避免 Tab 到悬浮操作按钮时 Space/Enter 被 dnd-kit 抢走
          onPointerDown={(e) => listeners?.onPointerDown?.(e)}
          onClick={(e) => {
            const ui = useUIStore.getState();
            if (e.shiftKey && ui.anchorId && ui.anchorId !== note.id) {
              // Shift 范围选中：锚点 → 当前卡之间全部勾选（Finder/Paste 同款）
              const ids = ui.navIds;
              const from = ids.indexOf(ui.anchorId);
              const to = ids.indexOf(note.id);
              if (from >= 0 && to >= 0) {
                const [lo, hi] = from < to ? [from, to] : [to, from];
                const range = ids.slice(lo, hi + 1);
                const merged = new Set([
                  ...useNotesStore.getState().checkedIds,
                  ...range,
                ]);
                useNotesStore.getState().setChecked([...merged]);
                ui.setFocusedId(note.id);
                return;
              }
            }
            ui.setFocusedId(note.id);
            ui.setAnchorId(note.id);
            const checkedNow = useNotesStore.getState().checkedIds;
            // 双击发送前的第一击会把多选塌成单选：先留档，供 onDoubleClick
            // 找回「点击前的多选集合」整组发送
            if (checkedNow.length >= 2 && checkedNow.includes(note.id)) {
              lastMultiSelection = { ids: checkedNow, at: Date.now() };
            }
            if (e.metaKey) {
              // ⌘+点击：累加/移出多选（Finder 式）
              toggleChecked(note.id);
            } else if (checkedNow.length === 1 && checkedNow[0] === note.id) {
              // 单击唯一已选的这张：取消选择
              useNotesStore.getState().clearChecked();
            } else {
              // 单击：单选（替换现有选择）
              useNotesStore.getState().setChecked([note.id]);
            }
          }}
          onDoubleClick={() => {
            // 双击在多选集合内的卡：发送整个集合（第一击已塌选，从留档找回）
            const stash = lastMultiSelection;
            lastMultiSelection = null;
            if (stash && Date.now() - stash.at < 600 && stash.ids.includes(note.id)) {
              void sendNotesToChat(stash.ids);
            } else {
              void sendNotesToChat([note.id]);
            }
          }}
          className={cn(
            "group relative flex cursor-default select-none overflow-hidden rounded-lg border border-transparent",
            compact ? "h-9 items-center" : "h-[136px] flex-col px-2 pb-1.5 pt-1.5",
            // 实色卡片（Paste 风格）：与毛玻璃面板分层；透明度由设置项调节
            "bg-[rgb(255_255_255/var(--card-alpha,100%))] shadow-sm dark:bg-[rgb(39_39_42/var(--card-alpha,100%))]",
            "hover:border-black/10 dark:hover:border-white/10",
            // 舒适密度的悬浮微升：位移只作用于卡片刚体（内部图标区相对位置不变）；
            // reduced-motion 下 transition 被全局压到 0.01ms，等效"去位移保影子"
            !compact &&
              "transition-[transform,box-shadow] duration-150 hover:-translate-y-px hover:elevation-2",
            // 无勾选框设计：选中态 = 淡填色 + primary 边框（+ 舒适密度抬升）——
            // 与键盘焦点的中性细环用"形状"区分，不只靠色（左缘条方案已被用户否决）
            checked && (compact ? "ring-1 ring-primary/30" : "border-primary/40 elevation-2"),
            focused && !checked && "ring-1 ring-foreground/20",
            flashing && "flash-highlight",
            isDragging && "z-10 opacity-70 elevation-3"
          )}
        >
          {checked && (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-0",
                compact
                  ? "bg-primary/[0.08] dark:bg-primary/[0.14]"
                  : "bg-primary/[0.06] dark:bg-primary/[0.1]"
              )}
            />
          )}
          <button
            {...attributes}
            onKeyDown={(e) => listeners?.onKeyDown?.(e)}
            onClick={(e) => e.stopPropagation()}
            aria-label="拖拽排序（Space 拾起，方向键移动）"
            className={cn(
              "absolute -left-4 top-1/2 -translate-y-1/2 cursor-grab touch-none p-0.5",
              "text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100",
              "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
              "active:cursor-grabbing",
              note.done && "hidden"
            )}
          >
            <GripVertical className="size-3.5" />
          </button>

          {quickSlot > 0 && (
            <span
              className={cn(
                "absolute left-1 z-10 flex h-4 min-w-4 items-center justify-center rounded-sm bg-black/70 px-1 text-micro font-semibold tabular-nums text-white dark:bg-white/80 dark:text-black",
                compact ? "top-1/2 -translate-y-1/2" : "top-1"
              )}
            >
              ⌘{quickSlot}
            </span>
          )}
          {compact ? (
            <div className="flex h-full w-full min-w-0">
              <CompactRow
                note={note}
                icon={icon}
                query={query}
                imageUrl={imageUrl}
                dragOutProps={dragOutProps}
              />
            </div>
          ) : (
            <>
          {/* 顶部通栏：应用主色底 + 类型/时间（白字）+ 右端完整应用图标 */}
          <div
            className="-mx-2 -mt-1.5 mb-1.5 flex h-9 shrink-0 items-center gap-1.5 rounded-t-lg px-2"
            style={{ backgroundColor: (cardTint && icon?.color) || "#5b5b60" }}
          >
            <div className="min-w-0 flex-1 leading-tight">
              {renaming ? (
                <input
                  autoFocus
                  value={titleDraft}
                  placeholder={typeLabel}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) commitRename();
                    if (e.key === "Escape") setRenaming(false);
                  }}
                  className="w-full bg-transparent text-label font-semibold text-white outline-none placeholder:text-white/50"
                />
              ) : (
                <p
                  title="点击重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename();
                  }}
                  className="cursor-text truncate text-label font-semibold text-white"
                >
                  {note.title ?? typeLabel}
                </p>
              )}
              <p className="truncate text-micro text-white/70">
                {timeAgo(note.createdAt)}
              </p>
            </div>
            {note.keep && (
              <Star className="size-3 shrink-0 fill-white/90 text-white/90" />
            )}
            {icon && (
              // 应用图标嵌入通栏右端（Paste 风格）：左缘完整可见，
              // 上/右/下被通栏边缘裁去少许——左对齐 + 垂直居中的大图标
              <span className="-mr-2 flex h-9 w-11 shrink-0 items-center justify-start overflow-hidden">
                <img src={icon.url} alt="" className="size-[52px] max-w-none" />
              </span>
            )}
          </div>

          <div className="flex min-h-0 flex-1 items-start overflow-hidden">
            {isLink ? (
              <div className="flex w-full flex-col justify-center gap-0.5">
                <div className="flex items-start gap-1.5">
                  {note.linkIcon && <LinkFavicon src={note.linkIcon} />}
                  <p className="line-clamp-2 text-title font-semibold leading-tight [overflow-wrap:anywhere]">
                    {note.linkTitle ?? link!.host}
                  </p>
                </div>
                <p className="line-clamp-2 text-label leading-tight text-muted-foreground [overflow-wrap:anywhere]">
                  {note.linkTitle
                    ? link!.host + (link!.path === "/" ? "" : link!.path)
                    : link!.path}
                </p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.openUrl(note.url!);
                  }}
                  className="mt-1 flex w-fit items-center gap-1 rounded-md bg-black/[0.06] px-1.5 py-0.5 text-micro text-muted-foreground hover:text-foreground dark:bg-white/10"
                >
                  <ExternalLink className="size-2.5" /> 打开链接
                </button>
              </div>
            ) : isImage ? (
              cardImages.length > 1 ? (
                // 组合卡：并排缩略最多 3 张，更多以「+N」标示
                <div className="flex h-full w-full gap-1">
                  {cardImages.slice(0, 3).map((f, i) => (
                    <CardThumb
                      key={f}
                      file={f}
                      overlay={
                        i === 2 && cardImages.length > 3
                          ? `+${cardImages.length - 3}`
                          : undefined
                      }
                    />
                  ))}
                </div>
              ) : (
                <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-sm bg-black/[0.04] dark:bg-white/[0.06]">
                  {imageUrl ? (
                    <img
                      src={imageUrl}
                      alt="捕获的图片"
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-micro text-muted-foreground/60">加载中…</span>
                  )}
                </div>
              )
            ) : (
              <p
                {...dragOutProps}
                className={cn(
                  // hover:cursor-grab：正文可拖出到外部应用的唯一可见暗示
                  "line-clamp-3 whitespace-pre-wrap text-body leading-normal [overflow-wrap:anywhere] hover:cursor-grab",
                  note.codeLang && "font-mono text-label",
                  note.done && "text-muted-foreground line-through opacity-60"
                )}
              >
                {segments.map((seg, i) =>
                  seg.hit ? (
                    <mark
                      key={i}
                      className="rounded-[2px] bg-amber-300/60 text-inherit dark:bg-amber-500/40"
                    >
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  )
                )}
              </p>
            )}
          </div>

          {isComposite && (
            <div className="mb-1 flex shrink-0 gap-1 overflow-hidden">
              {images.slice(0, 4).map((f) => (
                <Thumb key={f} file={f} />
              ))}
              {images.length > 4 && (
                <span className="self-center text-micro text-muted-foreground/60">
                  +{images.length - 4}
                </span>
              )}
            </div>
          )}

          <div className="flex h-4 shrink-0 items-center gap-1 text-micro text-muted-foreground/70">
            {note.sourceApp ? <span className="truncate">来自 {note.sourceApp}</span> : <span />}
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/50">
              {isImage && note.imageW
                ? `${note.imageW} × ${note.imageH}`
                : isLink
                  ? "链接"
                  : isComposite
                    ? `${[...note.text].length} 字符 · ${images.length} 图`
                    : `${[...note.text].length} 字符`}
            </span>
          </div>
            </>
          )}

          {/* 悬停操作钮：hover/键盘焦点显现（opacity 方案，Tab 可达） */}
          <div
            className={cn(
              "absolute flex gap-0.5",
              compact ? "right-1 top-1/2 -translate-y-1/2" : "bottom-1 right-1.5"
            )}
          >
            <IconButton
              label={isLink ? "打开页面（Space）" : "预览（Space）"}
              surface
              reveal="hover-focus"
              onClick={() => openPreview()}
            >
              {isLink ? (
                <ExternalLink className="size-3" />
              ) : (
                <Expand className="size-3" />
              )}
            </IconButton>
            {!isImage && (
              <IconButton label="编辑" surface reveal="hover-focus" onClick={() => openPreview(true)}>
                <Pencil className="size-3" />
              </IconButton>
            )}
            <IconButton
              label="删除"
              surface
              reveal="hover-focus"
              tone="danger"
              onClick={() => deleteNotesWithUndo([note.id], "已删除 1 条")}
            >
              <Trash2 className="size-3" />
            </IconButton>
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-44">
        {/* 多选场景的核心意图是合并，固定置顶（不参与自定义） */}
        {mergeCount >= 2 && (
          <ContextMenuItem onClick={() => mergeNoteWithChecked(note.id)}>
            <Merge className="size-3.5" /> 合并笔记 ×{mergeCount}
          </ContextMenuItem>
        )}
        {/* 剪贴板历史卡的转正主路径：搬去收件箱成为正式笔记 */}
        {isClip && (
          <ContextMenuItem
            onClick={() => {
              moveNotes([note.id], INBOX_ID);
              tip("ok", "已保存为笔记");
            }}
          >
            <Inbox className="size-3.5" /> 保存为笔记
          </ContextMenuItem>
        )}
        {/* 中段按设置项的显隐与顺序渲染；卡片类型不适用的项自动跳过 */}
        {menuIds.map((id) => renderMenuItem(id))}
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() => deleteNotesWithUndo([note.id], "已删除 1 条")}
        >
          <Trash2 className="size-3.5" /> 删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** 站点图标：加载失败自动隐藏（favicon 缺失/防盗链很常见）。 */
/** 紧凑单行布局：主色左条 + 图标 + 首行内容 + 时间（交互全部由外层卡片承担）。 */
function CompactRow({
  note,
  icon,
  query,
  imageUrl,
  dragOutProps,
}: {
  note: Note;
  icon: ReturnType<typeof useAppIcon>;
  query: string;
  imageUrl?: string | null;
  /** 仅文本卡非空：拖出文本到外部应用 + 阻断冒泡（见 NoteCard 同名变量注释）。 */
  dragOutProps: React.HTMLAttributes<HTMLParagraphElement>;
}) {
  const cardTint = useNotesStore((s) => s.settings.cardTint);
  const isImage = note.kind === "image";
  const isLink = note.kind === "link" && !!note.url;
  const images = noteImages(note);
  const link = isLink ? linkParts(note.url!) : null;
  const firstLine = isImage
    ? images.length > 1
      ? `图片 ×${images.length}`
      : `图片${note.imageW ? ` ${note.imageW}×${note.imageH}` : ""}`
    : isLink
      ? (note.linkTitle ?? link!.host + (link!.path === "/" ? "" : link!.path))
      : note.text.split("\n")[0] || "（空）";
  const segments = splitHighlight(firstLine, query);
  return (
    <div className="relative flex h-full w-full min-w-0 items-center gap-2 pl-2.5 pr-2">
      {/* 左缘应用主色条（替代舒适模式的彩色通栏） */}
      <span
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundColor: (cardTint && icon?.color) || "#5b5b60" }}
      />
      {isLink && note.linkIcon ? (
        <LinkFavicon src={note.linkIcon} />
      ) : icon ? (
        <img src={icon.url} alt="" className="size-5 shrink-0" />
      ) : null}
      {isImage &&
        (imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            className="size-6 shrink-0 rounded-sm object-cover"
          />
        ) : (
          // 缩略图解码中的骨架占位：同尺寸脉冲块，杜绝"空洞"
          <span className="size-6 shrink-0 animate-pulse rounded-sm bg-black/[0.06] dark:bg-white/[0.08]" />
        ))}
      <p
        {...dragOutProps}
        className={cn(
          "min-w-0 flex-1 truncate text-body hover:cursor-grab",
          note.codeLang && "font-mono text-label",
          note.done && "text-muted-foreground line-through opacity-60"
        )}
      >
        {segments.map((seg, i) =>
          seg.hit ? (
            <mark
              key={i}
              className="rounded-[2px] bg-amber-300/60 text-inherit dark:bg-amber-500/40"
            >
              {seg.text}
            </mark>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
      </p>
      {/* 尾部元数据在 hover 时淡出，给悬浮操作钮让位（原先是图标直接压在时间上打架） */}
      {note.keep && (
        <Star className="size-3 shrink-0 fill-amber-400 text-amber-400 transition-opacity group-hover:opacity-0" />
      )}
      {!isImage && images.length > 0 && (
        <span className="shrink-0 text-micro text-muted-foreground/60 transition-opacity group-hover:opacity-0">
          {images.length}图
        </span>
      )}
      <span className="shrink-0 text-micro tabular-nums text-muted-foreground/50 transition-opacity group-hover:opacity-0">
        {timeAgo(note.createdAt)}
      </span>
    </div>
  );
}

function LinkFavicon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={src}
      alt=""
      onError={() => setFailed(true)}
      className="mt-px size-4 shrink-0 rounded-sm"
    />
  );
}

/** 组合卡片里的小缩略图。 */
function Thumb({ file }: { file: string }) {
  const url = useNoteThumb(file);
  return (
    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-black/[0.05] dark:bg-white/[0.08]">
      {url && <img src={url} alt="" className="max-h-full max-w-full object-contain" />}
    </span>
  );
}

