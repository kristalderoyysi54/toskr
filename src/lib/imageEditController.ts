import { emitTo } from "@tauri-apps/api/event";

import {
  beginDataGenerationLease,
  matchesDataGeneration,
} from "@/lib/dataGeneration";
import { manuallyRedactOpenDeliveryImage } from "@/lib/delivery/imageFirewall";
import {
  DRAFT_IMAGE_REPLACED_EVENT,
  NOTE_IMAGE_REPLACED_EVENT,
  type DraftImageReplacedPayload,
  type ImageEditRequestPayload,
  type ImageEditResultPayload,
  type NoteImageReplacedPayload,
  validRedactionStyle,
} from "@/lib/imageEditor";
import { api } from "@/lib/tauri";
import { emitToDetailWindows } from "@/lib/detailWindows";
import { imageCaption } from "@/lib/format";
import { t } from "@/lib/i18n";
import { setPendingUndo, tip } from "@/lib/tip";
import {
  isDataOperationLocked,
} from "@/store/dataOperationStore";
import {
  noteContentBlocks,
  noteImages,
  useNotesStore,
  type NoteContentBlock,
} from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

export type ScheduleEditedMediaGc = (files: string[], graceMs?: number) => void;

type ImageEditRequestState = "processing" | "cancelled" | "settled";
const imageEditRequestStates = new Map<string, ImageEditRequestState>();
let noteImageEditSequence = 0;

function nextNoteImageEditSequence() {
  noteImageEditSequence += 1;
  return noteImageEditSequence;
}

function rememberImageEditRequest(
  requestId: string,
  state: ImageEditRequestState
) {
  imageEditRequestStates.delete(requestId);
  imageEditRequestStates.set(requestId, state);
  while (imageEditRequestStates.size > 512) {
    const oldest = imageEditRequestStates.keys().next().value;
    if (typeof oldest !== "string") break;
    imageEditRequestStates.delete(oldest);
  }
}

export function cancelImageEditRequest(
  requestId: string
): "cancelled" | "settled" {
  if (
    typeof requestId !== "string" || !requestId ||
    imageEditRequestStates.get(requestId) === "settled"
  ) return "settled";
  rememberImageEditRequest(requestId, "cancelled");
  return "cancelled";
}

function imageEditWasCancelled(requestId: string) {
  return imageEditRequestStates.get(requestId) === "cancelled";
}

function userError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function validImageEditRequest(payload: ImageEditRequestPayload): boolean {
  const maxU32 = 0xffff_ffff;
  return Boolean(
    payload &&
    typeof payload.requestId === "string" &&
    payload.requestId.length > 0 &&
    payload.requestId.length <= 160 &&
    typeof payload.sourceFile === "string" &&
    payload.sourceFile.length > 0 &&
    Array.isArray(payload.regions) &&
    payload.regions.length > 0 &&
    payload.regions.length <= 256 &&
    payload.regions.every((region) =>
      Boolean(
        region && typeof region === "object" &&
        [region.x, region.y, region.width, region.height].every(
          (value) =>
            Number.isSafeInteger(value) && value >= 0 && value <= maxU32
        ) && region.width > 0 && region.height > 0 &&
        validRedactionStyle(region.style)
      )
    ) &&
    payload.target &&
    typeof payload.target === "object" &&
    ["note", "draft", "delivery"].includes(payload.target.kind)
  );
}

function validPersistentResult(
  sourceFile: string,
  result: Awaited<ReturnType<typeof api.redactDeliveryImage>>
): boolean {
  return result.originalFile === sourceFile &&
    Boolean(result.redactedFile) &&
    !result.redactedFile.startsWith("toskr-redacted:") &&
    result.originalPixelHash.length === 64 &&
    result.redactedPixelHash.length === 64 &&
    Number.isSafeInteger(result.imageWidth) && result.imageWidth > 0 &&
    Number.isSafeInteger(result.imageHeight) && result.imageHeight > 0;
}

function broadcastNoteImageReplacement(
  payload: NoteImageReplacedPayload,
  includeImagePreview = false
) {
  emitToDetailWindows(NOTE_IMAGE_REPLACED_EVENT, payload);
  if (includeImagePreview) {
    void emitTo("imgpreview", NOTE_IMAGE_REPLACED_EVENT, payload).catch(() => {});
  }
}

