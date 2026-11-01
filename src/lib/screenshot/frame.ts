/** 截图出图的圆角与阴影（参照 iShot）：圆角外透明，阴影向四周留出透明边距。 */

/** 圆角上限（pt）。 */
export const MAX_RADIUS = 100;
/** 阴影大小上限（pt）：即四周透明边距，0 = 无阴影。 */
export const MAX_SHADOW = 60;
/** 阴影浓淡（不透明度 %）范围与默认值。 */
export const SHADOW_ALPHA_MIN = 10;
export const SHADOW_ALPHA_MAX = 90;
export const SHADOW_ALPHA_DEFAULT = 45;

/** 圆角不超过短边一半。 */
export function clampRadius(r: number, w: number, h: number): number {
  return Math.max(0, Math.min(r, w / 2, h / 2));
}

/** 阴影几何（与屏上预览同源）：模糊半径与下移量随大小变化。 */
export function shadowGeometry(size: number): { blur: number; offsetY: number } {
  return { blur: size * 0.6, offsetY: size * 0.2 };
}

/** 屏上预览用的 CSS box-shadow。 */
export function shadowCss(size: number, alpha: number): string {
  const { blur, offsetY } = shadowGeometry(size);
  // token-exception: 出图阴影预览，与像素一致
  return `0 ${offsetY}px ${blur}px rgba(0,0,0,${alpha / 100})`;
}

/** 给 RGBA 图加圆角（像素）与阴影边距（像素，0 = 无阴影）。 */
export function frameImage(
  img: { data: Uint8Array; w: number; h: number },
  radius: number,
  pad: number,
  alpha = SHADOW_ALPHA_DEFAULT
): { data: Uint8Array; w: number; h: number } {
  const src = document.createElement("canvas");
  src.width = img.w;
  src.height = img.h;
  src.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer as ArrayBuffer), img.w, img.h), 0, 0);
  const w = img.w + pad * 2;
  const h = img.h + pad * 2;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) return img;
  const r = clampRadius(radius, img.w, img.h);
  const shape = () => {
    ctx.beginPath();
    ctx.roundRect(pad, pad, img.w, img.h, r);
  };
  if (pad > 0) {
    const { blur, offsetY } = shadowGeometry(pad);
    ctx.save();
    // token-exception: 阴影画进出图像素，不随主题变化
    ctx.shadowColor = `rgba(0,0,0,${alpha / 100})`;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = offsetY;
    ctx.fillStyle = "#000";
    shape();
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  shape();
  ctx.clip();
  ctx.drawImage(src, pad, pad);
  ctx.restore();
  return { data: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer), w, h };
}
