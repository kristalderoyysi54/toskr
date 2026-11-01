import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  Check,
  Download,
  Languages,
  Loader2,
  type LucideIcon,
  Pin,
  Redo2,
  ScanText,
  ScrollText,
  Send,
  Shield,
  Undo2,
  X,
} from "lucide-react";

import { ShotShapesSvg } from "@/components/ShotShapesSvg";
import {
  HoverTip,
  SHOT_TOOLS,
  ShotStyleRow,
  TipButton,
  toolHasStyle,
  ShotFrameControls,
  useShotFrame,
  useShotStyle,
} from "@/components/ShotToolParts";
import { clampRadius, frameImage, shadowCss } from "@/lib/screenshot/frame";
import { shapeAt } from "@/lib/screenshot/shapeEdit";
import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { NOTE_SECTIONS, type NoteSectionOption } from "@/lib/draftSection";
import { useT, type MessageKey } from "@/lib/i18n";
import { createLongPress } from "@/lib/longPress";
import {
  commitShapes,
  commitText,
  contrastText,
  drawShapes,
  fitFontSize,
  emptyHistory,
  FONT_SIZE,
  nextNumber,
  pushShape,
  redo,
  undo,
  type History,
  type Shape,
  type SizeLevel,
  TRANSLATE_PAD,
  type Tool,
  type TextDraft,
  type TranslatedLine,
  withTextDraft,
} from "@/lib/screenshot/annotate";
import { useShapeEdit } from "@/lib/screenshot/useShapeEdit";
import { ShapeEditFrame } from "@/components/ShapeEditFrame";
import {
  clipToScreen,
  handlePoint,
  hitHandle,
  HANDLES,
  inside,
  moveRect,
  placeNear,
  rectFromPoints,
  resizeRect,
  toPixelRect,
  windowAt,
  type Handle,
  type Rect,
} from "@/lib/screenshot/geometry";
import {
  api,
  SCREENSHOT_END_EVENT,
  SCREENSHOT_SESSION_EVENT,
  SCREENSHOT_TRANSLATE_RESULT_EVENT,
  type OcrLine,
  type ScreenshotAction,
  type ScreenshotSession,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Drag =
  | { kind: "create"; x: number; y: number; moved: boolean }
  | { kind: "move"; x: number; y: number; orig: Rect }
  | { kind: "resize"; x: number; y: number; orig: Rect; handle: Handle };

/** 选区上方圆角 / 阴影条的估计宽度（贴右边时左移）。 */
const FRAME_BAR_W = 480;
// token-exception: 截图十字线、选框与手柄的浅天蓝（用户指定）
const CROSSHAIR_COLOR = "rgba(125, 211, 252, 0.7)";

/** #RRGGBB → rgb(r, g, b)。 */
function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** C 键：按物理键位认（中文输入法下 e.key 是 Process）。 */
function isKeyC(e: KeyboardEvent): boolean {
  return e.code === "KeyC" || e.key.toLowerCase() === "c";
}
/** 取色快捷键 C：按键可能落在别的屏的遮罩窗，广播给光标所在屏去复制。 */
const COPY_COLOR_EVENT = "toskr://screenshot-copy-color";
/** 截图光标（参照 iShot）：中心留空的细十字，黑线白边，深浅背景都看得清。 */
const CROSS_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 25 25">' +
    '<g stroke-linecap="square"><path d="M12.5 1v8M12.5 16v8M1 12.5h8M16 12.5h8" stroke="#fff" stroke-width="3"/>' +
    '<path d="M12.5 1v8M12.5 16v8M1 12.5h8M16 12.5h8" stroke="#000" stroke-width="1"/></g>' +
    '<circle cx="12.5" cy="12.5" r="1" fill="#000" stroke="#fff" stroke-width="0.8"/></svg>'
)}") 12 12, crosshair`;
/** 起拖阈值：小于此距离的按放视为单击（选中悬停窗口）。 */
const DRAG_SLOP = 3;
/** 放大镜：取样边长（冻结帧像素）× 放大倍数 = 画布边长（pt）。 */
const LOUPE_SAMPLE = 15;
const LOUPE_SIZE = 120;
const LOUPE_PANEL_H = LOUPE_SIZE + 44;
/** 工具条宽度估值：选区右缘离屏幕左边不足此宽时改为贴左，避免工具条被裁掉。 */
const TOOLBAR_W_EST = 760;

const HANDLE_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

const ACTIONS: { action: ScreenshotAction; icon: LucideIcon; label: MessageKey; tip: MessageKey }[] = [
  { action: "pin", icon: Pin, label: "钉在屏幕上", tip: "钉在屏幕上：截图置顶悬浮，可拖动、滚轮缩放，右键更多" },
  { action: "edit", icon: Shield, label: "在编辑器中打开（打码）", tip: "在编辑器中打开（打码）：存入「剪贴」后打开图片编辑器打码" },
  { action: "send", icon: Send, label: "发送到当前目标", tip: "发送到当前目标：存入「剪贴」并粘贴到目标应用" },
  { action: "saveas", icon: Download, label: "另存为图片…", tip: "另存为图片…：选位置保存为 PNG 文件" },
];

/** 文字面板：识别结果（可编辑）与可选译文。 */
interface OcrPanel {
  text: string;
  busy: boolean;
  error: string | null;
  copied: boolean;
}