function broadcastDraftImageReplacement(payload: DraftImageReplacedPayload) {
  void emitTo("imgpreview", DRAFT_IMAGE_REPLACED_EVENT, payload).catch(() => {});
}

type NoteImageReplacement = {
  operationId: string;
  noteId: string;
  dataGeneration: number;
  sourceFile: string;
  editedFile: string;
  width: number;
  height: number;
  /** 批注编号说明（仅标注写回带）：追加到图片卡备注。 */
  caption?: string | null;
};

type NoteImageReplacementText = {
  stale: string;
  unchanged: string;
  duplicate: string;
  undoStale: string;
  done: string;
};

/**
 * 把图片卡里的 sourceFile 原子替换为 editedFile，广播给详情窗并挂上撤销。
 * 打码与标注共用；调用方已校验数据代际。失败时新文件交 GC，原图不动。
 */
function commitNoteImageReplacement(
  op: NoteImageReplacement,
  scheduleMediaGc: ScheduleEditedMediaGc,
  text: NoteImageReplacementText,
  includeImagePreview = false
): { sequence: number } | { error: string } {
  const liveNote = useNotesStore.getState().notes.find(
    (entry) => entry.id === op.noteId
  );
  if (!liveNote || !noteImages(liveNote).includes(op.sourceFile)) {
    scheduleMediaGc([op.editedFile], 0);
    return { error: text.stale };
  }
  if (
    op.editedFile === op.sourceFile ||
    noteImages(liveNote).includes(op.editedFile)
  ) {
    return {
      error: op.editedFile === op.sourceFile ? text.unchanged : text.duplicate,
    };
  }
  const beforeBlocks = noteContentBlocks(liveNote);
  const replaced = useNotesStore.getState().replaceNoteImage(
    op.noteId,
    op.sourceFile,
    { file: op.editedFile, width: op.width, height: op.height },
    { snapshot: false }
  );
  if (!replaced) {
    scheduleMediaGc([op.editedFile], 0);
    return { error: text.stale };
  }
  scheduleMediaGc([op.sourceFile]);
  const sequence = nextNoteImageEditSequence();
  broadcastNoteImageReplacement(
    {
      operationId: op.operationId,
      direction: "forward",
      sequence,
      noteId: op.noteId,
      dataGeneration: op.dataGeneration,
      sourceFile: op.sourceFile,
      editedFile: op.editedFile,
      width: op.width,
      height: op.height,
    },
    includeImagePreview
  );
  const originalImage = beforeBlocks.find(
    (block): block is Extract<NoteContentBlock, { type: "image" }> =>
      block.type === "image" && block.file === op.sourceFile
  );
  const expectedImageFiles = beforeBlocks.flatMap((block) =>
    block.type === "image"
      ? [block.file === op.sourceFile ? op.editedFile : block.file]
      : []
  );
  setPendingUndo(() => {
    const store = useNotesStore.getState();
    const current = store.notes.find((entry) => entry.id === op.noteId);
    const currentBlocks = current ? noteContentBlocks(current) : [];
    const currentImageFiles = currentBlocks.flatMap((block) =>
      block.type === "image" ? [block.file] : []
    );
    const imagesUnchanged =
      currentImageFiles.length === expectedImageFiles.length &&
      currentImageFiles.every((file, index) => file === expectedImageFiles[index]);
    if (matchesDataGeneration(op.dataGeneration) && current && imagesUnchanged) {
      store.updateNoteContent(
        op.noteId,
        currentBlocks.map((block) =>
          block.type === "image" && block.file === op.editedFile
            ? {
                ...block,
                file: op.sourceFile,
                width: originalImage?.width ?? op.width,
                height: originalImage?.height ?? op.height,
              }
            : block
        )
      );
      scheduleMediaGc([op.editedFile]);
      broadcastNoteImageReplacement(
        {
          operationId: op.operationId,
          direction: "undo",
          sequence: nextNoteImageEditSequence(),
          noteId: op.noteId,
          dataGeneration: op.dataGeneration,
          sourceFile: op.editedFile,
          editedFile: op.sourceFile,
          width: originalImage?.width ?? op.width,
          height: originalImage?.height ?? op.height,
        },
        true
      );
      tip("undone", t("已撤销编辑图片"));
      return;
    }
    tip("info", text.undoStale);
  });
  tip("ok", text.done, true);
  return { sequence };
}

