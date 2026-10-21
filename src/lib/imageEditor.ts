import type { ImagePixelBox, RedactionRegion, RedactionStyle } from "@/lib/tauri";

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
  regions: RedactionRegion[];
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

// ===== 打码样式与框编辑（纯函数；像素算法与 Rust image_firewall 同构） =====

export const REDACTION_BLACK: [number, number, number] = [20, 20, 22];
export const REDACTION_WHITE: [number, number, number] = [255, 255, 255];

const REDACTION_STYLE_KEY = "toskr.redactionStyle";

/**
 * 打码样式偏好：手动打码的新框和发送前检查的自动遮挡共用（用户 2026-10-21 指定）。
 * 存 localStorage：同源 WebView 共享，详情窗写、主窗口读（同 colorScheme 的做法）；
 * 读不到或值无效时默认马赛克。
 */
export function loadRedactionStyle(): RedactionStyle {
  try {
    const saved = JSON.parse(localStorage.getItem(REDACTION_STYLE_KEY) ?? "null");
    if (saved && validRedactionStyle(saved)) return saved as RedactionStyle;
  } catch {
    /* 读不到就用默认 */
  }
  return { kind: "mosaic" };
}

export function saveRedactionStyle(style: RedactionStyle) {
  try {
    localStorage.setItem(REDACTION_STYLE_KEY, JSON.stringify(style));
  } catch {
    /* 存不下只影响下次默认值 */
  }
}

/** 选中框浮条与工具栏共用的样式选项。 */
export const REDACTION_STYLE_OPTIONS: { style: RedactionStyle; label: string }[] = [
  { style: { kind: "mosaic" }, label: "马赛克" },
  { style: { kind: "solid", color: REDACTION_BLACK }, label: "黑色" },
  { style: { kind: "solid", color: REDACTION_WHITE }, label: "白色" },
  { style: { kind: "pick" }, label: "取色（框外平均色）" },
];

/** 跨窗请求的样式校验：缺省合法（= 近黑实色）；未知种类（含模糊）一律拒绝。 */
export function validRedactionStyle(style: unknown): boolean {
  if (style === undefined) return true;
  if (!style || typeof style !== "object") return false;
  const value = style as { kind?: unknown; color?: unknown };
  if (value.kind === "pick" || value.kind === "mosaic") return true;
  return value.kind === "solid" &&
    Array.isArray(value.color) && value.color.length === 3 &&
    value.color.every((c) => Number.isInteger(c) && c >= 0 && c <= 255);
}

export function sameRedactionStyle(a: RedactionStyle, b: RedactionStyle): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "solid" && b.kind === "solid") {
    return a.color.every((c, i) => c === b.color[i]);
  }
  return true;
}

/** 马赛克块边长：至少 12px，且不小于框短边的 1/3（与 Rust mosaic_block 一致）。 */
export function mosaicBlock(box: ImagePixelBox): number {
  return Math.max(12, Math.floor(Math.min(box.width, box.height) / 3));
}

type Pixels = { data: Uint8ClampedArray; width: number; height: number };

function averageAt(src: Pixels, points: Iterable<[number, number]>) {
  let r = 0, g = 0, b = 0, n = 0;
  for (const [x, y] of points) {
    const k = (y * src.width + x) * 4;
    r += src.data[k]!; g += src.data[k + 1]!; b += src.data[k + 2]!; n += 1;
  }
  return n ? [Math.floor(r / n), Math.floor(g / n), Math.floor(b / n)] as const : null;
}

function* rect(x0: number, y0: number, x1: number, y1: number): Generator<[number, number]> {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) yield [x, y];
}

/**
 * 按样式算出框内像素（RGBA，box.width × box.height）。
 * src 是原图（或包含「框 + 外扩 1px」的裁切），box 为 src 内坐标；
 * imageBox 是框在整图里的位置，用来让马赛克的块分割与整图出图对齐。
 */
export function redactedRegionPixels(
  src: Pixels,
  box: ImagePixelBox,
  style: RedactionStyle,
  imageBox: ImagePixelBox = box
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(box.width * box.height * 4);
  const fill = (x0: number, y0: number, x1: number, y1: number, c: readonly number[]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const k = ((y - box.y) * box.width + (x - box.x)) * 4;
      out[k] = c[0]!; out[k + 1] = c[1]!; out[k + 2] = c[2]!; out[k + 3] = 255;
    }
  };
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  if (style.kind === "solid") {
    fill(box.x, box.y, right, bottom, style.color);
  } else if (style.kind === "pick") {
    const ring: [number, number][] = [];
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < src.width && y < src.height;
    for (let x = box.x - 1; x <= right; x++) {
      for (const y of [box.y - 1, bottom]) if (inside(x, y)) ring.push([x, y]);
    }
    for (let y = box.y; y < bottom; y++) {
      for (const x of [box.x - 1, right]) if (inside(x, y)) ring.push([x, y]);
    }
    const color = averageAt(src, ring) ??
      averageAt(src, rect(box.x, box.y, right, bottom)) ?? REDACTION_BLACK;
    fill(box.x, box.y, right, bottom, color);
  } else {
    const block = mosaicBlock(imageBox);
    for (let by = box.y; by < bottom; by += block) {
      const by1 = Math.min(by + block, bottom);
      for (let bx = box.x; bx < right; bx += block) {
        const bx1 = Math.min(bx + block, right);
        const color = averageAt(src, rect(bx, by, bx1, by1));
        if (color) fill(bx, by, bx1, by1, color);
      }
    }
  }
  return out;
}

export type ResizeHandle = "nw" | "ne" | "sw" | "se";

/** 平移框，整体夹在图内。 */
export function moveBox(
  box: ImagePixelBox,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number
): ImagePixelBox {
  return {
    ...box,
    x: Math.min(imageWidth - box.width, Math.max(0, Math.round(box.x + dx))),
    y: Math.min(imageHeight - box.height, Math.max(0, Math.round(box.y + dy))),
  };
}

/** 拖角缩放：对角固定，拖过对角会翻转；越界夹回图内，最小 1px。 */
export function resizeBox(
  box: ImagePixelBox,
  handle: ResizeHandle,
  point: Point,
  imageWidth: number,
  imageHeight: number
): ImagePixelBox {
  const fixed = {
    x: handle.endsWith("w") ? box.x + box.width : box.x,
    y: handle.startsWith("n") ? box.y + box.height : box.y,
  };
  return pixelBoxFromDrag(fixed, point, imageWidth, imageHeight) ?? box;
}

/** 从 Rust 复检错误里取出未通过的框序号（1 起），没有则空数组。 */
export function failedRegionNumbers(message: string): number[] {
  const match = /第 ([\d、]+) 处/.exec(message);
  if (!match) return [];
  return match[1]!.split("、").map(Number).filter((n) => Number.isInteger(n) && n > 0);
}