/** 进行中的图内翻译：识别出的行（出图像素坐标）与发起时的选区。 */
interface PendingTranslate {
  id: string;
  lines: OcrLine[];
  pr: Rect;
  sel: Rect;
}

/** 与背景色的最大通道差超过此值视为文字笔画。 */
const STROKE_DIFF = 40;

/**
 * 只抹掉文字笔画：识别框外扩 `pad` 像素，取外圈亮度中位数的像素色当背景，
 * 把与背景差异明显的像素（再外扩 1px 吃掉抗锯齿边）换成背景色，其余像素原样保留。
 * 返回补丁画布（冻结帧像素尺寸）与背景色。
 */
function erasePatch(
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  pad: number
): { patch: HTMLCanvasElement; bg: [number, number, number] } | null {
  const cw = Math.max(1, Math.round(w + pad * 2));
  const ch = Math.max(1, Math.round(h + pad * 2));
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, x - pad, y - pad, cw, ch, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch);
  const d = data.data;
  const ring: [number, number, number, number][] = [];
  for (let yy = 0; yy < ch; yy++) {
    for (let xx = 0; xx < cw; xx++) {
      if (yy >= 1 && yy < ch - 1 && xx >= 1 && xx < cw - 1) continue;
      const i = (yy * cw + xx) * 4;
      ring.push([0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2], d[i], d[i + 1], d[i + 2]]);
    }
  }
  ring.sort((p, q) => p[0] - q[0]);
  const [, br, bgc, bb] = ring[Math.floor(ring.length / 2)] ?? [0, 255, 255, 255];
  const stroke = new Uint8Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    const k = i * 4;
    const diff = Math.max(Math.abs(d[k] - br), Math.abs(d[k + 1] - bgc), Math.abs(d[k + 2] - bb));
    if (diff > STROKE_DIFF) stroke[i] = 1;
  }
  for (let yy = 0; yy < ch; yy++) {
    for (let xx = 0; xx < cw; xx++) {
      let hit = false;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        for (let dx = -1; dx <= 1 && !hit; dx++) {
          const ny = yy + dy;
          const nx = xx + dx;
          if (ny >= 0 && ny < ch && nx >= 0 && nx < cw && stroke[ny * cw + nx]) hit = true;
        }
      }
      const k = (yy * cw + xx) * 4;
      if (hit) {
        d[k] = br;
        d[k + 1] = bgc;
        d[k + 2] = bb;
      }
    }
  }
  ctx.putImageData(data, 0, 0);
  return { patch: c, bg: [br, bgc, bb] };
}

/** 把逐行译文换成屏上 pt 坐标的覆盖：只抹文字笔画的补丁 + 译文，字号按框宽缩放。 */
function buildTranslatedLines(
  lines: OcrLine[],
  translated: string[],
  pr: Rect,
  sel: Rect,
  img: HTMLImageElement,
  sx: number,
  sy: number
): TranslatedLine[] {
  const measure = document.createElement("canvas").getContext("2d");
  const pad = Math.round(TRANSLATE_PAD * sx);
  return lines.flatMap((l, i) => {
    const erased = erasePatch(img, pr.x + l.x, pr.y + l.y, l.w, l.h, pad);
    if (!erased) return [];
    const [r, g, b] = erased.bg;
    const w = l.w / sx;
    const h = l.h / sy;
    const text = translated[i] ?? "";
    return [
      {
        x: sel.x + l.x / sx,
        y: sel.y + l.y / sy,
        w,
        h,
        text,
        patch: erased.patch,
        patchUrl: erased.patch.toDataURL(),
        fg: contrastText(r, g, b),
        fontSize: fitFontSize(w, h, (font) => {
          if (!measure) return 0;
          measure.font = font;
          return measure.measureText(text).width;
        }),
      },
    ];
  });
}

