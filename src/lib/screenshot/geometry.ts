/** 截图遮罩的选区几何：坐标均为本屏左上角原点的 pt，W/H 为本屏尺寸。 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** 拖拽起止点 → 规范矩形，并裁进屏内。 */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number, W: number, H: number): Rect {
  return fromEdges(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), W, H);
}

function fromEdges(l: number, t: number, r: number, b: number, W: number, H: number): Rect {
  const x0 = clamp(Math.min(l, r), 0, W);
  const y0 = clamp(Math.min(t, b), 0, H);
  const x1 = clamp(Math.max(l, r), 0, W);
  const y1 = clamp(Math.max(t, b), 0, H);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 与屏幕求交；无交集返回 null（窗口可能部分在别的屏上）。 */
export function clipToScreen(r: Rect, W: number, H: number): Rect | null {
  const c = fromEdges(r.x, r.y, r.x + r.w, r.y + r.h, W, H);
  return c.w > 0 && c.h > 0 ? c : null;
}

/** 光标下最上层窗口（列表自顶向下）。 */
export function windowAt(windows: Rect[], x: number, y: number): Rect | null {
  return windows.find((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) ?? null;
}

/** 手柄中心点。 */
export function handlePoint(r: Rect, h: Handle): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const x = h.includes("w") ? r.x : h.includes("e") ? r.x + r.w : cx;
  const y = h.startsWith("n") ? r.y : h.startsWith("s") ? r.y + r.h : cy;
  return { x, y };
}

/** 命中的手柄（容差 tol pt）。 */
export function hitHandle(r: Rect, x: number, y: number, tol = 6): Handle | null {
  return HANDLES.find((h) => {
    const p = handlePoint(r, h);
    return Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol;
  }) ?? null;
}

export function inside(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

/** 拖动手柄调整；越过对边时自动翻转，结果裁进屏内。 */
export function resizeRect(orig: Rect, h: Handle, dx: number, dy: number, W: number, H: number): Rect {
  let l = orig.x;
  let t = orig.y;
  let r = orig.x + orig.w;
  let b = orig.y + orig.h;
  if (h.includes("w")) l += dx;
  if (h.includes("e")) r += dx;
  if (h.startsWith("n")) t += dy;
  if (h.startsWith("s")) b += dy;
  return fromEdges(l, t, r, b, W, H);
}

/** 整体平移，尺寸不变、贴边停住。 */
export function moveRect(orig: Rect, dx: number, dy: number, W: number, H: number): Rect {
  return {
    ...orig,
    x: clamp(orig.x + dx, 0, W - orig.w),
    y: clamp(orig.y + dy, 0, H - orig.h),
  };
}

/** pt 选区 → 冻结帧像素矩形（四边分别取整，保证相邻选区不重叠不漏缝）。 */
export function toPixelRect(r: Rect, sx: number, sy: number, pxW: number, pxH: number): Rect {
  const x0 = clamp(Math.round(r.x * sx), 0, pxW);
  const y0 = clamp(Math.round(r.y * sy), 0, pxH);
  const x1 = clamp(Math.round((r.x + r.w) * sx), 0, pxW);
  const y1 = clamp(Math.round((r.y + r.h) * sy), 0, pxH);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 放大镜等浮层贴光标摆放：默认在右下，越界翻到另一侧。 */
export function placeNear(x: number, y: number, w: number, h: number, W: number, H: number, gap = 20): { x: number; y: number } {
  const px = x + gap + w > W ? x - gap - w : x + gap;
  const py = y + gap + h > H ? y - gap - h : y + gap;
  return { x: clamp(px, 0, Math.max(0, W - w)), y: clamp(py, 0, Math.max(0, H - h)) };
}
