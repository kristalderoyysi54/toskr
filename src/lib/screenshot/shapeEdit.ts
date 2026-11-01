/** 已画标注的选中与调整：命中、手柄、移动 / 缩放。坐标与图形同系（pt）。 */

import { box, calloutTag, FONT_SIZE, LINE_WIDTH, NUMBER_RADIUS, type Shape } from "./annotate";
import { handlePoint, HANDLES, resizeRect, type Handle, type Rect } from "./geometry";

export type Editable = Exclude<Shape, { kind: "translate" }>;
type BoxShape = Extract<Shape, { x1: number }>;
/** 框类 8 个手柄；箭头两端 start / end。 */
export type EditHandle = Handle | "start" | "end";

/** 可拖手柄改框的图形（箭头改端点，其余只能整体移动）。 */
export function isBox(s: Shape): s is BoxShape {
  return s.kind === "rect" || s.kind === "ellipse" || s.kind === "mosaic" || s.kind === "spotlight" || s.kind === "callout";
}

/** 粗估文字宽度：CJK 记 1 个字号宽，其余 0.6。 */
function textWidth(line: string, fs: number): number {
  let w = 0;
  for (const ch of line) w += ch.charCodeAt(0) >= 0x2e80 ? 1 : 0.6;
  return w * fs;
}

/** 图形外接框；图内翻译不可编辑，返回 null。 */
export function shapeBounds(s: Shape): Rect | null {
  switch (s.kind) {
    case "translate":
      return null;
    case "pen": {
      const xs = s.points.map((p) => p[0]);
      const ys = s.points.map((p) => p[1]);
      const pad = LINE_WIDTH[s.size] / 2;
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad;
      return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
    }
    case "text": {
      const fs = FONT_SIZE[s.size];
      const lines = s.text.split("\n");
      return { x: s.x, y: s.y, w: Math.max(fs, ...lines.map((l) => textWidth(l, fs))), h: lines.length * fs * 1.25 };
    }
    case "number": {
      const r = NUMBER_RADIUS[s.size];
      return { x: s.x - r, y: s.y - r, w: r * 2, h: r * 2 };
    }
    default:
      return box(s);
  }
}

function within(r: Rect, x: number, y: number, pad: number): boolean {
  return x >= r.x - pad && y >= r.y - pad && x <= r.x + r.w + pad && y <= r.y + r.h + pad;
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 精确命中：线框类看描边，线条类看离线距离，块状类看框内。 */
function hits(s: Editable, x: number, y: number, tol: number): boolean {
  const lw = "size" in s ? LINE_WIDTH[s.size] / 2 : 0;
  switch (s.kind) {
    case "callout": {
      // 描边或左上角编号贴片（按两位数宽度估）
      const b = box(s);
      const pad = tol + lw;
      if (within(calloutTag(s, 10), x, y, tol)) return true;
      return within(b, x, y, pad) && !(x > b.x + pad && y > b.y + pad && x < b.x + b.w - pad && y < b.y + b.h - pad);
    }
    case "rect": {
      const b = box(s);
      const pad = tol + lw;
      return within(b, x, y, pad) && !(x > b.x + pad && y > b.y + pad && x < b.x + b.w - pad && y < b.y + b.h - pad);
    }
    case "ellipse": {
      const b = box(s);
      const rx = b.w / 2;
      const ry = b.h / 2;
      if (rx < 1 || ry < 1) return within(b, x, y, tol);
      const d = Math.hypot((x - b.x - rx) / rx, (y - b.y - ry) / ry);
      return Math.abs(d - 1) * Math.min(rx, ry) <= tol + lw;
    }
    case "arrow":
      return distToSegment(x, y, s.x1, s.y1, s.x2, s.y2) <= tol + lw;
    case "pen":
      return s.points.some((p, i) => i > 0 && distToSegment(x, y, ...s.points[i - 1], ...p) <= tol + lw);
    default: {
      const b = shapeBounds(s);
      return !!b && within(b, x, y, tol);
    }
  }
}

/**
 * 点中的最上层图形下标。先按描边精确命中，再退回到矩形 / 椭圆框内，
 * 这样框里画的箭头、文字不会被外面的大框抢走。
 */
export function shapeAt(
  shapes: Shape[],
  x: number,
  y: number,
  tol = 4,
  accept: (s: Shape) => boolean = () => true
): number | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.kind !== "translate" && accept(s) && hits(s, x, y, tol)) return i;
  }
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if ((s.kind === "rect" || s.kind === "ellipse" || s.kind === "callout") && accept(s) && within(box(s), x, y, 0)) return i;
  }
  return null;
}

export function editHandles(s: Editable): { id: EditHandle; x: number; y: number }[] {
  if (s.kind === "arrow") {
    return [
      { id: "start", x: s.x1, y: s.y1 },
      { id: "end", x: s.x2, y: s.y2 },
    ];
  }
  if (isBox(s)) {
    const b = box(s);
    return HANDLES.map((h) => ({ id: h, ...handlePoint(b, h) }));
  }
  return [];
}

export function handleAt(s: Editable, x: number, y: number, tol: number): EditHandle | null {
  return editHandles(s).find((h) => Math.abs(h.x - x) <= tol && Math.abs(h.y - y) <= tol)?.id ?? null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function moveShape(s: Editable, dx: number, dy: number): Editable {
  switch (s.kind) {
    case "pen":
      return { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    case "text":
    case "number":
      return { ...s, x: s.x + dx, y: s.y + dy };
    default:
      return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
  }
}

/** 拖动结果：handle 为 null 整体移动（外接框贴边停住），否则改框 / 改箭头端点。W/H 为可画范围。 */
export function editShape(orig: Editable, handle: EditHandle | null, dx: number, dy: number, W: number, H: number): Editable {
  if (!handle) {
    const b = shapeBounds(orig);
    if (b && b.w <= W && b.h <= H) {
      dx = clamp(dx, -b.x, W - b.x - b.w);
      dy = clamp(dy, -b.y, H - b.y - b.h);
    }
    return moveShape(orig, dx, dy);
  }
  if (orig.kind === "arrow" && (handle === "start" || handle === "end")) {
    return handle === "start"
      ? { ...orig, x1: clamp(orig.x1 + dx, 0, W), y1: clamp(orig.y1 + dy, 0, H) }
      : { ...orig, x2: clamp(orig.x2 + dx, 0, W), y2: clamp(orig.y2 + dy, 0, H) };
  }
  if (isBox(orig) && handle !== "start" && handle !== "end") {
    const r = resizeRect(box(orig), handle, dx, dy, W, H);
    return { ...orig, x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h };
  }
  return orig;
}
