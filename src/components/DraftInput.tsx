import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowUpRight, Check, ChevronUp, FolderInput, X } from "lucide-react";

import { SimpleMenu, SimpleMenuItem } from "@/components/SimpleMenu";
import { IconButton } from "@/components/ui/icon-button";
import { PillInput } from "@/components/ui/pill-input";
import { enrichLinkMeta, openNoteDetail } from "@/lib/actions";
import {
  draftTargetSections,
  resolveDraftSectionId,
} from "@/lib/draftSection";
import {
  beginDataGenerationLease,
  DATA_CONTEXT_INVALIDATED_EVENT,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import { useNoteThumb } from "@/lib/media";
import { api } from "@/lib/tauri";
import { tip } from "@/lib/tip";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore, type DraftPendingImage } from "@/store/uiStore";
import {
  isDataOperationLocked,
  useDataOperationStore,
} from "@/store/dataOperationStore";

/** 旧版草稿的 localStorage 键：仅用于一次性收编 + 清除明文残留。
 *  草稿现随主数据文件加密落盘（store.draftText），不再写 WebKit localStorage。 */
const LEGACY_DRAFT_TEXT_STORAGE_KEY = "toskr-draft-input-text";

const takeLegacyDraftText = () => {
  try {
    const legacy = localStorage.getItem(LEGACY_DRAFT_TEXT_STORAGE_KEY) ?? "";
    localStorage.removeItem(LEGACY_DRAFT_TEXT_STORAGE_KEY);
    return legacy;
  } catch {
    return "";
  }
};

/** 暂存图片缩略 chip：悬停/聚焦出移除钮。 */
function PendingThumb({
  image,
  onOpen,
  onRemove,
}: {
  image: DraftPendingImage;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const url = useNoteThumb(image.file);
  return (
    <span
      className={
        "group/chip relative inline-flex size-9 shrink-0 overflow-hidden rounded-md " +
        "border border-foreground/10 bg-black/[0.04] dark:bg-white/[0.06]"
      }
    >
      <button
        type="button"
        aria-label="查看或编辑这张草稿图片"
        onClick={onOpen}
        className="size-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {url ? (
          <img src={url} alt="" className="size-full object-cover" />
        ) : (
          <span className="m-auto block size-4 animate-pulse rounded-sm bg-black/10 dark:bg-white/10" />
        )}
      </button>
      <button
        type="button"
        aria-label="移除这张图片"
        onClick={onRemove}
        className={
          "absolute right-0 top-0 rounded-bl-md bg-black/55 p-0.5 text-white opacity-0 outline-none " +
          "transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-white/60"
        }
      >
        <X className="size-2.5" />
      </button>
    </span>
  );
}

/**
 * 常驻底部的思考/Prompt 缓冲输入框：Enter 提交，Shift+Enter 换行。
 * ⌘V 粘贴图片 = 暂存为缩略 chip（Claude Code 式），可继续打字，
 * 回车把文字与全部暂存图打成一张组合卡（纯图无文字则成图片卡）。
 */
