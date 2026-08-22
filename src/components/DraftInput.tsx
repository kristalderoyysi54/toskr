import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronUp, FolderInput, X } from "lucide-react";

import { SimpleMenu, SimpleMenuItem } from "@/components/SimpleMenu";
import { PillInput } from "@/components/ui/pill-input";
import { enrichLinkMeta } from "@/lib/actions";
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

/** 草稿文字的 localStorage 镜像键（抗重启；提交/清空时移除）。 */
const DRAFT_TEXT_STORAGE_KEY = "toskr-draft-input-text";

const readStoredDraftText = () => {
  try {
    return localStorage.getItem(DRAFT_TEXT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};

const writeStoredDraftText = (text: string) => {
  try {
    if (text) localStorage.setItem(DRAFT_TEXT_STORAGE_KEY, text);
    else localStorage.removeItem(DRAFT_TEXT_STORAGE_KEY);
  } catch {
    /* 存储不可用时草稿仅存活于当前挂载 */
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
  // 未提交草稿必须扛住组件卸载（切页/收横栏即卸载）：文字初值从 localStorage
  // 恢复并写穿（重启也不丢）；暂存图片提升到 uiStore 会话级（图片文件未被
  // 任何卡片引用，可能被媒体清理回收，刻意不跨重启恢复）
  const [value, setValueState] = useState(readStoredDraftText);
  const pending = useUIStore((s) => s.draftImages);
  const setValue = (text: string) => {
    setValueState(text);
    writeStoredDraftText(text);
  };
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
    <div data-note-draft-input className="px-3 pb-3 pt-1.5">
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
        placeholder={pending.length > 0 ? "配点文字，回车一起入卡…" : "添加笔记或提示词…"}
      />
    </div>
  );
}
