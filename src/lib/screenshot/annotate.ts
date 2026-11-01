/** 截图标注：图形模型、历史栈与绘制。坐标为本屏左上角原点的 pt。 */

export type Tool = "rect" | "ellipse" | "arrow" | "pen" | "text" | "mosaic" | "spotlight" | "number";

export type Shape =
  | { kind: "rect" | "ellipse" | "arrow" | "mosaic" | "spotlight"; x1: number; y1: number; x2: number; y2: number; color: string; size: number }
  | { kind: "pen"; points: [number, number][]; color: string; size: number }
  | { kind: "text"; x: number; y: number; text: string; color: string; size: number }
  | { kind: "number"; x: number; y: number; n: number; color: string; size: number }
  | { kind: "translate"; items: TranslatedLine[] };

/** 图内翻译的一行（坐标 pt）：只抹掉原文笔画的补丁 + 译文。 */
export interface TranslatedLine {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** 识别框外扩 TRANSLATE_PAD 的补丁（冻结帧像素尺寸），非文字像素保持原样。 */
  patch: HTMLCanvasElement;
  /** 同一补丁的 data URL，供屏上 SVG 显示。 */
  patchUrl: string;
  fg: string;
  fontSize: number;
}

/** 补丁比识别框外扩（pt）：Vision 框紧贴字形，下伸笔画会露出。 */
export const TRANSLATE_PAD = 2;

export const TRANSLATE_FONT = '500 {size}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';

/** 译文字号：从框高的 0.72 起，按实测宽度缩到放得下，最小 8。 */
export function fitFontSize(w: number, h: number, measure: (font: string) => number): number {
  let size = Math.max(8, h * 0.72);
  const width = measure(TRANSLATE_FONT.replace("{size}", String(size)));
  if (width > w && width > 0) size = Math.max(8, (size * w) / width);
  return Math.round(size * 10) / 10;
}

/** 背景亮度高用黑字，否则白字。 */
export function contrastText(r: number, g: number, b: number): string {
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111111" : "#FFFFFF";
}

/** 三档粗细：线宽 / 字号 / 序号半径共用同一档位。 */
export const SIZES = [0, 1, 2] as const;
export type SizeLevel = (typeof SIZES)[number];
export const LINE_WIDTH = [2, 4, 6];
export const FONT_SIZE = [14, 18, 24];
export const NUMBER_RADIUS = [10, 13, 16];
/** 聚光灯区域外的压暗程度。 */
export const SPOTLIGHT_DIM = "rgba(0,0,0,0.55)";
/** 马赛克块边长（pt），按粗细档位：细 / 中 / 粗。 */
export const MOSAIC_BLOCK = [5, 9, 15];

// token-exception: 标注颜色画进截图像素，不随主题变化
export const COLORS = ["#FF3B30", "#FFCC00", "#34C759", "#007AFF", "#FFFFFF", "#000000"];

/** 拖得太短的图形视为误触，不入历史。 */
export function isMeaningful(s: Shape): boolean {
  if (s.kind === "pen") return s.points.length >= 2;
  if (s.kind === "text") return s.text.trim().length > 0;
  if (s.kind === "number") return true;
  if (s.kind === "translate") return s.items.length > 0;
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= 3;
}

export function nextNumber(shapes: Shape[]): number {
  return shapes.reduce((n, s) => (s.kind === "number" ? Math.max(n, s.n) : n), 0) + 1;
}

/** 快照式历史：每步记下整份图形列表，移动 / 缩放已画的图形也能撤销。 */
export interface History {
  shapes: Shape[];
  undo: Shape[][];
  redo: Shape[][];
}

export const emptyHistory: History = { shapes: [], undo: [], redo: [] };

/** 以新的图形列表作为一步。 */
export function commitShapes(h: History, shapes: Shape[]): History {
  return { shapes, undo: [...h.undo, h.shapes], redo: [] };
}

export function pushShape(h: History, s: Shape): History {
  return isMeaningful(s) ? commitShapes(h, [...h.shapes, s]) : h;
}

export function undo(h: History): History {
  const prev = h.undo.at(-1);
  return prev ? { shapes: prev, undo: h.undo.slice(0, -1), redo: [...h.redo, h.shapes] } : h;
}

export function redo(h: History): History {
  const next = h.redo.at(-1);
  return next ? { shapes: next, undo: [...h.undo, h.shapes], redo: h.redo.slice(0, -1) } : h;
}

/** 序号底色上的数字颜色：浅色底配黑字。 */
export function numberTextColor(color: string): string {
  return color === "#FFFFFF" || color === "#FFCC00" ? "#000000" : "#FFFFFF";
}

/** 箭头几何：线身终点（止于箭头底边）与三角形三顶点。 */
export function arrowGeometry(x1: number, y1: number, x2: number, y2: number, w: number) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10, w * 3.5);
  return {
    bx: x2 - Math.cos(angle) * head * 0.8,
    by: y2 - Math.sin(angle) * head * 0.8,
    head: [
      [x2, y2],
      [x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7)],
      [x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7)],
    ] as [number, number][],
  };
}