export function DraftInput() {
  // 未提交草稿必须扛住组件卸载（切页/收横栏即卸载）：文字持久化在
  // store.draftText（随主数据文件加密落盘，重启也不丢；旧版 localStorage
  // 明文在下方一次性收编）。打字手感优先：本地 state 即时渲染，镜像进
  // store 走 300ms 防抖——store 每次 set 会整包序列化，逐键直写大库会拖输入。
  // 暂存图片提升到 uiStore 会话级（图片文件未被任何卡片引用，可能被媒体
  // 清理回收，刻意不跨重启恢复）
  const [value, setValueState] = useState(
    () => useNotesStore.getState().draftText || takeLegacyDraftText()
  );
  const valueRef = useRef(value);
  const mirrorTimer = useRef<number | null>(null);
  const pending = useUIStore((s) => s.draftImages);
  const setValue = (text: string) => {
    setValueState(text);
    valueRef.current = text;
    if (mirrorTimer.current !== null) window.clearTimeout(mirrorTimer.current);
    if (text) {
      mirrorTimer.current = window.setTimeout(() => {
        mirrorTimer.current = null;
        useNotesStore.getState().setDraftText(text);
      }, 300);
    } else {
      // 提交/清空立刻落定，避免防抖窗口内退出把已提交草稿复活
      mirrorTimer.current = null;
      useNotesStore.getState().setDraftText("");
    }
  };
  const storeDraft = useNotesStore((s) => s.draftText);
  useEffect(() => {
    // 水合可能晚于挂载（skipHydration）：持久草稿到达且本地仍为空时采纳；
    // 用户已开始输入则以本地为准，不覆盖
    if (storeDraft && !valueRef.current) {
      setValueState(storeDraft);
      valueRef.current = storeDraft;
    }
  }, [storeDraft]);
  useEffect(() => {
    // 挂载时若收编了旧版 localStorage 草稿（store 尚空），补写进 store
    const state = useNotesStore.getState();
    if (valueRef.current && !state.draftText) {
      state.setDraftText(valueRef.current);
    }
    return () => {
      // 卸载前把防抖中的镜像冲出去，切页不丢最后一击键
      if (mirrorTimer.current !== null) {
        window.clearTimeout(mirrorTimer.current);
        mirrorTimer.current = null;
        useNotesStore.getState().setDraftText(valueRef.current);
      }
    };
  }, []);
  const setPending = (
    update: DraftPendingImage[] | ((cur: DraftPendingImage[]) => DraftPendingImage[])
  ) => {
    const ui = useUIStore.getState();
    ui.setDraftImages(
      typeof update === "function" ? update(ui.draftImages) : update
    );
  };
  const dataLocked = useDataOperationStore((state) => state.locked);
  const sections = useNotesStore((s) => s.sections);
  const lastDraftSectionId = useNotesStore(
    (s) => s.settings.lastDraftSectionId
  );
  const targetSections = useMemo(
    () => draftTargetSections(sections),
    [sections]
  );
  const sectionId = resolveDraftSectionId(sections, lastDraftSectionId);
  const selectedSection =
    targetSections.find((section) => section.id === sectionId) ?? targetSections[0];

  useEffect(() => {
    if (dataLocked) setPending([]);
  }, [dataLocked]);

  useEffect(() => {
    const invalidated = listen(DATA_CONTEXT_INVALIDATED_EVENT, () => setPending([]));
    return () => {
      invalidated.then((stop) => stop());
    };
  }, []);

  const submit = () => {
    const text = value.trim();
    const validPending = pending.filter((image) =>
      matchesDataGeneration(image.dataGeneration)
    );
    if (!text && validPending.length === 0) return;
    if (lastDraftSectionId !== sectionId) {
      useNotesStore.getState().setSettings({ lastDraftSectionId: sectionId });
    }
    const first = validPending[0];
    const { result, id } = useNotesStore.getState().addNote(
      text ||
        (validPending.length > 1
          ? `图片 ${validPending.length} 张`
          : `图片 ${first!.width}×${first!.height}`),
      first
        ? {
            sectionId,
            // 有文字 = 组合卡（kind 固定 text，绕过链接检测保住图文混排展示）
            kind: text ? "text" : "image",
            imageFile: first.file,
            imageW: first.width,
            imageH: first.height,
            attachments: validPending.slice(1).map((p) => p.file),
          }
        : { sectionId }
    );
    if (result === "duplicate") tip("duplicate", "");
    if (result === "added") {
      if (first) tip("added", text ? "已添加图文笔记" : "已添加图片");
      if (id && !first) void enrichLinkMeta(id);
    }
    setValue("");
    setPending([]);
  };

  /** ↗ 转大窗：当前草稿（文字 + 暂存图）落卡后直接开详情窗接着写；
   *  空草稿等价「新建笔记」大窗流程（占位文案整选，落指即替换）。 */
  const expandToDetail = () => {
    if (isDataOperationLocked()) return;
    const text = value.trim();
    const validPending = pending.filter((image) =>
      matchesDataGeneration(image.dataGeneration)
    );
    if (lastDraftSectionId !== sectionId) {
      useNotesStore.getState().setSettings({ lastDraftSectionId: sectionId });
    }
    const first = validPending[0];
    const { result, id } = useNotesStore.getState().addNote(
      text ||
        (first
          ? validPending.length > 1
            ? `图片 ${validPending.length} 张`
            : `图片 ${first.width}×${first.height}`
          : "新笔记"),
      first
        ? {
            sectionId,
            kind: text ? "text" : "image",
            imageFile: first.file,
            imageW: first.width,
            imageH: first.height,
            attachments: validPending.slice(1).map((p) => p.file),
          }
        : { sectionId }
    );
    if (!id || (result !== "added" && result !== "duplicate")) return;
    setValue("");
    setPending([]);
    openNoteDetail(id, true, !text && !first);
  };

  /** 粘贴图片：Rust 直读剪贴板入库（哈希去重），暂存为 chip 不立即成卡。 */
  const pasteImage = async () => {
    if (isDataOperationLocked()) return;
    const lease = beginDataGenerationLease();
    try {
      const images = await api.pasteImagesFromClipboard();
      if (!matchesDataGeneration(lease.generation)) return;
      if (!images.length) {
        tip("info", "剪贴板里没有可用图片");
        return;
      }
      setPending((p) => {
        const next = [...p];
        for (const img of images) {
          if (!next.some((x) => x.file === img.file)) {
            next.push({ ...img, dataGeneration: lease.generation });
          }
        }
        return next;
      });
    } catch (e) {
      tip("warn", `粘贴图片失败：${e}`);
    } finally {
      lease.release();
    }
  };

  return (
    // 必须自成定位层：三页堆叠层（PageSlide）激活页是 z-1，而本组件的
    // PillInput 因 backdrop-blur 自成层叠上下文、只等效 z-0——分组下拉向上
    // 弹出时会整体沉到页层之下，被 ScrollArea 的透明视口截走点击（看得见点不到）
    <div data-note-draft-input className="relative z-10 px-3 pb-3 pt-1.5">
      <PillInput
        multiline
        value={value}
        onChange={setValue}
        onSubmit={submit}
        onPasteImage={() => void pasteImage()}
        canSubmitEmpty={pending.length > 0}
        leftSlot={
          <SimpleMenu
            align="start"
            side="top"
            className="flex shrink-0"
            menuClassName="w-44"
            trigger={({ open, toggle }) => (
              <button
                type="button"
                aria-label={`添加到分组：${selectedSection?.name ?? "收件箱"}`}
                aria-expanded={open}
                onClick={toggle}
                className={
                  "flex h-6 max-w-24 shrink-0 items-center gap-1 rounded-md px-1.5 " +
                  "text-label text-muted-foreground outline-none hover:bg-black/5 hover:text-foreground " +
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background dark:hover:bg-white/10"
                }
              >
                <FolderInput className="size-3 shrink-0" />
                <span className="truncate">{selectedSection?.name ?? "收件箱"}</span>
                <ChevronUp
                  className={`size-2.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
                />
              </button>
            )}
          >
            {(close) => (
              <>
                {targetSections.map((section) => (
                  <SimpleMenuItem
                    key={section.id}
                    onClick={() => {
                      useNotesStore
                        .getState()
                        .setSettings({ lastDraftSectionId: section.id });
                      close();
                    }}
                  >
                    <Check
                      className={
                        section.id === sectionId ? "size-3.5" : "size-3.5 opacity-0"
                      }
                    />
                    <span className="truncate">{section.name}</span>
                  </SimpleMenuItem>
                ))}
              </>
            )}
          </SimpleMenu>
        }
        attachmentsSlot={
          pending.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {pending.map((p) => (
                <PendingThumb
                  key={p.file}
                  image={p}
                  onOpen={() => void api.quickLook(
                    pending.map((image) => image.file),
                    pending.findIndex((image) => image.file === p.file),
                    undefined,
                    { kind: "draft", dataGeneration: p.dataGeneration }
                  )}
                  onRemove={() =>
                    // 只从暂存移除；媒体文件按内容哈希命名，可能被其他卡共享，不删盘
                    setPending((cur) => cur.filter((x) => x.file !== p.file))
                  }
                />
              ))}
            </div>
          ) : undefined
        }
        rightSlot={
          <IconButton
            label="转大窗编辑（草稿与暂存图一起带走）"
            stopPropagation={false}
            disabled={dataLocked}
            onClick={expandToDetail}
            className="mb-0.5"
          >
            <ArrowUpRight className="size-3.5" />
          </IconButton>
        }
        placeholder={pending.length > 0 ? "配点文字，回车一起入卡…" : "添加笔记或提示词…"}
      />
    </div>
  );
}
