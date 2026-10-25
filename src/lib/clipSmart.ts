/** 剪贴板文本智能识别的纯函数：颜色 / JSON / 时间戳 / 邮箱，供卡片渲染专用外观。 */

import { t as translate } from "@/lib/i18n";

export type ClipSmart =
  | { kind: "color"; hex: string; rgb: string; hsl: string; oklch: string; swatch: string }
  | { kind: "json"; pretty: string; minified: string; summary: string }
  | { kind: "timestamp"; ms: number; unit: "秒" | "毫秒"; local: string }
  | { kind: "email"; address: string };

const MAX_LEN = 100_000;
const TS_MIN = Date.UTC(2000, 0, 1);
const TS_MAX = Date.UTC(2100, 0, 1);
const EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** 识别剪贴板文本类型；无匹配返回 null（宁缺毋滥，不猜）。 */
export function detectClipSmart(text: string): ClipSmart | null {
  const t = text.trim();
  if (!t || t.length > MAX_LEN) return null;
  if (t[0] === "{" || t[0] === "[") return detectJson(t);
  // 非 JSON 一律单行；内部空白只允许出现在 rgb()/hsl() 函数语法里
  if (/\s/.test(t)) return /^(rgba?|hsla?)\(/i.test(t) && !t.includes("\n") ? detectColor(t) : null;
  return detectColor(t) ?? detectTimestamp(t) ?? detectEmail(t);
}

function detectJson(t: string): ClipSmart | null {
  const close = t[0] === "{" ? "}" : "]";
  if (t[t.length - 1] !== close) return null;
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const n = Array.isArray(v) ? v.length : Object.keys(v).length;
  if (n === 0) return null;
  return {
    kind: "json",
    pretty: JSON.stringify(v, null, 2),
    minified: JSON.stringify(v),
    summary: Array.isArray(v) ? translate("数组 · {n} 项", { n }) : translate("对象 · {n} 键", { n }),
  };
}

function detectTimestamp(t: string): ClipSmart | null {
  if (!/^\d{10}$|^\d{13}$/.test(t)) return null;
  const sec = t.length === 10;
  const ms = sec ? Number(t) * 1000 : Number(t);
  if (ms < TS_MIN || ms > TS_MAX) return null;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const local =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return { kind: "timestamp", ms, unit: sec ? "秒" : "毫秒", local };
}

function detectEmail(t: string): ClipSmart | null {
  if (t.length > 254 || !EMAIL_RE.test(t)) return null;
  return { kind: "email", address: t };
}

// ---------- 颜色 ----------

type Rgba = { r: number; g: number; b: number; a: number };

function detectColor(t: string): ClipSmart | null {
  const c = parseHex(t) ?? parseFunc(t);
  return c ? formatColor(c) : null;
}

/** #rgb / #rgba / #rrggbb / #rrggbbaa；不带 # 的裸十六进制误报太多，不认。 */
function parseHex(t: string): Rgba | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(t);
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map((ch) => ch + ch).join("");
  const byte = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: h.length === 8 ? byte(6) / 255 : 1 };
}

/** rgb()/rgba()/hsl()/hsla()：逗号或空格语法，可选 `/ alpha`；越界返回 null。 */
function parseFunc(t: string): Rgba | null {
  const m = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(t);
  if (!m) return null;
  const inner = m[2].trim();
  let parts: string[];
  let alpha: string | undefined;
  if (inner.includes(",")) {
    if (inner.includes("/")) return null;
    parts = inner.split(",").map((s) => s.trim());
    if (parts.length === 4) alpha = parts.pop();
  } else {
    const [main, a, ...rest] = inner.split("/");
    if (rest.length) return null;
    parts = main.trim().split(/\s+/);
    if (a !== undefined) alpha = a.trim();
  }
  if (parts.length !== 3) return null;
  const a = alpha === undefined ? 1 : unit(alpha, 1);
  if (a === null) return null;

  if (m[1].toLowerCase().startsWith("rgb")) {
    const [r, g, b] = parts.map((p) => unit(p, 255));
    if (r === null || g === null || b === null) return null;
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
  }
  const hs = parts[0].replace(/deg$/i, "");
  if (!NUM_RE.test(hs)) return null;
  const h = ((Number(hs) % 360) + 360) % 360;
  const s = unit(parts[1], 100);
  const l = unit(parts[2], 100);
  if (s === null || l === null) return null;
  return { ...hslToRgb(h, s / 100, l / 100), a };
}

/** 解析数字或百分比到 [0, max]；百分比按 max 折算；越界/非法返回 null。 */
function unit(s: string, max: number): number | null {
  const pct = s.endsWith("%");
  const n = pct ? s.slice(0, -1) : s;
  if (!NUM_RE.test(n)) return null;
  const v = pct ? (Number(n) / 100) * max : Number(n);
  return v < 0 || v > max ? null : v;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return { r: f(0), g: f(8), b: f(4) };
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}

/** sRGB → 线性 → OKLab → OKLCH（Björn Ottosson 标准矩阵）。 */
function rgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, Bb);
  const H = ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360;
  return [L, C, H];
}

function formatColor({ r, g, b, a }: Rgba): ClipSmart {
  // alpha 先按 3 位小数取整，再判定是否不透明（hex/rgb 两种输出口径一致）
  const alpha = Math.round(a * 1000) / 1000;
  const opaque = alpha >= 1;
  const h2 = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  const hex = `#${h2(r)}${h2(g)}${h2(b)}${opaque ? "" : h2(Math.round(alpha * 255))}`;
  const [hh, ss, ll] = rgbToHsl(r, g, b);
  const [L, C, H] = rgbToOklch(r, g, b);
  const cs = C.toFixed(3);
  // 无彩色色相无意义，置 0；取整后 360 归 0
  const hs = cs === "0.000" || H.toFixed(1) === "360.0" ? "0.0" : H.toFixed(1);
  return {
    kind: "color",
    hex,
    rgb: `rgb(${r} ${g} ${b}${opaque ? "" : ` / ${alpha}`})`,
    hsl: `hsl(${Math.round(hh) % 360} ${Math.round(ss)}% ${Math.round(ll)}%)`,
    oklch: `oklch(${L.toFixed(3)} ${cs} ${hs})`,
    swatch: hex,
  };
}