const OCR_PANEL_W = 320;
const OCR_PANEL_MAX_H = 420;

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export default function ScreenshotView() {
  const t = useT();
  const [info, setInfo] = useState<ScreenshotSession | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [sel, setSel] = useState<Rect | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tool, setTool] = useState<Tool | null>(null);
  const style = useShotStyle();
  const { ink, size } = style;
  const [history, setHistory] = useState<History>(emptyHistory);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [editing, setEditing] = useState<TextDraft | null>(null);
  const [ocr, setOcr] = useState<OcrPanel | null>(null);
  const translateReq = useRef<PendingTranslate | null>(null);
  const [translating, setTranslating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  // 网页还没收到过真实指针事件（应用未激活）时，轮询顺带让原生侧把光标设成十字
  const gotPointer = useRef(false);
  const forceCross = useRef(false);
  const copyLatest = useRef<{ copyColor: (rgb?: boolean) => void; live: boolean }>({ copyColor: () => {}, live: false });
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionRef = useRef<number | null>(null);
  const urlRef = useRef<string | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);
  const [sampled, setSampled] = useState("");

  const reset = useCallback(() => {
    sessionRef.current = null;
    drag.current = null;
    gotPointer.current = false;
    setInfo(null);
    setImg(null);
    setSel(null);
    setCursor(null);
    setDragging(false);
    setTool(null);
    setHistory(emptyHistory);
    setDraft(null);
    setEditing(null);
    setOcr(null);
    translateReq.current = null;
    setTranslating(false);
    setNotice(null);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  const load = useCallback(async () => {
    const s = await api.screenshotSession().catch(() => null);
    if (!s) {
      reset();
      return;
    }
    if (s.id === sessionRef.current) return;
    sessionRef.current = s.id;
    const buf = await api.screenshotFrame(s.id).catch(() => null);
    if (!buf || sessionRef.current !== s.id) return;
    const url = URL.createObjectURL(new Blob([buf], { type: s.mime }));
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      URL.revokeObjectURL(url);
      return;
    }
    if (sessionRef.current !== s.id) {
      URL.revokeObjectURL(url);
      return;
    }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    setSel(null);
    setTool(null);
    setHistory(emptyHistory);
    setDraft(null);
    setEditing(null);
    setInfo(s);
    setImg(image);
    void api.screenshotTrace("loaded", s.width, s.height);
    void api.screenshotTrace("size", window.innerWidth, window.innerHeight);
    setCursor(s.cursor ? { x: s.cursor[0], y: s.cursor[1] } : null);
  }, [reset]);

  // 复用窗口：隐藏期 WKWebView 可能被挂起，事件不可靠，再用 visibilitychange 兜底拉会话
  useEffect(() => {
    void api.screenshotTrace("mounted", window.devicePixelRatio, 0);
    const onError = () => void api.screenshotTrace("error", 0, 0);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);
    void load();
    const offSession = listen(SCREENSHOT_SESSION_EVENT, () => void load());
    const offEnd = listen(SCREENSHOT_END_EVENT, () => reset());
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      void offSession.then((f) => f());
      void offEnd.then((f) => f());
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
    };
  }, [load, reset]);

  const W = info?.width ?? 0;
  const H = info?.height ?? 0;
  const sx = info ? info.pxW / info.width : 1;
  const sy = info ? info.pxH / info.height : 1;

  /** 无选区时光标下的候选：最上层窗口，桌面处为整屏。 */
  const hover: Rect | null =
    info && !sel && cursor && !dragging
      ? (clipToScreen(windowAt(info.windows, cursor.x, cursor.y) ?? { x: 0, y: 0, w: W, h: H }, W, H) ?? null)
      : null;

  const cancel = useCallback(() => {
    reset();
    void api.screenshotCancel();
  }, [reset]);

  // WKWebView 下 autoFocus 不可靠：新文字框出现后显式聚焦
  const editingAt = editing ? `${editing.x},${editing.y}` : null;
  useEffect(() => {
    const el = textRef.current;
    if (!editingAt || !el) return;
    el.focus();
    // 双击改已有文字时光标放到末尾
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editingAt]);

  /** 正在输入的文字也算进出图与撤销历史。 */
  const shapesWithEditing = useCallback((): Shape[] => {
    return withTextDraft(history.shapes, editing);
  }, [editing, history.shapes]);

  const commitEditing = useCallback(() => {
    if (!editing) return;
    setHistory((h) => commitText(h, editing));
    setEditing(null);
  }, [editing]);

  /** 选区按冻结帧像素裁剪（`withShapes` 时合成标注），得到原始 RGBA。 */
  const exportImage = useCallback(
    (withShapes = true): { data: Uint8Array; w: number; h: number; pr: Rect } | null => {
      if (!sel || !info || !img) return null;
      const pr = toPixelRect(sel, sx, sy, info.pxW, info.pxH);
      if (pr.w < 1 || pr.h < 1) return null;
      const canvas = document.createElement("canvas");
      canvas.width = pr.w;
      canvas.height = pr.h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, pr.x, pr.y, pr.w, pr.h, 0, 0, pr.w, pr.h);
      if (withShapes) {
        ctx.save();
        ctx.scale(sx, sy);
        ctx.translate(-pr.x / sx, -pr.y / sy);
        drawShapes(ctx, shapesWithEditing(), img, sx, sy);
        ctx.restore();
      }
      return { data: new Uint8Array(ctx.getImageData(0, 0, pr.w, pr.h).data.buffer), w: pr.w, h: pr.h, pr };
    },
    [sel, info, img, sx, sy, shapesWithEditing]
  );

  // 出图圆角 / 阴影（选区上方的小条调整）
  const [frame, setFrame] = useShotFrame();

  const confirm = useCallback((action: ScreenshotAction = "save", sectionId?: string) => {
    const raw = exportImage();
    if (!raw || !sel) return;
    const padPt = frame.shadow;
    const out =
      frame.radius > 0 || padPt > 0 ? frameImage(raw, frame.radius * sx, Math.round(padPt * sx), frame.shadowAlpha) : raw;
    reset();
    // 带阴影时图四周多出透明边距，钉图位置相应左上移，图本身仍对齐原处
    const placement = { x: sel.x - padPt, y: sel.y - padPt };
    void api.screenshotCommit(out.data, out.w, out.h, action, placement, sectionId).catch(() => {
      void api.screenshotCancel();
    });
  }, [exportImage, sel, reset, frame, sx]);

  // 长按 ✓（或右键 ✓）：选一个笔记分组存入；分组列表向主窗口要
  const [sections, setSections] = useState<NoteSectionOption[]>([]);
  const [sectionMenu, setSectionMenu] = useState(false);
  const longPress = useMemo(() => createLongPress(() => setSectionMenu(true)), []);
  useEffect(() => {
    const off = listen<NoteSectionOption[]>(NOTE_SECTIONS, (event) => setSections(event.payload));
    return () => void off.then((f) => f());
  }, []);
  useEffect(() => {
    if (info) void api.screenshotRequestSections().catch(() => {});
    else setSectionMenu(false);
  }, [info]);

  const flash = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 2500);
  }, []);

  /** 长截屏：Rust 结束遮罩后给选区加框、旁边放预览面板，用户滚动页面时逐帧拼接；长图不支持标注。 */
  const startLong = useCallback(() => {
    if (!sel) return;
    if (history.shapes.length) {
      flash(t("长截屏不保留标注，请先撤销标注"));
      return;
    }
    const r = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
    reset();
    void api.screenshotLong(r).catch(() => void api.screenshotCancel());
  }, [sel, history.shapes.length, flash, reset, t]);

  const runOcr = useCallback(() => {
    const out = exportImage(false);
    if (!out) return;
    commitEditing();
    setTool(null);
    setOcr({ text: "", busy: true, error: null, copied: false });
    void api
      .screenshotOcr(out.data, out.w, out.h)
      .then((lines) => {
        const text = lines.map((l) => l.text).join("\n");
        setOcr((o) => o && { ...o, busy: false, text, error: text.trim() ? null : t("未识别到文字") });
      })
      .catch(() => setOcr((o) => o && { ...o, busy: false, error: t("识别失败") }));
  }, [exportImage, commitEditing, t]);

  const hasTranslation = history.shapes.some((s) => s.kind === "translate");

  /** 图内翻译：识别各行文字 → 主窗口 AI 逐行翻译 → 译文盖回原文位置。再点一次去掉。 */
  const translateInImage = useCallback(() => {
    if (hasTranslation) {
      setHistory((h) => commitShapes(h, h.shapes.filter((s) => s.kind !== "translate")));
      return;
    }
    const out = exportImage(false);
    if (!out || !sel || translating) return;
    commitEditing();
    setTool(null);
    setTranslating(true);
    void api
      .screenshotOcr(out.data, out.w, out.h)
      .then((all) => {
        const lines = all.filter((l) => l.text.trim());
        if (!lines.length) {
          setTranslating(false);
          flash(t("未识别到文字"));
          return;
        }
        const id = crypto.randomUUID();
        translateReq.current = { id, lines, pr: out.pr, sel };
        return api.screenshotTranslate(id, JSON.stringify(lines.map((l) => l.text)));
      })
      .catch(() => {
        translateReq.current = null;
        setTranslating(false);
        flash(t("翻译失败"));
      });
  }, [hasTranslation, exportImage, sel, translating, commitEditing, flash, t]);

  // 监听只注册一次，回调读最新的冻结帧与比例（重复注册会让迟到的旧回调抢先作废请求）
  const frameRef = useRef({ img, sx, sy, flash, t });
  frameRef.current = { img, sx, sy, flash, t };

  // 主窗口代办的逐行译文：只认最近一次请求
  useEffect(() => {
    const off = listen<{ requestId: string; lines?: string[]; error?: string }>(
      SCREENSHOT_TRANSLATE_RESULT_EVENT,
      (event) => {
        const pending = translateReq.current;
        if (!pending || event.payload.requestId !== pending.id) return;
        translateReq.current = null;
        setTranslating(false);
        const { img, sx, sy, flash, t } = frameRef.current;
        const { lines, error } = event.payload;
        if (!lines || lines.length !== pending.lines.length || !img) {
          flash(error ?? t("翻译失败"));
          return;
        }
        const items = buildTranslatedLines(pending.lines, lines, pending.pr, pending.sel, img, sx, sy);
        setHistory((h) => pushShape(h, { kind: "translate", items }));
      }
    );
    return () => void off.then((f) => f());
  }, []);

  const copyOcr = useCallback(() => {
    if (!ocr) return;
    void api.copyText(ocr.text).then(() => {
      setOcr((o) => o && { ...o, copied: true });
      window.setTimeout(() => setOcr((o) => o && { ...o, copied: false }), 900);
    });
  }, [ocr]);

  const saveOcr = useCallback(() => {
    if (!ocr?.text.trim()) return;
    const text = ocr.text;
    reset();
    void api.screenshotSaveText(text).catch(() => void api.screenshotCancel());
  }, [ocr, reset]);

  /** C 复制 HEX，⇧C 复制 RGB；写剪贴板并存入「剪贴」，遮罩不关。 */
  const copyColor = useCallback((rgb = false) => {
    if (!sampled) return;
    void api.screenshotCopyColor(rgb ? hexToRgb(sampled) : sampled).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 900);
    });
  }, [sampled]);

  // 遮罩临时接管键盘：capture 阶段监听，不赌焦点
  useEffect(() => {
    if (!info) return;
    const onKey = (e: KeyboardEvent) => {
      if (sectionMenu) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setSectionMenu(false);
        }
        return;
      }
      // 文字面板打开时只接管 Esc（关面板），其余交给面板里的输入框
      if (ocr) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setOcr(null);
        }
        return;
      }
      // 文字输入框自己处理按键
      if (editing) return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.metaKey && e.key.toLowerCase() === "z") {
        stop();
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
      } else if (editRef.current.key(e)) {
        stop();
      } else if (e.key === "Escape") {
        stop();
        if (tool) setTool(null);
        else if (sel) {
          setSel(null);
          setHistory(emptyHistory);
        } else cancel();
      } else if (e.key === "Enter" || (e.metaKey && isKeyC(e))) {
        stop();
        confirm();
      } else if (!e.metaKey && isKeyC(e)) {
        stop();
        // 中文输入法下 e.key 是 Process，按物理键位认；键盘焦点可能在别的屏，交给光标所在屏
        if (copyLatest.current.live) copyColor(e.shiftKey);
        else void emit(COPY_COLOR_EVENT, e.shiftKey);
      } else if (sel && !tool && history.shapes.length === 0 && e.key.startsWith("Arrow")) {
        stop();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        setSel(moveRect(sel, dx, dy, W, H));
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [info, sel, W, H, cancel, confirm, copyColor, editing, tool, history.shapes.length, ocr, sectionMenu]);

  // 遮罩刚出现时应用可能还没激活，WKWebView 收不到 mousemove：轮询系统光标跟随；
  // 拖拽中以指针事件为准
  useEffect(() => {
    if (!info) return;
    let raf = 0;
    let pending = false;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      if (!pending && !drag.current) {
        pending = true;
        void api
          .screenshotCursor(forceCross.current)
          .then((p) => {
            if (!alive || drag.current) return;
            setCursor((prev) =>
              p ? (prev && prev.x === p[0] && prev.y === p[1] ? prev : { x: p[0], y: p[1] }) : null
            );
          })
          .catch(() => {})
          .finally(() => {
            pending = false;
          });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [info]);

  const showLoupe = !!(img && cursor && (!sel || dragging));
  copyLatest.current = { copyColor, live: showLoupe };
  useEffect(() => {
    const off = listen<boolean>(COPY_COLOR_EVENT, (event) => {
      if (copyLatest.current.live) copyLatest.current.copyColor(event.payload === true);
    });
    return () => void off.then((f) => f());
  }, []);

  // 放大镜：从冻结帧取样放大，同时记下光标处色值
  useEffect(() => {
    const canvas = loupeRef.current;
    if (!showLoupe || !canvas || !img || !cursor) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = LOUPE_SIZE * dpr;
    canvas.height = LOUPE_SIZE * dpr;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const px = Math.floor(cursor.x * sx);
    const py = Math.floor(cursor.y * sy);
    const half = Math.floor(LOUPE_SAMPLE / 2);
    const cell = canvas.width / LOUPE_SAMPLE;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, px - half, py - half, LOUPE_SAMPLE, LOUPE_SAMPLE, 0, 0, canvas.width, canvas.height);
    const [r, g, b] = ctx.getImageData(half * cell + cell / 2, half * cell + cell / 2, 1, 1).data;
    setSampled(hex(r, g, b));
    ctx.strokeStyle = "rgba(56,132,255,0.9)";
    ctx.lineWidth = dpr;
    ctx.strokeRect(half * cell, half * cell, cell, cell);
  }, [showLoupe, img, cursor, sx, sy]);

  const locked = !!tool || history.shapes.length > 0;
  forceCross.current = !gotPointer.current && !sel;

  // 已画图形的选中与调整：无工具时可选任意图形，有工具时只选同类
  const edit = useShapeEdit({ history, setHistory, W, H, tol: 6, canPick: (s) => !tool || s.kind === tool });
  const editRef = useRef(edit);
  editRef.current = edit;

  const beginTextEdit = (x: number, y: number): boolean => {
    if (tool && tool !== "text") return false;
    const i = shapeAt(history.shapes, x, y, 4, (s) => s.kind === "text");
    const s = i === null ? undefined : history.shapes[i];
    if (s?.kind !== "text") return false;
    edit.clear();
    setEditing({ x: s.x, y: s.y, text: s.text, color: s.color, size: s.size, orig: s });
    return true;
  };

  const point = (e: ReactPointerEvent) => ({ x: e.clientX, y: e.clientY });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !info) return;
    const p = point(e);
    if (editing) commitEditing();
    // 点已画的图形：选中，拖动移动、拖手柄缩放
    if (sel && edit.down(p.x, p.y)) {
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (sel && tool) {
      if (!inside(sel, p.x, p.y)) return;
      if (tool === "text") {
        // 文字框以光标为左上角，字号的一半上提让首行落在点击处
        if (!editing) setEditing({ x: p.x, y: p.y - FONT_SIZE[size] / 2, text: "", color: ink, size });
        return;
      }
      if (tool === "number") {
        setHistory((h) => pushShape(h, { kind: "number", x: p.x, y: p.y, n: nextNumber(h.shapes), color: ink, size }));
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      void api.screenshotTrace("draft-start", p.x, p.y);
      setDraft(
        tool === "pen"
          ? { kind: "pen", points: [[p.x, p.y]], color: ink, size }
          : { kind: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: ink, size }
      );
      return;
    }
    // 已有标注时选区锁定，避免标注与底图错位
    if (sel && locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const handle = sel ? hitHandle(sel, p.x, p.y) : null;
    if (sel && handle) drag.current = { kind: "resize", ...p, orig: sel, handle };
    else if (sel && inside(sel, p.x, p.y)) drag.current = { kind: "move", ...p, orig: sel };
    else drag.current = { kind: "create", ...p, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    gotPointer.current = true;
    const p = point(e);
    setCursor(p);
    if (edit.move(p.x, p.y)) return;
    if (draft) {
      setDraft(
        draft.kind === "pen"
          ? { ...draft, points: [...draft.points, [p.x, p.y]] }
          : draft.kind === "text" || draft.kind === "number" || draft.kind === "translate"
            ? draft
            : { ...draft, x2: p.x, y2: p.y }
      );
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = p.x - d.x;
    const dy = p.y - d.y;
    if (d.kind === "create") {
      if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      d.moved = true;
      setDragging(true);
      setSel(rectFromPoints(d.x, d.y, p.x, p.y, W, H));
    } else if (d.kind === "move") {
      setDragging(true);
      setSel(moveRect(d.orig, dx, dy, W, H));
    } else {
      setDragging(true);
      setSel(resizeRect(d.orig, d.handle, dx, dy, W, H));
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = point(e);
    if (edit.up(p.x, p.y)) return;
    if (draft) {
      // 按松手处收尾：最后一次 pointermove 的状态可能还没渲染进 draft
      const done: Shape =
        draft.kind === "pen"
          ? { ...draft, points: [...draft.points, [p.x, p.y]] }
          : "x2" in draft
            ? { ...draft, x2: p.x, y2: p.y }
            : draft;
      void api.screenshotTrace("pushed", done.kind === "pen" ? done.points.length : 0, 0);
      setHistory((h) => pushShape(h, done));
      setDraft(null);
      return;
    }
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (d?.kind === "create" && !d.moved && !sel && hover) setSel(hover);
    // 拖出零宽高的选区视为无效
    if (sel && (sel.w < 2 || sel.h < 2)) setSel(null);
  };

  if (!info || !img) return null;

  const active = sel ?? hover;
  const handle = sel && cursor && !dragging && !locked ? hitHandle(sel, cursor.x, cursor.y) : null;
  const editCursor = sel && cursor && !draft ? edit.cursor(cursor.x, cursor.y) : null;
  // 改已有文字时原文字先藏起来，由输入框显示
  const shownShapes = editing?.orig ? edit.shapes.filter((s) => s !== editing.orig) : edit.shapes;
  const inSel = !!(sel && cursor && inside(sel, cursor.x, cursor.y));
  const cursorStyle = editCursor
    ? editCursor
    : tool
    ? inSel
      ? tool === "text"
        ? "text"
        : CROSS_CURSOR
      : "default"
    : handle
      ? HANDLE_CURSOR[handle]
      : inSel && !locked
        ? "move"
        : sel && locked
          ? "default"
          : CROSS_CURSOR;
  const pr = active ? toPixelRect(active, sx, sy, info.pxW, info.pxH) : null;
  const labelAbove = active && active.y >= 26;
  const loupePos = cursor ? placeNear(cursor.x, cursor.y, LOUPE_SIZE, LOUPE_PANEL_H, W, H) : null;
  // 选中图形时样式行显示并修改该图形的颜色 / 粗细
  // 输入文字时样式行改的是正在输入的文字
  const pickedStyled = editing ?? (edit.picked && "size" in edit.picked ? edit.picked : null);
  const styleKind = editing ? "text" : (pickedStyled && "kind" in pickedStyled ? pickedStyled.kind : tool);
  const showStyle = toolHasStyle(styleKind);
  const styleRow = {
    ink: pickedStyled?.color ?? ink,
    size: (pickedStyled?.size ?? size) as SizeLevel,
    setInk: (c: string) => {
      style.setInk(c);
      if (editing) setEditing({ ...editing, color: c });
      else edit.restyle({ color: c });
    },
    setSize: (lv: SizeLevel) => {
      style.setSize(lv);
      if (editing) setEditing({ ...editing, size: lv });
      else edit.restyle({ size: lv });
    },
    colors: styleKind !== "mosaic",
  };
  const toolbarH = showStyle ? 84 : 44;
  const toolbarTop = sel
    ? sel.y + sel.h + 8 + toolbarH <= H
      ? sel.y + sel.h + 8
      : Math.max(sel.y - 8 - toolbarH, 0)
    : 0;

  return (
    <div
      className="fixed inset-0 select-none overflow-hidden"
      style={{ cursor: cursorStyle }}
      onPointerDown={onPointerDown}
      // 阻止按下遮罩时浏览器把焦点挪回 body（会抢走刚聚焦的文字框）
      onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => {
        if (!sel || !inside(sel, e.clientX, e.clientY)) return;
        // 双击已有文字：改内容；否则无工具时双击完成截图
        if (beginTextEdit(e.clientX, e.clientY)) return;
        if (!tool) confirm();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (tool) setTool(null);
        else if (sel) {
          setSel(null);
          setHistory(emptyHistory);
        } else cancel();
      }}
    >
      <img src={img.src} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full" />
      {active ? (
        <div
          className="pointer-events-none absolute outline outline-2"
          style={{
            outlineColor: CROSSHAIR_COLOR,
            left: active.x,
            top: active.y,
            width: active.w,
            height: active.h,
            // 选区预览出图圆角
            borderRadius: sel ? clampRadius(frame.radius, active.w, active.h) : 0,
            // token-exception: 阴影预览、选区外 45% 黑压暗层
            boxShadow: [...(sel && frame.shadow ? [shadowCss(frame.shadow, frame.shadowAlpha)] : []), "0 0 0 99999px rgba(0,0,0,0.45)"].join(
              ", "
            ),
          }}
        />
      ) : (
        // token-exception: 截图遮罩的压暗层
        <div className="pointer-events-none absolute inset-0" style={{ background: "rgba(0,0,0,0.45)" }} />
      )}

      {sel && (history.shapes.length > 0 || draft) && (
        <ShotShapesSvg
          shapes={draft ? [...shownShapes, draft] : shownShapes}
          clip={sel}
          img={img}
          sx={sx}
          sy={sy}
        />
      )}

      {/* 选中的图形：虚线框 + 手柄，拖动移动、拖手柄缩放、⌫ 删除 */}
      {sel && edit.picked && <ShapeEditFrame shape={edit.picked} />}

      {active && pr && (!sel || dragging) && (
        <div
          className="pointer-events-none absolute rounded-sm bg-black/70 px-1.5 py-0.5 font-mono text-micro text-white tabular-nums"
          style={{ left: active.x, top: labelAbove ? active.y - 24 : active.y + 4 }}
        >
          {pr.w} × {pr.h}
        </div>
      )}

      {sel &&
        !dragging &&
        !locked &&
        HANDLES.map((h) => {
          const p = handlePoint(sel, h);
          return (
            <div
              key={h}
              className="pointer-events-none absolute size-2 rounded-full border-2 bg-white"
              style={{ left: p.x - 4, top: p.y - 4, borderColor: CROSSHAIR_COLOR }}
            />
          );
        })}

      {/* 选区上方：尺寸 + 出图圆角 / 阴影（参照 iShot） */}
      {sel && pr && !dragging && (
        <div
          className={cn(floatingSurface(), "absolute flex items-center gap-2 rounded-md px-2 py-1 text-label")}
          style={{ left: Math.min(sel.x, Math.max(0, W - FRAME_BAR_W)), top: sel.y >= 40 ? sel.y - 36 : sel.y + 6, cursor: "default" }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          <span className="font-mono text-muted-foreground tabular-nums">
            {pr.w} × {pr.h}
          </span>
          <span className="h-4 w-px bg-border" />
          <ShotFrameControls frame={frame} setFrame={setFrame} />
        </div>
      )}

      {sel && !dragging && notice && (
        <div
          className="pointer-events-none absolute rounded-md bg-black/75 px-2 py-1 text-label text-white"
          style={{ left: sel.x, top: Math.max(4, toolbarTop - 30) }}
        >
          {notice}
        </div>
      )}

      {sel && !dragging && (
        <div
          className={cn(
            floatingSurface(),
            // 工具条整体放大：按钮 30pt、图标 18pt
            "absolute flex flex-col justify-center gap-1.5 rounded-lg px-2 [&_[data-icon-button]]:p-1.5 [&_[data-icon-button]_svg]:size-4.5!"
          )}
          style={{ height: toolbarH, top: toolbarTop, ...(sel.x + sel.w < TOOLBAR_W_EST ? { left: 4 } : { right: Math.max(W - (sel.x + sel.w), 0) }) }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1">
            {SHOT_TOOLS.map(({ tool: id, icon: Icon, label, tip }) => (
              <TipButton
                key={id}
                label={t(label)}
                tip={t(tip)}
                pressed={tool === id}
                onClick={() => {
                  commitEditing();
                  void api.screenshotTrace("tool", SHOT_TOOLS.findIndex((x) => x.tool === id), 0);
                  setTool(tool === id ? null : id);
                }}
              >
                <Icon />
              </TipButton>
            ))}
            <span className="mx-0.5 h-4 w-px bg-border" />
            <TipButton
              label={t("撤销（⌘Z）")}
              disabled={!history.undo.length}
              onClick={() => setHistory(undo)}
            >
              <Undo2 />
            </TipButton>
            <TipButton
              label={t("重做（⇧⌘Z）")}
              disabled={!history.redo.length}
              onClick={() => setHistory(redo)}
            >
              <Redo2 />
            </TipButton>
            <span className="mx-0.5 h-4 w-px bg-border" />
            <TipButton
              label={t("长截屏")}
              tip={t("长截屏：点击后滚动页面，自动拼接成长图")}
              onClick={startLong}
            >
              <ScrollText />
            </TipButton>
            <TipButton
              label={t("识别文字")}
              tip={t("识别文字：提取选区里的文字，可复制或存入「剪贴」")}
              pressed={!!ocr}
              onClick={runOcr}
            >
              <ScanText />
            </TipButton>
            <TipButton
              label={hasTranslation ? t("去掉图内翻译") : t("图内翻译")}
              tip={hasTranslation ? t("去掉图内翻译") : t("图内翻译：把图里的外文原位替换成中文")}
              pressed={hasTranslation}
              disabled={translating}
              onClick={translateInImage}
            >
              {translating ? <Loader2 className="animate-spin" /> : <Languages />}
            </TipButton>
            {ACTIONS.map(({ action, icon: Icon, label, tip }) => (
              <TipButton key={action} label={t(label)} tip={t(tip)} onClick={() => confirm(action)}>
                <Icon />
              </TipButton>
            ))}
            <span className="mx-0.5 h-4 w-px bg-border" />
            <TipButton label={t("取消（Esc）")} onClick={cancel}>
              <X />
            </TipButton>
            <span className="relative inline-flex">
              <TipButton
                label={t("完成：复制并存入「剪贴」（Enter）；长按选择存入的分组")}
                onPointerDown={(e) => longPress.start(e.clientX, e.clientY)}
                onPointerMove={(e) => longPress.move(e.clientX, e.clientY)}
                onPointerUp={() => longPress.release()}
                onPointerLeave={() => longPress.cancel()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSectionMenu(true);
                }}
                onClick={() => {
                  if (longPress.consumeClick()) return;
                  confirm();
                }}
              >
                <Check className="text-primary" />
              </TipButton>
              {sectionMenu && (
                <div
                  className={cn(
                    floatingSurface(),
                    "absolute right-0 flex max-h-72 w-48 flex-col overflow-y-auto rounded-md p-1 text-body"
                  )}
                  style={toolbarTop > sel.y ? { top: toolbarH + 4 } : { bottom: toolbarH + 4 }}
                >
                  <span className="px-2 py-1 text-label text-muted-foreground">{t("存入分组")}</span>
                  {sections.length === 0 && (
                    <span className="px-2 py-1 text-label text-muted-foreground">{t("没有可存入的分组")}</span>
                  )}
                  {sections.map((sec) => (
                    <button
                      key={sec.id}
                      type="button"
                      className="truncate rounded-sm px-2 py-1 text-left hover:bg-accent"
                      onClick={() => {
                        setSectionMenu(false);
                        confirm("section", sec.id);
                      }}
                    >
                      {sec.name}
                    </button>
                  ))}
                </div>
              )}
            </span>
          </div>
          {showStyle && <ShotStyleRow {...styleRow} />}
        </div>
      )}

      {sel && ocr && (
        <div
          className={cn(floatingSurface(), "absolute flex flex-col gap-2 rounded-md p-2 text-body")}
          style={{
            width: OCR_PANEL_W,
            maxHeight: OCR_PANEL_MAX_H,
            top: Math.min(Math.max(sel.y, 8), Math.max(8, H - OCR_PANEL_MAX_H - 8)),
            left:
              sel.x + sel.w + 12 + OCR_PANEL_W <= W
                ? sel.x + sel.w + 12
                : sel.x - 12 - OCR_PANEL_W >= 0
                  ? sel.x - 12 - OCR_PANEL_W
                  : Math.max(8, sel.x + sel.w - OCR_PANEL_W - 8),
            cursor: "default",
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <span className="text-label text-muted-foreground">
              {ocr.busy ? t("识别中…") : t("识别结果")}
            </span>
            <IconButton label={t("关闭（Esc）")} size="xs" onClick={() => setOcr(null)}>
              <X />
            </IconButton>
          </div>
          <textarea
            value={ocr.text}
            disabled={ocr.busy}
            onChange={(e) => setOcr({ ...ocr, text: e.target.value })}
            className="min-h-24 flex-1 resize-none rounded-sm border border-border bg-background p-1.5 outline-none select-text"
          />
          {ocr.error && <span className="text-label text-warning">{ocr.error}</span>}
          <div className="flex justify-end gap-1.5">
            <Button size="xs" disabled={!ocr.text.trim()} onClick={copyOcr}>
              {ocr.copied ? t("已复制") : t("复制")}
            </Button>
            <Button size="xs" disabled={!ocr.text.trim()} onClick={saveOcr}>
              {t("存入「剪贴」")}
            </Button>
          </div>
        </div>
      )}

      {editing && (
        <textarea
          ref={textRef}
          value={editing.text}
          rows={Math.max(1, editing.text.split("\n").length)}
          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              commitEditing();
            }
          }}
          className="absolute resize-none overflow-hidden border border-dashed border-white/70 bg-transparent p-0 font-semibold leading-tight outline-none"
          style={{
            left: editing.x,
            top: editing.y,
            color: editing.color,
            fontSize: FONT_SIZE[editing.size],
            lineHeight: 1.25,
            minWidth: 40,
            width: Math.max(40, ...editing.text.split("\n").map((l) => l.length * FONT_SIZE[editing.size] * 0.9 + 12)),
          }}
        />
      )}

      {sel && !dragging && !sectionMenu && <HoverTip point={cursor} />}

      {/* 光标十字延长线：贯穿全屏，便于对齐边缘（未选区与拖出选区时显示） */}
      {showLoupe && cursor && (
        <>
          {/* 2px 半透明浅天蓝，压在光标中心 */}
          <div
            className="pointer-events-none absolute inset-x-0 h-0.5"
            style={{ top: Math.round(cursor.y) - 1, background: CROSSHAIR_COLOR }}
          />
          <div
            className="pointer-events-none absolute inset-y-0 w-0.5"
            style={{ left: Math.round(cursor.x) - 1, background: CROSSHAIR_COLOR }}
          />
        </>
      )}

      {showLoupe && loupePos && cursor && (
        <div
          className="pointer-events-none absolute overflow-hidden rounded-md border border-white/60 bg-black/80 text-micro text-white shadow-lg"
          style={{ left: loupePos.x, top: loupePos.y, width: LOUPE_SIZE }}
        >
          <canvas ref={loupeRef} style={{ width: LOUPE_SIZE, height: LOUPE_SIZE, display: "block" }} />
          <div className="space-y-0.5 px-1.5 py-1 font-mono tabular-nums">
            <div>
              {Math.round(cursor.x * sx)}, {Math.round(cursor.y * sy)}
            </div>
            <div className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-sm border border-white/50" style={{ background: sampled }} />
              {copied ? t("已复制") : `${sampled}  C · ⇧C RGB`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
