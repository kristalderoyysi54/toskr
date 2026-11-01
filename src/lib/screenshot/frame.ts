/** 截图出图的圆角与阴影（参照 iShot）：圆角外透明，阴影向四周留出透明边距。 */

/** 阴影边距（pt）。 */
export const SHADOW_PAD = 24;
/** 圆角上限（pt）。 */
export const MAX_RADIUS = 32;

/** 圆角 / 阴影边距外的背景：透明、白色、渐变。 */
export type FrameBg = "none" | "white" | "gradient";
export const FRAME_BGS: FrameBg[] = ["none", "white", "gradient"];
// token-exception: 背景画进出图像素，不随主题变化
export const FRAME_GRADIENT = ["#8EC5FC", "#E0C3FC"] as const;

/** 圆角不超过短边一半。 */
export function clampRadius(r: number, w: number, h: number): number {
  return Math.max(0, Math.min(r, w / 2, h / 2));
}

/** 给 RGBA 图加圆角（像素）与阴影边距（像素，0 = 无阴影）。 */
export function frameImage(
  img: { data: Uint8Array; w: number; h: number },
  radius: number,
  pad: number,
  bg: FrameBg = "none"
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
  if (bg !== "none") {
    if (bg === "white") {
      // token-exception: 背景画进出图像素
      ctx.fillStyle = "#FFFFFF";
    } else {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, FRAME_GRADIENT[0]);
      g.addColorStop(1, FRAME_GRADIENT[1]);
      ctx.fillStyle = g;
    }
    ctx.fillRect(0, 0, w, h);
  }
  if (pad > 0) {
    ctx.save();
    // token-exception: 阴影画进出图像素，不随主题变化
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = pad * 0.6;
    ctx.shadowOffsetY = pad * 0.2;
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
