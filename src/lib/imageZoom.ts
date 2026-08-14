export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

export type ZoomView = { zoom: number; x: number; y: number };

export const FIT_VIEW: ZoomView = { zoom: 1, x: 0, y: 0 };

/**
 * 以容器内锚点（相对容器中心的坐标）缩放：锚点下的图像点保持不动。
 * transform 模型：translate(x,y) scale(zoom)，origin 为容器中心。
 * 回到最小倍率时同时清零平移（适配态不允许残留偏移）。
 */
export function zoomViewAround(
  view: ZoomView,
  nextZoom: number,
  anchor: { x: number; y: number }
): ZoomView {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  if (zoom === view.zoom) return view;
  if (zoom <= MIN_ZOOM) return FIT_VIEW;
  const ratio = zoom / view.zoom;
  return {
    zoom,
    x: anchor.x - ratio * (anchor.x - view.x),
    y: anchor.y - ratio * (anchor.y - view.y),
  };
}

/** 滚轮增量 → 缩放倍率因子（负 deltaY = 放大；指数保证平滑且可逆）。 */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0022);
}