export function box(s: { x1: number; y1: number; x2: number; y2: number }) {
  return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
}

/**
 * 在 pt 坐标系下绘制（调用方先把 ctx 变换到 pt：屏上乘 dpr，导出乘像素比并平移选区）。
 * 先画聚光灯（整体压暗后把各聚光区原图贴回，多个区域重叠也只亮一次），
 * 再画马赛克（从冻结帧原图取样），最后画其他标注，保证标注不被压暗或遮住。
 * `sx/sy` 为冻结帧像素/pt 比。
 */
export function drawShapes(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  img: CanvasImageSource,
  sx: number,
  sy: number
): void {
  const spots = shapes.filter((s) => s.kind === "spotlight");
  if (spots.length) {
    ctx.save();
    ctx.fillStyle = SPOTLIGHT_DIM;
    // 画布外的部分会被裁掉：导出时画布即选区，屏上由调用方裁到选区
    ctx.fillRect(-1e5, -1e5, 2e5, 2e5);
    for (const s of spots) {
      if (s.kind !== "spotlight") continue;
      const b = box(s);
      ctx.drawImage(img, b.x * sx, b.y * sy, b.w * sx, b.h * sy, b.x, b.y, b.w, b.h);
    }
    ctx.restore();
  }
  for (const s of shapes) if (s.kind === "mosaic") drawMosaic(ctx, s, img, sx, sy);
  // 图内翻译盖在原文上，标注仍在最上层
  for (const s of shapes) {
    if (s.kind !== "translate") continue;
    for (const it of s.items) {
      ctx.save();
      ctx.drawImage(it.patch, it.x - TRANSLATE_PAD, it.y - TRANSLATE_PAD, it.w + TRANSLATE_PAD * 2, it.h + TRANSLATE_PAD * 2);
      ctx.fillStyle = it.fg;
      ctx.font = TRANSLATE_FONT.replace("{size}", String(it.fontSize));
      ctx.textBaseline = "middle";
      ctx.fillText(it.text, it.x, it.y + it.h / 2);
      ctx.restore();
    }
  }
  for (const s of shapes) {
    if (s.kind === "mosaic" || s.kind === "spotlight" || s.kind === "translate") continue;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = LINE_WIDTH[s.size];
    if (s.kind === "rect") {
      const b = box(s);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    } else if (s.kind === "ellipse") {
      const b = box(s);
      ctx.beginPath();
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.kind === "arrow") {
      drawArrow(ctx, s.x1, s.y1, s.x2, s.y2, LINE_WIDTH[s.size]);
    } else if (s.kind === "pen") {
      ctx.beginPath();
      s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    } else if (s.kind === "text") {
      const fs = FONT_SIZE[s.size];
      ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
      ctx.textBaseline = "top";
      s.text.split("\n").forEach((line, i) => ctx.fillText(line, s.x, s.y + i * fs * 1.25));
    } else if (s.kind === "number") {
      const r = NUMBER_RADIUS[s.size];
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = numberTextColor(s.color);
      ctx.font = `700 ${Math.round(r * 1.2)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(s.n), s.x, s.y + 0.5);
    }
    ctx.restore();
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, w: number) {
  // 线身止于箭头底边，避免粗线顶出尖端
  const { bx, by, head } = arrowGeometry(x1, y1, x2, y2, w);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.beginPath();
  head.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

/** 马赛克低分辨率取样：每块一个像素，放大时关掉平滑即成色块。 */
export function mosaicTile(
  s: { x1: number; y1: number; x2: number; y2: number; size: number },
  img: CanvasImageSource,
  sx: number,
  sy: number
): HTMLCanvasElement | null {
  const b = box(s);
  const block = MOSAIC_BLOCK[s.size] ?? MOSAIC_BLOCK[1];
  const cols = Math.max(1, Math.ceil(b.w / block));
  const rows = Math.max(1, Math.ceil(b.h / block));
  const tmp = document.createElement("canvas");
  tmp.width = cols;
  tmp.height = rows;
  const t = tmp.getContext("2d");
  if (!t) return null;
  t.drawImage(img, b.x * sx, b.y * sy, b.w * sx, b.h * sy, 0, 0, cols, rows);
  return tmp;
}

function drawMosaic(
  ctx: CanvasRenderingContext2D,
  s: { x1: number; y1: number; x2: number; y2: number; size: number },
  img: CanvasImageSource,
  sx: number,
  sy: number
) {
  const b = box(s);
  const tmp = mosaicTile(s, img, sx, sy);
  if (!tmp) return;
  const cols = tmp.width;
  const rows = tmp.height;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, cols, rows, b.x, b.y, b.w, b.h);
  ctx.restore();
}