/** 标注窗写回图片卡（Rust 已把标注后的图存进媒体库）：校验数据代际后替换原图，可撤销。 */
export function applyAnnotatedNoteImage(
  op: NoteImageReplacement,
  scheduleMediaGc: ScheduleEditedMediaGc
) {
  if (isDataOperationLocked() || !matchesDataGeneration(op.dataGeneration)) {
    scheduleMediaGc([op.editedFile], 0);
    tip("warn", t("数据上下文已变化，标注结果未保存"));
    return;
  }
  const committed = commitNoteImageReplacement(
    op,
    scheduleMediaGc,
    {
      stale: t("卡片中的图片已变化，标注结果未保存"),
      unchanged: t("标注未改变图片"),
      duplicate: t("标注结果与卡片现有图片重复，未应用"),
      undoStale: t("图片或数据已变化，未撤销标注"),
      done: t("图片已标注"),
    },
    true
  );
  if ("error" in committed) {
    tip("warn", committed.error);
    return;
  }
  appendCalloutCaption(op.noteId, op.caption);
}

/** 只给单图的普通图片卡追加说明；图文交错卡不经文本投影改写，避免压平块顺序。 */
function appendCalloutCaption(noteId: string, caption: string | null | undefined) {
  if (!caption?.trim()) return;
  const note = useNotesStore.getState().notes.find((n) => n.id === noteId);
  if (!note || note.kind !== "image" || noteImages(note).length !== 1) return;
  const current = imageCaption(note);
  useNotesStore.getState().updateNoteText(noteId, current ? `${current}\n\n${caption}` : caption);
}

/**
 * 图片编辑 owner：校验跨窗 CAS、调用 Native 单次渲染，再原子替换目标引用。
 * UI 只提交像素框；发送副本、持久卡片和会话草稿的保存语义集中在这里。
 */
