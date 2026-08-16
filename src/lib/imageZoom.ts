export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 8;

export type ZoomView = { zoom: number; x: number; y: number };

export const FIT_VIEW: ZoomView = { zoom: 1, x: 0, y: 0 };

/**
 * 以容器内锚点（相对容器中心的坐标）缩放：锚点下的图像点保持不动。
 * transform 模型：translate(x,y) scale(zoom)，origin 为容器中心。
 * 适配（1×）及以下：始终居中缩放并清零平移——缩小态锚点跟随只会把
 * 图推离中心，且缩小无需平移语义（拖拽仍归窗口移动）。
 */
export function zoomViewAround(
  view: ZoomView,
  nextZoom: number,
  anchor: { x: number; y: number }
): ZoomView {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  if (zoom === view.zoom) return view;
  if (zoom <= 1) return { zoom, x: 0, y: 0 };
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
