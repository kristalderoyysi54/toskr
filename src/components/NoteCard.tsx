import { useEffect, useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  Copy,
  Expand,
  FolderInput,
  GripVertical,
  Merge,
  Pencil,
  ExternalLink,
  Send,
  Trash2,
} from "lucide-react";

import { tip } from "@/lib/tip";
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
import { deleteNotesWithUndo, mergeNoteWithChecked, sendNotesToChat } from "@/lib/actions";
import { langLabel } from "@/lib/code";
import { linkParts } from "@/lib/link";
import { useAppIcon } from "@/lib/icons";
import { timeAgo, useNoteImage } from "@/lib/media";
import { splitHighlight } from "@/lib/search";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { noteImages, useNotesStore, type Note } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/**
 * 固定尺寸卡片瓷砖（Paste 风格）：统一高度、3 行截断展示；
 * 完整内容与编辑通过预览层（Space / 双击 / 放大按钮）。
 */
export function NoteCard({ note, query = "" }: { note: Note; query?: string }) {
  const checked = useNotesStore((s) => s.checkedIds.includes(note.id));
  const checkedCount = useNotesStore((s) => s.checkedIds.length);
  // 右键合并的目标集合 = 勾选项 ∪ 当前卡片
  const mergeCount = checked ? checkedCount : checkedCount + 1;
  const sections = useNotesStore((s) => s.sections);
  const focused = useUIStore((s) => s.focusedId === note.id);
  const flashing = useUIStore((s) => s.flashId === note.id);
  const { toggleChecked, toggleDone, moveNotes } = useNotesStore.getState();

  const cardRef = useRef<HTMLDivElement | null>(null);
  const icon = useAppIcon(note.sourceBundle);
  const cardTint = useNotesStore((s) => s.settings.cardTint);
  const isImage = note.kind === "image";
  const isLink = note.kind === "link" && !!note.url;
  const images = noteImages(note);
  /** 组合卡片：既有正文又带图片附件 */
  const isComposite = !isImage && images.length > 0;
  const link = isLink ? linkParts(note.url!) : null;
  const imageUrl = useNoteImage(isImage ? note.imageFile : undefined);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: note.id, disabled: note.done });

  // 键盘导航焦点滚动可见
  useEffect(() => {
    if (focused) {
      cardRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [focused]);

  const openPreview = (editing = false) =>
    useUIStore.getState().openPreview(note.id, editing);

  const copyOne = async () => {
    try {
      await api.copyText(note.text);
      tip("ok", "已复制");
    } catch (e) {
      tip("warn", `复制失败：${e}`);
    }
  };

  const segments = splitHighlight(note.text, query);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={(el) => {
            setNodeRef(el);
            cardRef.current = el;
          }}
          style={{ transform: CSS.Transform.toString(transform), transition }}
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
            if (checkedNow.includes(note.id) && checkedNow.length > 1) {
              // 多选中点击已选卡片：收拢为仅选中这张（Finder 式）
              useNotesStore.getState().setChecked([note.id]);
            } else {
              toggleChecked(note.id);
            }
          }}
          onDoubleClick={() => openPreview()}
          className={cn(
            "group relative flex h-[136px] cursor-default select-none flex-col overflow-hidden rounded-lg border border-transparent px-2 pb-1.5 pt-1.5",
            "bg-black/[0.03] dark:bg-white/[0.05]",
            "hover:border-black/10 dark:hover:border-white/10",
            // 无勾选框设计：选中态用蓝色边框 + 淡蓝底标识（primary 深色下近白，不用）
            checked && "border-blue-500 ring-2 ring-blue-500 bg-blue-500/[0.08] dark:bg-blue-500/[0.14]",
            // 键盘焦点：中性淡描边，与蓝色选中态区分
            focused && "ring-1 ring-black/20 dark:ring-white/25",
            flashing && "flash-highlight",
            isDragging && "z-10 opacity-70 shadow-lg"
          )}
        >
          <button
            {...attributes}
            {...listeners}
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

          {/* 顶部通栏：应用主色底 + 类型/时间（白字）+ 右端完整应用图标 */}
          <div
            className="-mx-2 -mt-1.5 mb-1.5 flex h-9 shrink-0 items-center gap-1.5 rounded-t-lg px-2"
            style={{ backgroundColor: (cardTint && icon?.color) || "#5b5b60" }}
          >
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[11px] font-semibold text-white">
                {isImage
                  ? images.length > 1
                    ? `图片 ×${images.length}`
                    : "图片"
                  : isComposite
                    ? `图文 ×${images.length + 1}`
                    : isLink
                      ? "链接"
                    : note.codeLang
                      ? langLabel(note.codeLang)
                      : "文本"}
              </p>
              <p className="truncate text-[10px] text-white/70">
                {timeAgo(note.createdAt)}
              </p>
            </div>
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
                <p className="line-clamp-2 text-[13px] font-semibold leading-tight [overflow-wrap:anywhere]">
                  {link!.host}
                </p>
                <p className="line-clamp-2 text-[11px] leading-tight text-muted-foreground [overflow-wrap:anywhere]">
                  {link!.path}
                </p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.openUrl(note.url!);
                  }}
                  className="mt-1 flex w-fit items-center gap-1 rounded-md bg-black/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground dark:bg-white/10"
                >
                  <ExternalLink className="size-2.5" /> 打开链接
                </button>
              </div>
            ) : isImage ? (
              <div className="flex h-full w-full items-center justify-center overflow-hidden rounded bg-black/[0.04] dark:bg-white/[0.06]">
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt="捕获的图片"
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <span className="text-[10px] text-muted-foreground/60">加载中…</span>
                )}
              </div>
            ) : (
              <p
                className={cn(
                  "line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere] text-[12.5px] leading-[1.5]",
                  note.codeLang && "font-mono text-[11.5px]",
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
                <span className="self-center text-[10px] text-muted-foreground/60">
                  +{images.length - 4}
                </span>
              )}
            </div>
          )}

          <div className="flex h-4 shrink-0 items-center gap-1 text-[10px] text-muted-foreground/70">
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

          {/* 悬停操作钮：右下角盖在字符数元信息上，避开正文内容 */}
          <div className="absolute bottom-1 right-1.5 hidden gap-0.5 group-hover:flex">
            <IconButton label="预览（Space）" onClick={() => openPreview()}>
              <Expand className="size-3" />
            </IconButton>
            {!isImage && (
              <IconButton label="编辑" onClick={() => openPreview(true)}>
                <Pencil className="size-3" />
              </IconButton>
            )}
            <IconButton
              label="删除"
              onClick={() => deleteNotesWithUndo([note.id], "已删除 1 条")}
            >
              <Trash2 className="size-3" />
            </IconButton>
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-44">
        {isLink && (
          <ContextMenuItem onClick={() => void api.openUrl(note.url!)}>
            <ExternalLink className="size-3.5" /> 打开链接
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => openPreview()}>
          <Expand className="size-3.5" /> 预览
        </ContextMenuItem>
        <ContextMenuItem onClick={() => sendNotesToChat([note.id])}>
          <Send className="size-3.5" /> 发送到对话
        </ContextMenuItem>
        <ContextMenuItem onClick={copyOne}>
          <Copy className="size-3.5" /> 复制内容
        </ContextMenuItem>
        {!isImage && (
          <ContextMenuItem onClick={() => openPreview(true)}>
            <Pencil className="size-3.5" /> 编辑
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => toggleDone(note.id)}>
          <Check className="size-3.5" /> {note.done ? "取消完成" : "标记完成"}
        </ContextMenuItem>
        {mergeCount >= 2 && (
          <ContextMenuItem onClick={() => mergeNoteWithChecked(note.id)}>
            <Merge className="size-3.5" /> 合并笔记 ×{mergeCount}
          </ContextMenuItem>
        )}
        {sections.length > 1 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FolderInput className="mr-2 size-3.5" /> 移动到
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-36">
              {sections
                .filter((s) => s.id !== note.sectionId)
                .map((s) => (
                  <ContextMenuItem key={s.id} onClick={() => moveNotes([note.id], s.id)}>
                    {s.name}
                  </ContextMenuItem>
                ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
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
}

/** 组合卡片里的小缩略图。 */
function Thumb({ file }: { file: string }) {
  const url = useNoteImage(file);
  return (
    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded bg-black/[0.05] dark:bg-white/[0.08]">
      {url && <img src={url} alt="" className="max-h-full max-w-full object-contain" />}
    </span>
  );
}

function IconButton({
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
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "rounded-md border border-black/5 bg-white/95 p-1 text-muted-foreground shadow-sm",
        "hover:text-foreground dark:border-white/10 dark:bg-zinc-800/95"
      )}
    >
      {children}
    </button>
  );
}
