import type { ImagePixelBox } from "@/lib/tauri";

export const IMAGE_EDIT_REQUEST_EVENT = "toskr://image-edit-request";
export const IMAGE_EDIT_RESULT_EVENT = "toskr://image-edit-result";
export const IMAGE_EDIT_CANCEL_EVENT = "toskr://image-edit-cancel";
export const IMAGE_EDIT_CANCEL_RESULT_EVENT = "toskr://image-edit-cancel-result";
export const NOTE_IMAGE_REPLACED_EVENT = "toskr://note-image-replaced";
export const DRAFT_IMAGE_REPLACED_EVENT = "toskr://draft-image-replaced";

export type ImageEditTarget =
  | {
      kind: "note";
      noteId: string;
      dataGeneration: number;
    }
  | {
      kind: "draft";
      dataGeneration: number;
    }
  | {
      kind: "delivery";
      draftId: string;
      draftRevision: number;
      originalFile: string;
    };

/** Rust 窗口层只透传该路由元数据；真正的来源新鲜度仍由 owner WebView 校验。 */
export type ImagePreviewEditContext = ImageEditTarget & { startEditing?: boolean };

export type ImageEditRequestPayload = {
  requestId: string;
  target: ImageEditTarget;
  sourceFile: string;
  regions: ImagePixelBox[];
};

export type ImageEditResultPayload = {
  requestId: string;
  ok: boolean;
  message: string;
  editedFile?: string;
  width?: number;
  height?: number;
  draftRevision?: number;
  noteSequence?: number;
};

export type ImageEditCancelResultPayload = {
  requestId: string;
  status: "cancelled" | "settled";
};

export type NoteImageReplacedPayload = {
  /** 关联触发本次替换的图片编辑请求，供跨窗乱序时拒绝已撤销回执。 */
  operationId: string;
  direction: "forward" | "undo";
  /** owner 针对同一笔记单调递增，跨操作乱序只接收较新的权威状态。 */
  sequence: number;
  noteId: string;
  dataGeneration: number;
  sourceFile: string;
  editedFile: string;
  width: number;
  height: number;
};

export type DraftImageReplacedPayload = {
  operationId: string;
  direction: "undo";
  dataGeneration: number;
  sourceFile: string;
  editedFile: string;
  width: number;
  height: number;
};

export type ContainedImageRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function containedImageRect(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number
): ContainedImageRect | null {
  if (
    ![containerWidth, containerHeight, imageWidth, imageHeight].every(
      (value) => Number.isFinite(value) && value > 0
    )
  ) return null;
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  };
}

type Point = { x: number; y: number };

export function imagePointFromClient(
  point: Point,
  container: { left: number; top: number },
  imageRect: ContainedImageRect,
  imageWidth: number,
  imageHeight: number
): Point {
  const localX = point.x - container.left - imageRect.left;
  const localY = point.y - container.top - imageRect.top;
  return {
    x: Math.min(imageWidth, Math.max(0, localX / imageRect.width * imageWidth)),
    y: Math.min(imageHeight, Math.max(0, localY / imageRect.height * imageHeight)),
  };
}

export function pixelBoxFromDrag(
  start: Point,
  end: Point,
  imageWidth: number,
  imageHeight: number
): ImagePixelBox | null {
  const left = Math.max(0, Math.floor(Math.min(start.x, end.x)));
  const top = Math.max(0, Math.floor(Math.min(start.y, end.y)));
  const right = Math.min(imageWidth, Math.ceil(Math.max(start.x, end.x)));
  const bottom = Math.min(imageHeight, Math.ceil(Math.max(start.y, end.y)));
  const width = right - left;
  const height = bottom - top;
  return width > 0 && height > 0 ? { x: left, y: top, width, height } : null;
}

export function pixelBoxStyle(
  box: ImagePixelBox,
  imageRect: ContainedImageRect,
  imageWidth: number,
  imageHeight: number
) {
  return {
    left: imageRect.left + box.x / imageWidth * imageRect.width,
    top: imageRect.top + box.y / imageHeight * imageRect.height,
    width: box.width / imageWidth * imageRect.width,
    height: box.height / imageHeight * imageRect.height,
  };
}

/** object-contain 基准框经“容器中心缩放 + 平移”后的真实显示框。 */
export function transformedImageRect(
  base: ContainedImageRect,
  view: { zoom: number; x: number; y: number }
): ContainedImageRect {
  const width = base.width * view.zoom;
  const height = base.height * view.zoom;
  return {
    left: base.left + base.width / 2 + view.x - width / 2,
    top: base.top + base.height / 2 + view.y - height / 2,
    width,
    height,
  };
}

export function imageEditRequestId() {
  return globalThis.crypto?.randomUUID?.() ??
    `image-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** WebView 本地水位：同一笔记只接收 owner 更新过的更大序号。 */
export function advanceNoteImageEditSequence(
  sequences: Map<string, number>,
  noteId: string,
  dataGeneration: number,
  sequence: number
): boolean {
  if (
    !noteId || !Number.isSafeInteger(dataGeneration) || dataGeneration < 0 ||
    !Number.isSafeInteger(sequence) || sequence <= 0
  ) return false;
  const key = `${dataGeneration}:${noteId}`;
  if (sequence <= (sequences.get(key) ?? 0)) return false;
  sequences.set(key, sequence);
  return true;
}
