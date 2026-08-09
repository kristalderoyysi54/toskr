import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronUp, FolderInput, X } from "lucide-react";

import { SimpleMenu, SimpleMenuItem } from "@/components/SimpleMenu";
import { PillInput } from "@/components/ui/pill-input";
import { enrichLinkMeta } from "@/lib/actions";
import {
  beginDataGenerationLease,
  DATA_CONTEXT_INVALIDATED_EVENT,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import { useNoteThumb } from "@/lib/media";
import { api } from "@/lib/tauri";
import { tip } from "@/lib/tip";
import { CLIPBOARD_ID, INBOX_ID, useNotesStore } from "@/store/notesStore";
import {
  isDataOperationLocked,
  useDataOperationStore,
} from "@/store/dataOperationStore";

type PendingImage = {
  file: string;
  width: number;
  height: number;
  dataGeneration: number;
};

/** 暂存图片缩略 chip：悬停/聚焦出移除钮。 */
function PendingThumb({
  file,
  onRemove,
}: {
  file: string;
  onRemove: () => void;
}) {
  const url = useNoteThumb(file);
  return (
    <span
      className={
        "group/chip relative inline-flex size-9 shrink-0 overflow-hidden rounded-md " +
        "border border-foreground/10 bg-black/[0.04] dark:bg-white/[0.06]"
      }
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="m-auto size-4 animate-pulse rounded-sm bg-black/10 dark:bg-white/10" />
      )}
      <button
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
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<PendingImage[]>([]);
  const dataLocked = useDataOperationStore((state) => state.locked);
  const sections = useNotesStore((s) => s.sections);
  const targetSections = useMemo(
    () => sections.filter((section) => section.id !== CLIPBOARD_ID),
    [sections]
  );
  const [sectionId, setSectionId] = useState(() =>
    sections.some((section) => section.id === INBOX_ID)
      ? INBOX_ID
      : (targetSections[0]?.id ?? INBOX_ID)
  );
  const selectedSection =
    targetSections.find((section) => section.id === sectionId) ?? targetSections[0];

  useEffect(() => {
    if (!targetSections.some((section) => section.id === sectionId)) {
      setSectionId(targetSections[0]?.id ?? INBOX_ID);
    }
  }, [sectionId, targetSections]);

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
      const img = await api.pasteImageFromClipboard();
      if (!matchesDataGeneration(lease.generation)) return;
      if (!img) {
        tip("info", "剪贴板里没有可用图片");
        return;
      }
      const pendingImage = { ...img, dataGeneration: lease.generation };
      setPending((p) =>
        p.some((x) => x.file === img.file) ? p : [...p, pendingImage]
      );
    } catch (e) {
      tip("warn", `粘贴图片失败：${e}`);
    } finally {
      lease.release();
    }
  };

  return (
    <div className="px-3 pb-3 pt-1.5">
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
                  "focus-visible:ring-2 focus-visible:ring-primary/50 dark:hover:bg-white/10"
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
                      setSectionId(section.id);
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
                  file={p.file}
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
