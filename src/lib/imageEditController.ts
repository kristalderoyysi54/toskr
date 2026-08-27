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
} from "@/lib/imageEditor";
import { api } from "@/lib/tauri";
import { emitToDetailWindows } from "@/lib/detailWindows";
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
        ) && region.width > 0 && region.height > 0
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
  if (!validImageEditRequest(payload)) return rejected("图片编辑请求无效，请重试");
  if (isDataOperationLocked()) return rejected("数据操作进行中，图片未修改");
  if (imageEditWasCancelled(payload.requestId)) {
    return rejected("图片编辑已取消");
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
      ) return rejected("发送预检已变化，请重新打开图片");
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
            message: "手动打码已应用到本次发送副本",
            editedFile: applied.file,
            width: applied.width,
            height: applied.height,
            draftRevision: applied.draftRevision,
          }
        : rejected("发送预检已变化，打码结果未应用");
    }

    const target = payload.target;
    const generation = target.dataGeneration;
    if (
      !Number.isSafeInteger(generation) ||
      generation !== lease.generation ||
      !matchesDataGeneration(generation)
    ) return rejected("数据上下文已变化，图片未修改");

    let noteForwardSequence: number | undefined;
    if (target.kind === "note") {
      const note = useNotesStore.getState().notes.find(
        (entry) => entry.id === target.noteId
      );
      if (!note || !noteImages(note).includes(payload.sourceFile)) {
        return rejected("卡片中的图片已变化，请重新打开");
      }
    } else {
      const current = useUIStore.getState().draftImages;
      if (!current.some((image) =>
        image.file === payload.sourceFile && image.dataGeneration === generation
      )) return rejected("草稿图片已变化，请重新打开");
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
      return rejected("图片编辑已取消，结果未保存");
    }
    if (!validPersistentResult(payload.sourceFile, result)) {
      return rejected("图片处理结果无效，原图未修改");
    }
    if (!matchesDataGeneration(generation)) {
      scheduleMediaGc([result.redactedFile], 0);
      return rejected("数据上下文已变化，打码结果未保存");
    }

    if (target.kind === "note") {
      const liveNote = useNotesStore.getState().notes.find(
        (entry) => entry.id === target.noteId
      );
      if (!liveNote || !noteImages(liveNote).includes(payload.sourceFile)) {
        scheduleMediaGc([result.redactedFile], 0);
        return rejected("卡片中的图片已变化，打码结果未保存");
      }
      if (
        result.redactedFile === payload.sourceFile ||
        noteImages(liveNote).includes(result.redactedFile)
      ) {
        return rejected(
          result.redactedFile === payload.sourceFile
            ? "所选区域未改变图片"
            : "打码结果与卡片现有图片重复，未应用"
        );
      }
      const beforeBlocks = noteContentBlocks(liveNote);
      const replaced = useNotesStore.getState().replaceNoteImage(
        target.noteId,
        payload.sourceFile,
        {
          file: result.redactedFile,
          width: result.imageWidth,
          height: result.imageHeight,
        },
        { snapshot: false }
      );
      if (!replaced) {
        scheduleMediaGc([result.redactedFile], 0);
        return rejected("卡片中的图片已变化，打码结果未保存");
      }
      if (result.redactedFile !== payload.sourceFile) {
        scheduleMediaGc([payload.sourceFile]);
      }
      noteForwardSequence = nextNoteImageEditSequence();
      const replacedPayload: NoteImageReplacedPayload = {
        operationId: payload.requestId,
        direction: "forward",
        sequence: noteForwardSequence,
        noteId: target.noteId,
        dataGeneration: generation,
        sourceFile: payload.sourceFile,
        editedFile: result.redactedFile,
        width: result.imageWidth,
        height: result.imageHeight,
      };
      broadcastNoteImageReplacement(replacedPayload);
      const originalImage = beforeBlocks.find(
        (block): block is Extract<NoteContentBlock, { type: "image" }> =>
          block.type === "image" && block.file === payload.sourceFile
      );
      const expectedImageFiles = beforeBlocks.flatMap((block) =>
        block.type === "image"
          ? [block.file === payload.sourceFile ? result.redactedFile : block.file]
          : []
      );
      setPendingUndo(() => {
        const store = useNotesStore.getState();
        const current = store.notes.find(
          (entry) => entry.id === target.noteId
        );
        const currentBlocks = current ? noteContentBlocks(current) : [];
        const currentImageFiles = currentBlocks.flatMap((block) =>
          block.type === "image" ? [block.file] : []
        );
        const imagesUnchanged =
          currentImageFiles.length === expectedImageFiles.length &&
          currentImageFiles.every((file, index) => file === expectedImageFiles[index]);
        if (matchesDataGeneration(generation) && current && imagesUnchanged) {
          store.updateNoteContent(
            target.noteId,
            currentBlocks.map((block) =>
              block.type === "image" && block.file === result.redactedFile
                ? {
                    ...block,
                    file: payload.sourceFile,
                    width: originalImage?.width ?? result.imageWidth,
                    height: originalImage?.height ?? result.imageHeight,
                  }
                : block
            )
          );
          scheduleMediaGc([result.redactedFile]);
          broadcastNoteImageReplacement(
            {
              operationId: payload.requestId,
              direction: "undo",
              sequence: nextNoteImageEditSequence(),
              noteId: target.noteId,
              dataGeneration: generation,
              sourceFile: result.redactedFile,
              editedFile: payload.sourceFile,
              width: originalImage?.width ?? result.imageWidth,
              height: originalImage?.height ?? result.imageHeight,
            },
            true
          );
          tip("undone", "已撤销编辑图片");
          return;
        }
        tip("info", "图片或数据已变化，未撤销打码");
      });
      tip("ok", "图片已打码", true);
    } else {
      const current = useUIStore.getState().draftImages;
      if (!current.some((image) =>
        image.file === payload.sourceFile && image.dataGeneration === generation
      )) {
        scheduleMediaGc([result.redactedFile], 0);
        return rejected("草稿图片已变化，打码结果未保存");
      }
      if (
        result.redactedFile === payload.sourceFile ||
        current.some((image) => image.file === result.redactedFile)
      ) {
        return rejected(
          result.redactedFile === payload.sourceFile
            ? "所选区域未改变图片"
            : "打码结果与草稿现有图片重复，未应用"
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
          tip("undone", "已撤销编辑草稿图片");
          return;
        }
        tip("info", "草稿图片或数据已变化，未撤销打码");
      });
      tip("ok", "草稿图片已打码", true);
    }
    return {
      requestId: payload.requestId,
      ok: true,
      message: "图片打码已保存",
      editedFile: result.redactedFile,
      width: result.imageWidth,
      height: result.imageHeight,
      ...(noteForwardSequence !== undefined
        ? { noteSequence: noteForwardSequence }
        : {}),
    };
  } catch (error) {
    return rejected(`图片打码失败：${userError(error)}`);
  } finally {
    if (!imageEditWasCancelled(payload.requestId)) {
      rememberImageEditRequest(payload.requestId, "settled");
    }
    lease.release();
  }
}
