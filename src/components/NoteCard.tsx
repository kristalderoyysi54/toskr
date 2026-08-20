import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  Copy,
  Expand,
  FileText,
  FolderInput,
  GripVertical,
  Inbox,
  ListChecks,
  ListOrdered,
  ListTodo,
  Link2,
  Merge,
  Pencil,
  PenLine,
  Pin,
  ExternalLink,
  Send,
  ScanText,
  ShieldCheck,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Unlink,
  VenetianMask,
  Wand2,
} from "lucide-react";

import { activeAliasOccurrences } from "@/lib/delivery/aliasEntities";
import { mapNoteTextBlocks } from "@/lib/noteContentBlocks";
import { imageCaption, imageListLabel } from "@/lib/format";
import { tip } from "@/lib/tip";
import { IconButton } from "@/components/ui/icon-button";
import { TargetSendMenuItem } from "@/components/TargetSendMenuItem";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  convertNoteToTaskWithUndo,
  copyNoteContent,
  copyNotesAsList,
  deleteNotesWithUndo,
  mergeNoteWithChecked,
  moveClipsToNotesWithUndo,
  openNoteDetail,
  restoreNoteAliasesWithUndo,
  sendNotesToChat,
  undoableTip,
} from "@/lib/actions";
import { currentTargetProfileResolution } from "@/lib/currentTargetProfile";
import { promptSnippetsForGroup } from "@/lib/targetProfiles";
import { TEXT_OPS, type TextOp } from "@/lib/textops";
import { highlightCode, langLabel } from "@/lib/code";
import { linkParts } from "@/lib/link";
import { useAppIcon } from "@/lib/icons";
import { isMonoLike, splitMiddle } from "@/lib/cliprow";
import { shouldScrollFocusedCard } from "@/lib/cardFocus";
import { noteTimeLabel, useNoteThumb } from "@/lib/media";
import { noteToTaskSmart, suggestTitle } from "@/lib/ai";
import { splitHighlight } from "@/lib/search";
import {
  beginDataGenerationLease,
  currentDataGeneration,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  CLIPBOARD_ID,
  groupContextMenuIds,
  NOTE_TAG_MAX_COUNT,
  noteContentBlocks,
  noteImages,
  normalizeContextMenu,
  orderedCheckedNotes,
  sanitizeNoteTags,
  useNotesStore,
  type ContextMenuItemId,
  type Note,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import {
  deliveryRedactionMapAvailable,
  requestPlaceholderPreview,
  requestResultLinkForNote,
  requestResultUnlink,
} from "@/lib/resultReturn";
import { requestResultVerification } from "@/lib/resultVerification";

/** 双击发送的第一击会塌掉多选：留档点击前的集合供 onDoubleClick 找回。 */
let lastMultiSelection: { ids: string[]; at: number } | null = null;

/**
 * 卡顶通栏底色：应用主色的轻微对角渐变（左上亮 → 右下暗各偏 ~8%），
 * 两端都吃 --card-alpha（设置 → 卡片透明度；无该变量的环境退回不透明）。
 */
export function headerGradient(color: string): string {
  const withAlpha = (c: string) =>
    `color-mix(in srgb, ${c} var(--card-alpha, 100%), transparent)`;
  return `linear-gradient(135deg, ${withAlpha(
    `color-mix(in srgb, ${color} 86%, white)`
  )}, ${withAlpha(`color-mix(in srgb, ${color} 92%, black)`)})`;
}

/** 组合卡并排缩略图（独立组件实例规避可变数量 hook；overlay 显示「+N」）。 */
function CardThumb({ file, overlay }: { file: string; overlay?: string }) {
  const url = useNoteThumb(file);
  return (
    <div className="relative flex h-full min-w-0 flex-1 items-center justify-center overflow-hidden rounded-sm bg-black/[0.04] dark:bg-white/[0.06]">
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-micro text-muted-foreground">…</span>
      )}
      {overlay && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-title font-medium text-white">
          {overlay}
        </span>
      )}
    </div>
  );
}

/** 卡片单行摘要：图片=「图片 ×N」标签，链接=标题或 host+路径，文本=首行。 */
function noteFirstLine(note: Note): string {
  if (note.kind === "image") return imageListLabel(note, noteImages(note).length);
  if (note.kind === "link" && note.url) {
    const link = linkParts(note.url);
    return note.linkTitle ?? link.host + (link.path === "/" ? "" : link.path);
  }
  return note.text.split("\n")[0] || "（空）";
}

/**
 * 固定尺寸卡片瓷砖（Paste 风格）：统一高度、3 行截断展示；
 * 双击 = 直接发送到对话；完整内容与编辑通过预览层（Space / 放大按钮）。
 * memo：切页/勾选引发的父级重渲染不再波及未变化的卡片（大列表关键）。
 */