export async function applyImageEditRequest(
  payload: ImageEditRequestPayload,
  scheduleMediaGc: ScheduleEditedMediaGc
): Promise<ImageEditResultPayload> {
  const rejected = (message: string): ImageEditResultPayload => ({
    requestId:
      payload && typeof payload.requestId === "string" ? payload.requestId : "",
    ok: false,
    message,
  });
  if (!validImageEditRequest(payload)) return rejected(t("图片编辑请求无效，请重试"));
  if (isDataOperationLocked()) return rejected(t("数据操作进行中，图片未修改"));
  if (imageEditWasCancelled(payload.requestId)) {
    return rejected(t("图片编辑已取消"));
  }
  rememberImageEditRequest(payload.requestId, "processing");

  const lease = beginDataGenerationLease();
  try {
    if (payload.target.kind === "delivery") {
      const target = payload.target;
      if (
        typeof target.draftId !== "string" || !target.draftId ||
        !Number.isSafeInteger(target.draftRevision) || target.draftRevision < 0 ||
        typeof target.originalFile !== "string" || !target.originalFile
      ) return rejected(t("发送预检已变化，请重新打开图片"));
      const applied = await manuallyRedactOpenDeliveryImage({
        draftId: target.draftId,
        draftRevision: target.draftRevision,
        originalFile: target.originalFile,
        sourceFile: payload.sourceFile,
        regions: payload.regions,
      }, () => imageEditWasCancelled(payload.requestId));
      return applied
        ? {
            requestId: payload.requestId,
            ok: true,
            message: t("手动打码已应用到本次发送副本"),
            editedFile: applied.file,
            width: applied.width,
            height: applied.height,
            draftRevision: applied.draftRevision,
          }
        : rejected(t("发送预检已变化，打码结果未应用"));
    }

    const target = payload.target;
    const generation = target.dataGeneration;
    if (
      !Number.isSafeInteger(generation) ||
      generation !== lease.generation ||
      !matchesDataGeneration(generation)
    ) return rejected(t("数据上下文已变化，图片未修改"));

    let noteForwardSequence: number | undefined;
    if (target.kind === "note") {
      const note = useNotesStore.getState().notes.find(
        (entry) => entry.id === target.noteId
      );
      if (!note || !noteImages(note).includes(payload.sourceFile)) {
        return rejected(t("卡片中的图片已变化，请重新打开"));
      }
    } else {
      const current = useUIStore.getState().draftImages;
      if (!current.some((image) =>
        image.file === payload.sourceFile && image.dataGeneration === generation
      )) return rejected(t("草稿图片已变化，请重新打开"));
    }

    const result = await api.redactDeliveryImage(
      payload.sourceFile,
      payload.regions,
      true
    );
    if (imageEditWasCancelled(payload.requestId)) {
      if (typeof result.redactedFile === "string" && result.redactedFile) {
        scheduleMediaGc([result.redactedFile], 0);
      }
      return rejected(t("图片编辑已取消，结果未保存"));
    }
    if (!validPersistentResult(payload.sourceFile, result)) {
      return rejected(t("图片处理结果无效，原图未修改"));
    }
    if (!matchesDataGeneration(generation)) {
      scheduleMediaGc([result.redactedFile], 0);
      return rejected(t("数据上下文已变化，打码结果未保存"));
    }

    if (target.kind === "note") {
      const committed = commitNoteImageReplacement(
        {
          operationId: payload.requestId,
          noteId: target.noteId,
          dataGeneration: generation,
          sourceFile: payload.sourceFile,
          editedFile: result.redactedFile,
          width: result.imageWidth,
          height: result.imageHeight,
        },
        scheduleMediaGc,
        {
          stale: t("卡片中的图片已变化，打码结果未保存"),
          unchanged: t("所选区域未改变图片"),
          duplicate: t("打码结果与卡片现有图片重复，未应用"),
          undoStale: t("图片或数据已变化，未撤销打码"),
          done: t("图片已打码"),
        }
      );
      if ("error" in committed) return rejected(committed.error);
      noteForwardSequence = committed.sequence;
    } else {
      const current = useUIStore.getState().draftImages;
      if (!current.some((image) =>
        image.file === payload.sourceFile && image.dataGeneration === generation
      )) {
        scheduleMediaGc([result.redactedFile], 0);
        return rejected(t("草稿图片已变化，打码结果未保存"));
      }
      if (
        result.redactedFile === payload.sourceFile ||
        current.some((image) => image.file === result.redactedFile)
      ) {
        return rejected(
          result.redactedFile === payload.sourceFile
            ? t("所选区域未改变图片")
            : t("打码结果与草稿现有图片重复，未应用")
        );
      }
      const originalImage = current.find((image) =>
        image.file === payload.sourceFile && image.dataGeneration === generation
      )!;
      const editedDraftImages = current.map((image) =>
        image.file === payload.sourceFile && image.dataGeneration === generation
          ? {
              file: result.redactedFile,
              width: result.imageWidth,
              height: result.imageHeight,
              dataGeneration: generation,
            }
          : image
      );
      useUIStore.getState().setDraftImages(editedDraftImages);
      if (result.redactedFile !== payload.sourceFile) {
        scheduleMediaGc([payload.sourceFile]);
      }
      setPendingUndo(() => {
        const live = useUIStore.getState().draftImages;
        const unchanged = live.length === editedDraftImages.length &&
          live.every((image, index) =>
            image.file === editedDraftImages[index]?.file &&
            image.dataGeneration === editedDraftImages[index]?.dataGeneration
          );
        if (matchesDataGeneration(generation) && unchanged) {
          useUIStore.getState().setDraftImages(live.map((image) =>
            image.file === result.redactedFile &&
              image.dataGeneration === generation
              ? { ...originalImage }
              : image
          ));
          scheduleMediaGc([result.redactedFile]);
          broadcastDraftImageReplacement({
            operationId: payload.requestId,
            direction: "undo",
            dataGeneration: generation,
            sourceFile: result.redactedFile,
            editedFile: payload.sourceFile,
            width: originalImage.width,
            height: originalImage.height,
          });
          tip("undone", t("已撤销编辑草稿图片"));
          return;
        }
        tip("info", t("草稿图片或数据已变化，未撤销打码"));
      });
      tip("ok", t("草稿图片已打码"), true);
    }
    return {
      requestId: payload.requestId,
      ok: true,
      message: t("图片打码已保存"),
      editedFile: result.redactedFile,
      width: result.imageWidth,
      height: result.imageHeight,
      ...(noteForwardSequence !== undefined
        ? { noteSequence: noteForwardSequence }
        : {}),
    };
  } catch (error) {
    return rejected(t("图片打码失败：{error}", { error: userError(error) }));
  } finally {
    if (!imageEditWasCancelled(payload.requestId)) {
      rememberImageEditRequest(payload.requestId, "settled");
    }
    lease.release();
  }
}