export const NoteCard = memo(function NoteCard({
  note,
  query = "",
  strip = false,
  prevId,
  nextId,
}: {
  note: Note;
  query?: string;
  /** 横栏卡片串形态（上/下边栏）：固定宽方形卡、随栏高伸展。 */
  strip?: boolean;
  /** 渲染序上的相邻卡 id（仅剪贴纵向流水传入）：相邻同选时合并选中描边。 */
  prevId?: string;
  nextId?: string;
}) {
  const checked = useNotesStore((s) => s.checkedIds.includes(note.id));
  // 紧缩流水行的连续选中段合并成一个选区块（描边/圆角在相接边断开）
  const prevChecked = useNotesStore(
    (s) => !!prevId && s.checkedIds.includes(prevId)
  );
  const nextChecked = useNotesStore(
    (s) => !!nextId && s.checkedIds.includes(nextId)
  );
  const joinPrev = checked && prevChecked;
  const joinNext = checked && nextChecked;
  const checkedCount = useNotesStore((s) => s.checkedIds.length);
  // 右键合并的目标集合 = 勾选项 ∪ 当前卡片
  const mergeCount = checked ? checkedCount : checkedCount + 1;
  const sections = useNotesStore((s) => s.sections);
  const focused = useUIStore((s) => s.focusedId === note.id);
  const provenanceSourceState = useNotesStore((state) => {
    if (!note.provenance) return "available" as const;
    const ids = note.provenance.sourceItemIds;
    const count = ids.filter((id) =>
      state.notes.some((item) => item.id === id) ||
      state.tasks.some((item) => item.id === id)
    ).length;
    return count === ids.length ? "available" as const : count ? "partial" as const : "missing" as const;
  });
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
  // 笔记域头部渐变的分组色兜底（返回原始字符串，满足选择器稳定引用约束）；
  // 剪贴卡恒不取分组色，保持"来源应用主色，否则中性灰"的现状
  const sectionColor = useNotesStore((s) =>
    note.sectionId === CLIPBOARD_ID
      ? undefined
      : s.sections.find((sec) => sec.id === note.sectionId)?.color
  );
  const cardOpacity = useNotesStore((s) => s.settings.cardOpacity);
  const compactPref = useNotesStore((s) => s.settings.cardDensity === "compact");
  const aliasEntitiesEnabled = useNotesStore((s) => s.settings.aliasEntitiesEnabled);
  const aliasEntities = useNotesStore((s) => s.settings.aliasEntities);
  // 横栏串固定瓷砖形态，不受密度设置影响
  const compact = compactPref && !strip;
  /** 剪贴板历史卡：固定语义不同，并可从卡面直接保存为正式笔记。 */
  const isClip = note.sectionId === CLIPBOARD_ID;
  const clipTemplatePref = useNotesStore((s) => s.settings.clipCardTemplate);
  /** 票据形态（B 案定稿）：仅剪贴 × 舒适密度 × 竖栏；紧凑、横栏串、笔记不受影响。 */
  const ticket = isClip && !compact && !strip;
  /** 剪贴卡模板只作用于票据形态（舒适密度竖栏）；其余恒为标准形态。 */
  const clipTemplate = ticket ? clipTemplatePref : "standard";
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
    const card = cardRef.current;
    if (!card) return;
    const insideHiddenPage = !!card.closest('[aria-hidden="true"]');
    if (shouldScrollFocusedCard(focused, insideHiddenPage)) {
      card.scrollIntoView({ block: "nearest" });
    }
  }, [focused]);

  /** 删除：当前卡属于多选集合 → 删整组；否则只删这一张。 */
  const deleteSelfOrChecked = () => {
    const st = useNotesStore.getState();
    if (checked && st.checkedIds.length > 1) {
      const ids = orderedCheckedNotes(st).map((n) => n.id);
      deleteNotesWithUndo(ids, `已删除 ${ids.length} 条`);
    } else {
      deleteNotesWithUndo([note.id], "已删除 1 条");
    }
  };

  /**
   * 发送：与删除同款多选感知——当前卡属于多选集合 → 发整组；否则只发这张。
   * prefix/opts 透传给发送管线（模板发送、预检并发送共用此入口）。
   */
  const sendSelfOrChecked = (
    prefix?: string,
    opts?: { promptSnippetId?: string; forcePreflight?: boolean }
  ) => {
    const st = useNotesStore.getState();
    const ids =
      checked && st.checkedIds.length > 1
        ? orderedCheckedNotes(st).map((n) => n.id)
        : [note.id];
    void sendNotesToChat(ids, prefix, opts);
  };

  const openPreview = (editing = false) => {
    // 链接卡「查看明细」= 直接打开网页；编辑仍走预览层编辑链接文本
    if (isLink && !editing) {
      void api.openUrl(note.url!);
      return;
    }
    // 图片卡「查看明细」= 原尺寸预览窗（窄面板放不下大图），带笔记上下文
    // 以便在预览窗内联编辑文字备注（占位符「图片 W×H」不当作备注下发）
    if (isImage && !editing && note.imageFile) {
      void api.quickLook(noteImages(note), 0, {
        id: note.id,
        text: imageCaption(note),
        dataGeneration: currentDataGeneration(),
      });
      return;
    }
    // 文字类 → 桌面居中的文本详情窗；图片编辑等仍走面板内预览层
    openNoteDetail(note.id, editing);
  };

  const openProvenanceSource = () => {
    const sourceIds = note.provenance?.sourceItemIds ?? [];
    const state = useNotesStore.getState();
    const sourceNote = state.notes.find((item) => sourceIds.includes(item.id));
    if (sourceNote) {
      openNoteDetail(sourceNote.id);
      return;
    }
    const sourceTask = state.tasks.find((item) => sourceIds.includes(item.id));
    if (sourceTask) {
      const ui = useUIStore.getState();
      ui.setPage("tasks");
      ui.setFocusedId(sourceTask.id);
      tip("info", "已定位原始任务");
      return;
    }
    tip("warn", "原始来源已不存在，结果卡仍可正常使用");
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
              <ContextMenuShortcut>Space</ContextMenuShortcut>
            </ContextMenuItem>
          );
        }
        if (isImage && note.imageFile) {
          return (
            <ContextMenuItem key={id} onClick={() => openPreview()}>
              <Expand className="size-3.5" /> 原尺寸预览
              <ContextMenuShortcut>Space</ContextMenuShortcut>
            </ContextMenuItem>
          );
        }
        return (
          <ContextMenuItem key={id} onClick={() => openPreview()}>
            <Expand className="size-3.5" /> 预览
            <ContextMenuShortcut>Space</ContextMenuShortcut>
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
          <TargetSendMenuItem
            key={id}
            allowInternal={note.sectionId === CLIPBOARD_ID}
            // 多选感知与删除对齐：卡在多选集合内 → 发整组
            onClick={() => sendSelfOrChecked()}
          >
            <Send className="size-3.5" />
            {note.sectionId === CLIPBOARD_ID ? "发送 / 添加" : "发送到对话"}
            <ContextMenuShortcut>⌘⏎</ContextMenuShortcut>
          </TargetSendMenuItem>
        );
      case "send-template": {
        // 与底栏 ⌄ 的模板列表并存（底栏单选也显示）：右键路径服务未勾选直接
        // 右键的场景。菜单打开时才渲染，getState 一次性取解析结果即可，无需订阅
        const snippetMenu = promptSnippetsForGroup(
          useNotesStore.getState().settings.promptSnippets,
          currentTargetProfileResolution().promptGroup.id
        );
        const renderSnippet = (sn: { id: string; label: string; text: string }) => (
          <ContextMenuItem
            key={sn.id}
            title={sn.text}
            onClick={() => sendSelfOrChecked(sn.text, { promptSnippetId: sn.id })}
          >
            {sn.label}
          </ContextMenuItem>
        );
        return (
          <ContextMenuSub key={id}>
            <ContextMenuSubTrigger>
              <FileText className="mr-2 size-3.5" /> 用模板发送
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-44">
              {snippetMenu.prioritized.map(renderSnippet)}
              {snippetMenu.prioritized.length === 0 && (
                <ContextMenuItem disabled>
                  {snippetMenu.remaining.length > 0
                    ? "当前分组暂无模板"
                    : "去设置里添加模板"}
                </ContextMenuItem>
              )}
              {snippetMenu.remaining.length > 0 && (
                <>
                  <ContextMenuSeparator />
                  {snippetMenu.remaining.map(renderSnippet)}
                </>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
        );
      }
      case "send-preflight":
        return (
          <ContextMenuItem
            key={id}
            onClick={() => sendSelfOrChecked(undefined, { forcePreflight: true })}
          >
            <ListChecks className="size-3.5" /> 预检并发送
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
            <ContextMenuShortcut>⌘C</ContextMenuShortcut>
          </ContextMenuItem>
        );
      case "edit":
        return (
          <ContextMenuItem key={id} onClick={() => openPreview(true)}>
            <Pencil className="size-3.5" /> 编辑
            <ContextMenuShortcut>⏎</ContextMenuShortcut>
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
            <ContextMenuShortcut>D</ContextMenuShortcut>
          </ContextMenuItem>
        );
      case "keep":
        return (
          <ContextMenuItem key={id} onClick={() => toggleNoteKeep(note.id)}>
            <KeepGlyph className={cn("size-3.5", note.keep && "fill-current")} />{" "}
            {isClip
              ? note.keep
                ? "取消固定"
                : "固定 · 不被清理"
              : note.keep
                ? "取消常用"
                : "设为常用 · 发送后保留"}
            <ContextMenuShortcut>P</ContextMenuShortcut>
          </ContextMenuItem>
        );
      case "rename":
        return (
          <ContextMenuItem key={id} onClick={startRename}>
            <PenLine className="size-3.5" /> 重命名
          </ContextMenuItem>
        );
      case "tags": {
        // 全库标签目录：菜单打开瞬间快照即可（点击项后菜单即关闭），
        // 不订阅 notes——遵守选择器稳定引用红线
        const catalog = sanitizeNoteTags(
          useNotesStore.getState().notes.flatMap((n) => n.tags ?? [])
        );
        const current = new Set(note.tags ?? []);
        return (
          <ContextMenuSub key={id}>
            <ContextMenuSubTrigger>
              <Tag className="mr-2 size-3.5" /> 标签
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-40">
              {(catalog ?? []).map((tag) => (
                <ContextMenuItem
                  key={tag}
                  disabled={
                    !current.has(tag) && current.size >= NOTE_TAG_MAX_COUNT
                  }
                  onClick={() =>
                    useNotesStore
                      .getState()
                      .setNoteTags(
                        note.id,
                        current.has(tag)
                          ? [...current].filter((item) => item !== tag)
                          : [...current, tag]
                      )
                  }
                >
                  <Check
                    className={cn(
                      "size-3.5",
                      current.has(tag) ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate">{tag}</span>
                </ContextMenuItem>
              ))}
              {!!catalog?.length && <ContextMenuSeparator />}
              <ContextMenuItem
                disabled={current.size >= NOTE_TAG_MAX_COUNT}
                onClick={() => {
                  tagInputPendingRef.current = true;
                  tagInputOpenedAtRef.current = Date.now();
                  setTagDraft("");
                }}
              >
                <PenLine className="size-3.5" /> 新标签…
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        );
      }
            case "ai-to-task":
        if (isImage || isComposite) return null;
        return (
          <ContextMenuItem key={id} onClick={() => void noteToTaskSmart(note.id)}>
            <Sparkles className="size-3.5" /> AI 转任务
          </ContextMenuItem>
        );
      case "ai-title":
        if (isImage) return null;
        return (
          <ContextMenuItem key={id} onClick={() => void suggestTitle(note.id)}>
            <Sparkles className="size-3.5" /> AI 起标题
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
    if (!note.imageFile || isDataOperationLocked()) return;
    const lease = beginDataGenerationLease();
    tip("info", "正在识别文字…");
    try {
      const text = await api.ocrImage(note.imageFile);
      const current = useNotesStore.getState().notes.find((item) => item.id === note.id);
      if (
        !matchesDataGeneration(lease.generation) ||
        current?.imageFile !== note.imageFile
      ) {
        return;
      }
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
    } finally {
      lease.release();
    }
  };

  const applyTextOp = (textOp: TextOp) => {
    try {
      const blocks = noteContentBlocks(note);
      if (blocks.some((block) => block.type === "image")) {
        // 带图卡逐文字块变换：经 note.text 投影往返（updateNoteText）会把
        // 多段文字折叠成单块、压平图文交错顺序
        const next = mapNoteTextBlocks(blocks, (text) => textOp.apply(text));
        if (next.every((block, index) => block === blocks[index])) {
          tip("info", "内容无变化");
          return;
        }
        useNotesStore.getState().snapshot(`文本处理：${textOp.label}`);
        useNotesStore.getState().updateNoteContent(note.id, next);
        undoableTip(`已处理 · ${textOp.label}`);
        return;
      }
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

  // 铁律：占位符出现列表在 useMemo 派生，绝不放进 zustand 选择器
  const aliasRestorable = useMemo(
    () =>
      aliasEntitiesEnabled && !isImage
        ? activeAliasOccurrences(note.text, aliasEntities)
        : [],
    [aliasEntities, aliasEntitiesEnabled, isImage, note.text]
  );

  const restoreCardAliases = () => {
    if (aliasRestorable.length === 0) return;
    // 单实现（带图卡逐块处理）收敛在 actions，与发送历史抽屉共用
    restoreNoteAliasesWithUndo(note.id);
  };

  const copyOne = () => void copyNoteContent(note);

  const segments = splitHighlight(note.text, query);
  // 卡面代码高亮：只算可见头部（600 字符足够 3-6 行），memo 防重复计算
  const cardCodeHtml = useMemo(
    () =>
      note.codeLang && !query
        ? highlightCode(note.text.slice(0, 600), note.codeLang)
        : "",
    [note.text, note.codeLang, query]
  );

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
  // 新标签内联输入（右键 标签 → 新标签…）；null = 未在输入
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  // 标记「本次菜单关闭是为了打开标签输入」——见 ContextMenuContent 的
  // onCloseAutoFocus：阻止焦点归还卡片，避免输入框挂载瞬间被 blur 关闭
  const tagInputPendingRef = useRef(false);
  // 输入条挂载时刻：挂载初期的 blur 一律视为焦点竞态噪声（WKWebView 焦点
  // 惰性 + 菜单关闭归还），抢回焦点而不是提交关闭
  const tagInputOpenedAtRef = useRef(0);
  const commitTagDraft = () => {
    if (tagDraft?.trim()) {
      useNotesStore
        .getState()
        .setNoteTags(note.id, [...(note.tags ?? []), tagDraft]);
    }
    setTagDraft(null);
  };
  const startRename = () => {
    setTitleDraft(note.title ?? "");
    setRenaming(true);
  };
  const commitRename = () => {
    useNotesStore.getState().updateNoteTitle(note.id, titleDraft);
    setRenaming(false);
  };

  /** keep 图标分域：剪贴=图钉（固定置顶·不被清理），笔记=星标（常用·发送后保留） */
  const KeepGlyph = isClip ? Pin : Star;
  // 通栏底色：竖栏笔记=资产牌（A 案），分组色优先（归属即身份）> 应用主色 > 中性灰；
  // 横栏串维持现状——应用主色优先，图标色未就绪时不闪分组色
  const headerTint = strip
    ? icon?.color ?? (note.sourceBundle ? undefined : sectionColor)
    : sectionColor ?? icon?.color;
  /** 竖栏笔记通栏副行展示的分组名（组织轴）；其余形态不消费。 */
  const sectionName =
    !isClip && !strip
      ? sections.find((sec) => sec.id === note.sectionId)?.name
      : undefined;
  /** 移入笔记：与删除/发送同款多选感知——卡在多选集合内 → 移整组。 */
  const moveToNotesSelfOrChecked = () => {
    if (!isClip) return;
    const st = useNotesStore.getState();
    const ids =
      checked && st.checkedIds.length > 1
        ? orderedCheckedNotes(st).map((n) => n.id)
        : [note.id];
    moveClipsToNotesWithUndo(ids);
  };

  const relationMenuItem = note.provenance ? (
    <ContextMenuSub key="relation">
      <ContextMenuSubTrigger>
        <Link2 className="mr-2 size-3.5" /> 对应回复
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-44">
        <ContextMenuItem onClick={openProvenanceSource}>
          <Expand className="size-3.5" /> 查看发送内容
        </ContextMenuItem>
        <ContextMenuItem onClick={() => requestResultVerification(
          note.id,
          cardRef.current?.querySelector<HTMLElement>("[data-drag-handle]") ?? cardRef.current
        )}>
          <ShieldCheck className="size-3.5" /> 检查这条回复
        </ContextMenuItem>
        <ContextMenuItem onClick={() => requestResultLinkForNote(note.id, cardRef.current)}>
          <Link2 className="size-3.5" /> 更换对应发送
        </ContextMenuItem>
        <ContextMenuItem onClick={() => requestPlaceholderPreview(note.id, cardRef.current)}>
          <ScanText className="size-3.5" />
          {deliveryRedactionMapAvailable(note.provenance.deliveryId)
            ? "恢复占位符预览"
            : "占位符映射已失效"}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => requestResultUnlink(note.id, cardRef.current)}>
          <Unlink className="size-3.5" /> 这不是对应回复
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  ) : (
    <ContextMenuItem
      key="relation"
      onClick={() => requestResultLinkForNote(note.id, cardRef.current)}
    >
      <Link2 className="size-3.5" /> 保存为某次回复
    </ContextMenuItem>
  );

  // 多选时将「移动到」提升到合并之后；单选仍保留用户配置的组内顺序。
  const promotedMoveItem =
    mergeCount >= 2 && menuIds.includes("move") ? renderMenuItem("move") : null;
  const menuSections = groupContextMenuIds(
    promotedMoveItem ? menuIds.filter((id) => id !== "move") : menuIds
  )
    .map((group) => ({
      ...group,
      items: [
        ...group.ids.map((id) => renderMenuItem(id)).filter(Boolean),
        ...(group.id === "send" ? [relationMenuItem] : []),
      ],
    }))
    .filter((group) => group.items.length > 0);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={(el) => {
            setNodeRef(el);
            cardRef.current = el;
          }}
          // 预览层开合动画的矩形锚点（按 id 反查卡片当前位置）
          data-note-id={note.id}
          style={{
            transform: CSS.Transform.toString(transform),
            transition,
            "--card-alpha": `${Math.round(cardOpacity * 100)}%`,
          } as React.CSSProperties}
          // 整卡可抓拖拽排序（4px 激活阈值不影响点击/双击）；键盘拾取走专用把手
          // （Tab 聚焦时浮现），避免 Tab 到悬浮操作按钮时 Space/Enter 被 dnd-kit 抢走
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
            // 不留 border：卡片曾有 1px `border-transparent`（只为给选中态
            // border-primary 占位）。box-sizing:border-box 下，顶部通栏的
            // `-mx-2` 只抵消 padding、抵消不掉这 1px，卡片底色就从边框里透出来，
            // 在彩色通栏两侧形成一圈「深色主题黑、浅色主题白」的细边——
            // 正是用户反复指出的那层描边（放大截图实测：面板 #2f3a4a →
            // 暗带 #1f2226 → 通栏 #cd7538）。选中态改用不占布局的 ring
            "group relative flex cursor-default select-none overflow-hidden",
            compact && isClip ? "rounded-md" : "rounded-lg",
            strip
              ? // Paste 1:1：近方形卡（实测 496×526 → 16/17），宽随栏高推导
                "h-auto aspect-[16/17] shrink-0 flex-col px-2 pb-1.5 pt-1.5"
              : compact
                ? // 紧缩双调性（2026-08-12 用户定稿）：剪贴=流水行更密，笔记=资产卡呼吸
                  isClip
                  ? "h-8 items-center"
                  : "h-10 items-center"
                : ticket
                  ? // 舒适竖栏剪贴=时间票据（B 案定稿）：标准=票据全卡；
                    // 浓缩=票据头+单行摘要
                    clipTemplate === "condensed"
                      ? "h-[52px] flex-col px-2 pb-1 pt-1.5"
                      : "h-[116px] flex-col px-2 pb-1 pt-1.5"
                  : // 舒适竖栏笔记=资产牌（A 案）/ 横栏串：维持通栏瓷砖
                    "h-[136px] flex-col px-2 pb-1.5 pt-1.5",
            // 实色卡片（Paste 风格）：与毛玻璃面板分层；透明度由设置项调节。
            // 静息态不给阴影——shadow-sm 是紧贴边缘的 1px 硬阴影，在深色面板上
            // 会读成一条描边（用户实测否决；详情层同理只用大而柔的 elevation）。
            // 卡底与面板底本身对比足够，不靠边线也分得开。
            // 剪贴板紧缩行例外：去卡片化（hover 才浮现行底）——临时流水的调性
            compact && isClip
              ? "transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
              : "bg-[rgb(255_255_255/var(--card-alpha,100%))] dark:bg-[rgb(39_39_42/var(--card-alpha,100%))]",
            // 舒适密度的悬浮微升：位移只作用于卡片刚体（内部图标区相对位置不变）；
            // reduced-motion 下 transition 被全局压到 0.01ms，等效"去位移保影子"
            !compact &&
              "transition-[transform,box-shadow] duration-150 hover:-translate-y-px hover:elevation-2",
            // 紧缩笔记卡 hover 只给影子不位移（资产感；流水行只亮底不抬）
            compact && !isClip && "transition-shadow duration-150 hover:elevation-2",
            // 无勾选框设计：选中态 = primary 光环（+ 舒适密度抬升）。
            // 只用 ring 不用 border：ring 画在布局盒之外，不会像边框那样把
            // 通栏往内挤出一圈底色。
            // 紧缩例外：外扩 ring 在密排列表里会与相邻选中卡叠色成嵌套弧
            // 乱纹、还被滚动容器裁边——笔记卡改内嵌 ring；零间距流水行的
            // 描边走下方覆盖层的分段 border，相邻选中行合并为连续选区块
            checked &&
              (compact
                ? !isClip && "ring-2 ring-inset ring-primary/70"
                : "ring-2 ring-primary/70 elevation-2"),
            joinPrev && compact && isClip && "rounded-t-none",
            joinNext && compact && isClip && "rounded-b-none",
            // 键盘焦点：只抬升不描边（用户否决"随主题黑白的中性细环"——
            // 点击卡片也会置 focusedId，那圈线几乎常驻，观感像多了一层边框）
            focused && !checked && "elevation-2",
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
                  ? "bg-primary/[0.12] dark:bg-primary/[0.2]"
                  : "bg-primary/[0.1] dark:bg-primary/[0.16]",
                // 紧缩流水行：选中描边画在行内（分段 border）——连续选中段
                // 首行留上边、末行留下边、中段只留两侧，读作一个选区块
                compact && isClip && "rounded-[inherit] border-x-2 border-primary/70",
                compact && isClip && !joinPrev && "border-t-2",
                compact && isClip && !joinNext && "border-b-2"
              )}
            />
          )}
          <button
            {...attributes}
            data-drag-handle
            onKeyDown={(e) => listeners?.onKeyDown?.(e)}
            onClick={(e) => e.stopPropagation()}
            aria-label="拖拽调整位置和分组（Space 拾起，方向键移动）"
            className={cn(
              "cursor-grab touch-none p-0.5 text-muted-foreground/50 transition-opacity",
              // 舒适卡把手＝键盘专用（鼠标拖拽走整卡）：Tab 聚焦时以卡内浮钮显现。
              // 旧版 -left-4 挂卡外，被 ScrollArea Viewport 的 overflow-x:hidden
              // 裁得只剩几像素（hover 显现名存实亡），列表左侧还得为它垫 pl-2
              compact
                ? "relative ml-1 shrink-0 opacity-60 hover:opacity-100"
                : // 隐形态放行命中（opacity-0 仍会截走下方元素的点击）；键盘聚焦显现时恢复可抓
                  "pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 rounded-md border border-foreground/10 bg-surface-raised/95 elevation-2 opacity-0",
              "focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
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
            <div className="flex h-full min-w-0 flex-1">
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
          {/* 票据头行（剪贴 × 舒适竖栏，B 案定稿）：相对时间为主键 + 标题/类型徽标
              + 图钉 + 右端完整应用图标（不裁切）；浓缩模板下操作钮悬浮
              头行右端，元数据 hover 淡出让位（沿用原通栏模板技法） */}
          {ticket && (
            <div
              className={cn(
                "flex h-5 shrink-0 items-center gap-1.5",
                clipTemplate === "standard" && "mb-1"
              )}
            >
              {/* 时间主键：强调靠字重，颜色退到与底行「来自 …」同族灰（略深） */}
              <span className="shrink-0 text-label font-semibold tabular-nums text-muted-foreground">
                {noteTimeLabel(note)}
              </span>
              <div className="flex min-w-0 flex-1 items-center">
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
                    className="w-full bg-transparent text-label font-medium outline-none placeholder:text-muted-foreground"
                  />
                ) : note.title ? (
                  <p
                    title="点击重命名"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename();
                    }}
                    className="min-w-0 cursor-text truncate text-label font-medium"
                  >
                    {note.title}
                  </p>
                ) : typeLabel !== "文本" ? (
                  // 纯文本剪贴不设类型徽标（时间即身份，重命名走右键菜单）；
                  // 徽标 flex 化定高居中——inline-block 会骑基线在头行里下坠
                  <button
                    type="button"
                    title="点击重命名"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename();
                    }}
                    className="inline-flex h-3.5 max-w-full cursor-text items-center rounded-sm surface-inset px-1.5 text-micro font-medium leading-none text-muted-foreground"
                  >
                    <span className="truncate">{typeLabel}</span>
                  </button>
                ) : null}
              </div>
              {note.keep && (
                <KeepGlyph
                  className={cn(
                    "size-3 shrink-0 fill-amber-400 text-amber-400",
                    clipTemplate !== "standard" &&
                      "transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
                  )}
                />
              )}
              {icon && (
                <img
                  src={icon.url}
                  alt=""
                  className={cn(
                    "size-4 shrink-0",
                    clipTemplate !== "standard" &&
                      "transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
                  )}
                />
              )}
            </div>
          )}

          {/* 顶部通栏（竖栏笔记=资产牌 / 横栏串维持现状）：渐变底 + 标题与副行
              （白字）+ 右端应用图标；渐变两端与卡底同吃 --card-alpha */}
          {!ticket && (
          <div
            className="-mx-2 -mt-1.5 mb-1.5 flex h-9 shrink-0 items-center gap-1.5 rounded-t-lg px-2"
            style={{
              backgroundImage: headerGradient(
                (cardTint && headerTint) || "#5b5b60"
              ),
            }}
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
                  className={cn(
                    "w-full bg-transparent font-semibold text-white outline-none placeholder:text-white/50",
                    // 竖栏笔记标题升一档（资产感）；横栏串维持现状字阶
                    strip ? "text-label" : "text-title"
                  )}
                />
              ) : (
                <p
                  title="点击重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename();
                  }}
                  className={cn(
                    "cursor-text truncate font-semibold text-white",
                    strip ? "text-label" : "text-title"
                  )}
                >
                  {note.title ?? typeLabel}
                </p>
              )}
              <p className="truncate text-micro text-white/70">
                {/* 竖栏笔记副行=分组名（组织轴，时间移至右下角）；横栏串维持相对时间 */}
                {!strip && sectionName ? sectionName : noteTimeLabel(note)}
              </p>
            </div>
            {note.keep && (
              <KeepGlyph className="size-3 shrink-0 fill-white/90 text-white/90" />
            )}
            {icon && (
              // 应用图标嵌入通栏右端（Paste 风格）：左缘完整可见，
              // 上/右/下被通栏边缘裁去少许——左对齐 + 垂直居中的大图标
              <span className="-mr-2 flex h-9 w-11 shrink-0 items-center justify-start overflow-hidden">
                <img src={icon.url} alt="" className="size-[52px] max-w-none" />
              </span>
            )}
          </div>
          )}

          {/* 浓缩模板：通栏下只保留一行摘要（图片=缩略图+张数标签，链接=favicon+标题） */}
          {clipTemplate === "condensed" && (
            <div className="flex min-h-0 flex-1 items-center gap-1.5 overflow-hidden">
              {isImage &&
                (imageUrl ? (
                  <img
                    src={imageUrl}
                    alt=""
                    className="size-6 shrink-0 rounded-sm object-cover"
                  />
                ) : (
                  <span className="size-6 shrink-0 animate-pulse rounded-sm bg-black/[0.06] dark:bg-white/[0.08]" />
                ))}
              {isLink && note.linkIcon && <LinkFavicon src={note.linkIcon} />}
              <p
                {...dragOutProps}
                className={cn(
                  "min-w-0 flex-1 truncate hover:cursor-grab",
                  note.codeLang ? "font-mono text-label" : "text-body",
                  note.done && "text-muted-foreground line-through opacity-60"
                )}
              >
                {splitHighlight(noteFirstLine(note), query).map((seg, i) =>
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
            </div>
          )}
          {clipTemplate === "standard" && (
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
                {/* 票据高度装不下常驻按钮：打开链接走悬浮「打开页面」钮 / Space / 右键 */}
                {!ticket && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void api.openUrl(note.url!);
                    }}
                    className="mt-1 flex w-fit items-center gap-1 rounded-md bg-black/[0.06] px-1.5 py-0.5 text-micro text-muted-foreground hover:text-foreground dark:bg-white/10"
                  >
                    <ExternalLink className="size-2.5" /> 打开链接
                  </button>
                )}
              </div>
            ) : isImage ? (
              <div className="flex h-full w-full flex-col gap-1">
                {cardImages.length > 1 ? (
                  // 组合卡：并排缩略最多 3 张，更多以「+N」标示
                  <div className="flex min-h-0 flex-1 gap-1">
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
                  <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-sm bg-black/[0.04] dark:bg-white/[0.06]">
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt="捕获的图片"
                        className="max-h-full max-w-full object-contain"
                      />
                    ) : (
                      <span className="text-micro text-muted-foreground">加载中…</span>
                    )}
                  </div>
                )}
                {/* 真实文字备注（详情窗编辑；占位符不回显）：卡面一行截断，
                    保存立即可见 */}
                {imageCaption(note) && (
                  <p
                    className={cn(
                      "shrink-0 truncate text-label text-muted-foreground",
                      note.done && "line-through opacity-60"
                    )}
                  >
                    {imageCaption(note)}
                  </p>
                )}
              </div>
            ) : note.codeLang && !query ? (
              // 代码卡卡面直接语法高亮（与预览层同源）；搜索时让位给命中高亮
              <pre
                {...dragOutProps}
                className={cn(
                  "hljs !bg-transparent",
                  strip ? "line-clamp-[6]" : "line-clamp-3",
                  "whitespace-pre-wrap font-mono text-label leading-normal [overflow-wrap:anywhere] hover:cursor-grab",
                  note.done && "text-muted-foreground line-through opacity-60"
                )}
              >
                <code
                  dangerouslySetInnerHTML={{ __html: cardCodeHtml }}
                />
              </pre>
            ) : (
              <p
                {...dragOutProps}
                className={cn(
                  // hover:cursor-grab：正文可拖出到外部应用的唯一可见暗示
                  strip ? "line-clamp-[6]" : "line-clamp-3",
                  "whitespace-pre-wrap text-body leading-normal [overflow-wrap:anywhere] hover:cursor-grab",
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
          )}

          {clipTemplate === "standard" && isComposite && (
            <div className="mb-1 flex shrink-0 gap-1 overflow-hidden">
              {images.slice(0, 4).map((f) => (
                <Thumb key={f} file={f} />
              ))}
              {images.length > 4 && (
                <span className="self-center text-micro text-muted-foreground">
                  +{images.length - 4}
                </span>
              )}
            </div>
          )}

          {clipTemplate === "standard" && (
          <div
            className={cn(
              "flex shrink-0 items-center gap-1 text-micro text-muted-foreground",
              // 票据底行带打孔虚线裁切线（B 案）；笔记/横栏维持现状高度
              ticket ? "h-5 border-t border-dashed border-foreground/10 pt-1" : "h-4"
            )}
          >
            {note.provenance ? (
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  openProvenanceSource();
                }}
                className={cn(
                  "inline-flex min-w-0 items-center gap-1 truncate rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  provenanceSourceState !== "available" && "text-warning"
                )}
              >
                <Link2 className="size-3 shrink-0" aria-hidden />
                {provenanceSourceState === "available"
                  ? "来自发送结果"
                  : provenanceSourceState === "partial"
                    ? "发送结果 · 部分来源缺失"
                    : "发送结果 · 来源缺失"}
              </button>
            ) : aliasRestorable.length > 0 ? (
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  restoreCardAliases();
                }}
                className="inline-flex min-w-0 items-center gap-1 truncate rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                title="把词典占位符还原为原文（本机操作，可撤销）"
              >
                <VenetianMask className="size-3 shrink-0" aria-hidden />
                含 {aliasRestorable.length} 处化名 · 点击恢复
              </button>
            ) : note.sourceApp ? <span className="truncate">来自 {note.sourceApp}</span> : <span />}
            {!!note.tags?.length && (
              <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
                {note.tags.slice(0, 3).map((tag) => (
                  <span
                    key={tag}
                    className="max-w-20 shrink-0 truncate rounded-sm surface-inset px-1 text-micro leading-4 text-muted-foreground"
                  >
                    #{tag}
                  </span>
                ))}
                {note.tags.length > 3 && (
                  <span className="shrink-0 text-micro text-muted-foreground">
                    +{note.tags.length - 3}
                  </span>
                )}
              </span>
            )}
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
              {!isClip && !strip
                ? // 竖栏笔记（A 案）：通栏副行让位给分组名，时间移到右下角
                  noteTimeLabel(note)
                : isImage && note.imageW
                  ? `${note.imageW} × ${note.imageH}`
                  : isLink
                    ? "链接"
                    : isComposite
                      ? `${[...note.text].length} 字符 · ${images.length} 图`
                      : `${[...note.text].length} 字符`}
            </span>
          </div>
          )}
            </>
          )}

          {/* 新标签内联输入浮条（右键 标签 → 新标签…）：浮在卡底，全模板通用 */}
          {tagDraft !== null && (
            <div
              className="absolute inset-x-1 bottom-1 z-10 flex items-center gap-1.5 rounded-md border border-border bg-popover px-1.5 py-1 shadow-md"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Tag className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              <input
                autoFocus
                value={tagDraft}
                placeholder="新标签，回车添加"
                onChange={(e) => setTagDraft(e.target.value)}
                onBlur={(e) => {
                  // 挂载初期的失焦是菜单关闭/焦点归还的竞态，不是用户意图
                  if (Date.now() - tagInputOpenedAtRef.current < 400) {
                    const el = e.currentTarget;
                    window.setTimeout(() => el.focus(), 0);
                    return;
                  }
                  commitTagDraft();
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) commitTagDraft();
                  if (e.key === "Escape") setTagDraft(null);
                }}
                className="w-full bg-transparent text-label outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}

          {/* 紧缩笔记卡：操作钮显现时右端先铺同卡底色渐变垫底，钮不再悬空压字；
              剪贴流水行无实底可渐变（毛玻璃面板），维持右端元数据淡出的现状 */}
          {compact && !isClip && (
            // token-exception: 渐变终点必须精确等于卡底色（含 --card-alpha 用户透明度），无对应 token
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-2/5 rounded-[inherit] bg-gradient-to-l from-[rgb(255_255_255/var(--card-alpha,100%))] from-55% to-transparent opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 dark:from-[rgb(39_39_42/var(--card-alpha,100%))]"
            />
          )}
          {/* 悬停操作钮：hover/键盘焦点显现（opacity 方案，Tab 可达） */}
          <div
            className={cn(
              "absolute flex gap-0.5",
              compact
                ? // 紧凑列表行：钮垂直居中（行内元数据 hover 让位）
                  "right-1 top-1/2 -translate-y-1/2"
                : clipTemplate === "condensed"
                  ? // 浓缩票据：钮挂票据头行右端（头行元数据 hover 让位）
                    "right-1 top-1"
                  : "bottom-1 right-1.5"
            )}
          >
            <IconButton
              label={
                isClip
                  ? "发送 / 添加（双击卡片同效）"
                  : "发送到对话（双击卡片同效）"
              }
              surface
              reveal="hover-focus"
              onClick={() => sendSelfOrChecked()}
            >
              <Send className="size-3" />
            </IconButton>
            {isClip && (
              <IconButton
                label={note.keep ? "取消置顶" : "置顶（固定不清理）"}
                surface
                reveal="hover-focus"
                pressed={note.keep}
                onClick={() => useNotesStore.getState().toggleNoteKeep(note.id)}
              >
                <Pin className="size-3" />
              </IconButton>
            )}
            {isClip && (
              <IconButton
                label="复制内容"
                surface
                reveal="hover-focus"
                onClick={copyOne}
              >
                <Copy className="size-3" />
              </IconButton>
            )}
            {isClip && (
              <IconButton
                label="移入笔记"
                surface
                reveal="hover-focus"
                onClick={moveToNotesSelfOrChecked}
              >
                <Inbox className="size-3" />
              </IconButton>
            )}
            {aliasRestorable.length > 0 && (
              <IconButton
                label="恢复化名"
                surface
                reveal="hover-focus"
                onClick={restoreCardAliases}
              >
                <VenetianMask className="size-3" />
              </IconButton>
            )}
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
            <IconButton
              label="编辑"
              surface
              reveal="hover-focus"
              onClick={() => openPreview(true)}
            >
              <Pencil className="size-3" />
            </IconButton>
            <IconButton
              label="删除"
              surface
              reveal="hover-focus"
              tone="danger"
              onClick={deleteSelfOrChecked}
            >
              <Trash2 className="size-3" />
            </IconButton>
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent
        className="w-44"
        // 「新标签…」点击后菜单关闭会把焦点归还给卡片，正好抢走刚挂载的
        // 标签输入框焦点 → onBlur 立即提交关闭（表现为浮条闪现即失）。
        // 仅在该次关闭阻止归还，让 autoFocus 的输入框保住焦点。
        onCloseAutoFocus={(event) => {
          if (tagInputPendingRef.current) {
            tagInputPendingRef.current = false;
            event.preventDefault();
          }
        }}
      >
        {/* 多选场景优先展示合并与移动；移动仍遵循用户显隐配置。 */}
        {mergeCount >= 2 && (
          <ContextMenuItem onClick={() => mergeNoteWithChecked(note.id)}>
            <Merge className="size-3.5" /> 合并笔记 ×{mergeCount}
          </ContextMenuItem>
        )}
        {promotedMoveItem}
        {mergeCount >= 2 && <ContextMenuSeparator />}
        {/* 一级菜单按用途分组；保留设置中的组内顺序与显隐。 */}
        {menuSections.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 && <ContextMenuSeparator />}
            {group.items}
          </Fragment>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={deleteSelfOrChecked}
        >
          <Trash2 className="size-3.5" /> 删除
          {checked && checkedCount > 1 ? ` ${checkedCount} 项` : ""}
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
  const isImage = note.kind === "image";
  const isLink = note.kind === "link" && !!note.url;
  const images = noteImages(note);
  const firstLine = noteFirstLine(note);
  const mono = !isImage && !isLink && isMonoLike(firstLine);
  /** 自定义标题（命名过的资产）：标题优先展示，内容首行降级为淡色摘要 */
  const title = note.title?.trim() || null;
  const preview = firstLine === "（空）" ? null : firstLine;
  const isClip = note.sectionId === CLIPBOARD_ID;
  const highlightSegs = (text: string) =>
    splitHighlight(text, query).map((seg, i) =>
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
    );
  /** keep 图标分域（与完整卡同规则）：剪贴=图钉，笔记=星标；只换图标不动布局 */
  const KeepGlyph = isClip ? Pin : Star;
  // 紧凑行双调性（2026-08-12 用户定稿，替代 08-05「两域同款」）：骨架共用
  // （无左缘色条、来源由图标表达、等宽中段省略），差异由外层行高/底色
  // + 本行的「标题优先」与「剪贴相对时间戳」表达
  return (
    <div className="relative flex h-full w-full min-w-0 items-center gap-2 pl-2 pr-2">
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
          !title && (note.codeLang || mono) && "font-mono text-label",
          note.done && "text-muted-foreground line-through opacity-60"
        )}
      >
        {title ? (
          // 标题优先：加重标题 + 淡色摘要同行跟随（长标题吃掉摘要，整行尾部省略）
          <>
            <span className="font-medium">{highlightSegs(title)}</span>
            {preview && (
              <span className="text-muted-foreground"> — {highlightSegs(preview)}</span>
            )}
          </>
        ) : mono && !query ? (
          // 中段省略：head 弹性截断 + tail 定长保留（路径尾段才是身份）。
          // 搜索态回退到常规截断，保证高亮片段可见
          (() => {
            const { head, tail } = splitMiddle(firstLine);
            return (
              <span className="flex min-w-0">
                <span className="truncate">{head}</span>
                {tail && <span className="shrink-0">{tail}</span>}
              </span>
            );
          })()
        ) : (
          highlightSegs(firstLine)
        )}
      </p>
      {/* 尾部元数据在 hover 时淡出，给悬浮操作钮让位（原先是图标直接压在时间上打架） */}
      {note.keep && (
        <KeepGlyph className="size-3 shrink-0 fill-amber-400 text-amber-400 transition-opacity group-hover:opacity-0" />
      )}
      {note.provenance && (
        <Link2
          className="size-3 shrink-0 text-primary transition-opacity group-hover:opacity-0"
          aria-label="来自发送结果"
        />
      )}
      {!isImage && images.length > 0 && (
        <span className="shrink-0 text-micro text-muted-foreground transition-opacity group-hover:opacity-0">
          {images.length}图
        </span>
      )}
      {/* 剪贴流水行常显相对时间（新鲜度=核心元数据）；置顶行免时间只留图钉 */}
      {isClip && !note.keep && (
        <span className="shrink-0 text-micro tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0">
          {noteTimeLabel(note)}
        </span>
      )}
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
