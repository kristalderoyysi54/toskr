import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  Circle,
  Grid3x3,
  Hash,
  MoveUpRight,
  Pencil,
  Pin,
  Redo2,
  ScanText,
  Send,
  Shield,
  Square,
  Type,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";

import { ShotShapesSvg } from "@/components/ShotShapesSvg";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { useT, type MessageKey } from "@/lib/i18n";
import {
  COLORS,
  drawShapes,
  emptyHistory,
  FONT_SIZE,
  nextNumber,
  pushShape,
  redo,
  SIZES,
  undo,
  type History,
  type Shape,
  type SizeLevel,
  type Tool,
} from "@/lib/screenshot/annotate";
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
  type ScreenshotAction,
  type ScreenshotSession,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Drag =
  | { kind: "create"; x: number; y: number; moved: boolean }
  | { kind: "move"; x: number; y: number; orig: Rect }
  | { kind: "resize"; x: number; y: number; orig: Rect; handle: Handle };

/** 起拖阈值：小于此距离的按放视为单击（选中悬停窗口）。 */
const DRAG_SLOP = 3;
/** 放大镜：取样边长（冻结帧像素）× 放大倍数 = 画布边长（pt）。 */
const LOUPE_SAMPLE = 15;
const LOUPE_SIZE = 120;
const LOUPE_PANEL_H = LOUPE_SIZE + 44;
/** 工具条宽度估值：选区右缘离屏幕左边不足此宽时改为贴左，避免工具条被裁掉。 */
const TOOLBAR_W_EST = 480;

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

const TOOLS: { tool: Tool; icon: LucideIcon; label: MessageKey }[] = [
  { tool: "rect", icon: Square, label: "矩形" },
  { tool: "ellipse", icon: Circle, label: "椭圆" },
  { tool: "arrow", icon: MoveUpRight, label: "箭头" },
  { tool: "pen", icon: Pencil, label: "画笔" },
  { tool: "text", icon: Type, label: "文字" },
  { tool: "mosaic", icon: Grid3x3, label: "马赛克" },
  { tool: "number", icon: Hash, label: "序号" },
];

const ACTIONS: { action: ScreenshotAction; icon: LucideIcon; label: MessageKey }[] = [
  { action: "pin", icon: Pin, label: "钉在屏幕上" },
  { action: "ocr", icon: ScanText, label: "识别文字" },
  { action: "edit", icon: Shield, label: "在编辑器中打开（打码）" },
  { action: "send", icon: Send, label: "发送到当前目标" },
];

/** 上次用的标注颜色与粗细（每台机器的使用习惯，存 localStorage）。 */
const STYLE_KEY = "toskr.screenshotStyle";

function loadStyle(): { ink: string; size: SizeLevel } {
  try {
    const v = JSON.parse(localStorage.getItem(STYLE_KEY) ?? "{}") as { ink?: unknown; size?: unknown };
    return {
      ink: typeof v.ink === "string" && COLORS.includes(v.ink) ? v.ink : COLORS[0],
      size: SIZES.includes(v.size as SizeLevel) ? (v.size as SizeLevel) : 1,
    };
  } catch {
    return { ink: COLORS[0], size: 1 };
  }
}

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
  const [ink, setInk] = useState(() => loadStyle().ink);
  const [size, setSize] = useState<SizeLevel>(() => loadStyle().size);
  const [history, setHistory] = useState<History>(emptyHistory);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [editing, setEditing] = useState<{ x: number; y: number; text: string } | null>(null);
  const drag = useRef<Drag | null>(null);
  useEffect(() => {
    localStorage.setItem(STYLE_KEY, JSON.stringify({ ink, size }));
  }, [ink, size]);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionRef = useRef<number | null>(null);
  const urlRef = useRef<string | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);
  const [sampled, setSampled] = useState("");

  const reset = useCallback(() => {
    sessionRef.current = null;
    drag.current = null;
    setInfo(null);
    setImg(null);
    setSel(null);
    setCursor(null);
    setDragging(false);
    setTool(null);
    setHistory(emptyHistory);
    setDraft(null);
    setEditing(null);
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
    if (editingAt) textRef.current?.focus();
  }, [editingAt]);

  /** 正在输入的文字也算进出图与撤销历史。 */
  const shapesWithEditing = useCallback((): Shape[] => {
    if (!editing?.text.trim()) return history.shapes;
    return [...history.shapes, { kind: "text", x: editing.x, y: editing.y, text: editing.text, color: ink, size }];
  }, [editing, history.shapes, ink, size]);

  const commitEditing = useCallback(() => {
    if (!editing) return;
    setHistory((h) => pushShape(h, { kind: "text", x: editing.x, y: editing.y, text: editing.text, color: ink, size }));
    setEditing(null);
  }, [editing, ink, size]);

  const confirm = useCallback((action: ScreenshotAction = "save") => {
    if (!sel || !info || !img) return;
    const pr = toPixelRect(sel, sx, sy, info.pxW, info.pxH);
    if (pr.w < 1 || pr.h < 1) return;
    const canvas = document.createElement("canvas");
    canvas.width = pr.w;
    canvas.height = pr.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, pr.x, pr.y, pr.w, pr.h, 0, 0, pr.w, pr.h);
    ctx.save();
    ctx.scale(sx, sy);
    ctx.translate(-pr.x / sx, -pr.y / sy);
    drawShapes(ctx, shapesWithEditing(), img, sx, sy);
    ctx.restore();
    const data = ctx.getImageData(0, 0, pr.w, pr.h).data;
    reset();
    const at = { x: sel.x, y: sel.y };
    void api.screenshotCommit(new Uint8Array(data.buffer), pr.w, pr.h, action, at).catch(() => {
      void api.screenshotCancel();
    });
  }, [sel, info, img, sx, sy, reset, shapesWithEditing]);

  const copyColor = useCallback(() => {
    if (!sampled) return;
    void api.copyText(sampled).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 900);
    });
  }, [sampled]);

  // 遮罩临时接管键盘：capture 阶段监听，不赌焦点
  useEffect(() => {
    if (!info) return;
    const onKey = (e: KeyboardEvent) => {
      // 文字输入框自己处理按键
      if (editing) return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.metaKey && e.key.toLowerCase() === "z") {
        stop();
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
      } else if (e.key === "Escape") {
        stop();
        if (tool) setTool(null);
        else if (sel) {
          setSel(null);
          setHistory(emptyHistory);
        } else cancel();
      } else if (e.key === "Enter" || (e.metaKey && e.key.toLowerCase() === "c")) {
        stop();
        confirm();
      } else if (!e.metaKey && e.key.toLowerCase() === "c") {
        stop();
        copyColor();
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
  }, [info, sel, W, H, cancel, confirm, copyColor, editing, tool, history.shapes.length]);

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
          .screenshotCursor()
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

  const point = (e: ReactPointerEvent) => ({ x: e.clientX, y: e.clientY });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !info) return;
    const p = point(e);
    if (editing) commitEditing();
    if (sel && tool) {
      if (!inside(sel, p.x, p.y)) return;
      if (tool === "text") {
        // 文字框以光标为左上角，字号的一半上提让首行落在点击处
        if (!editing) setEditing({ x: p.x, y: p.y - FONT_SIZE[size] / 2, text: "" });
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
    const p = point(e);
    setCursor(p);
    if (draft) {
      setDraft(
        draft.kind === "pen"
          ? { ...draft, points: [...draft.points, [p.x, p.y]] }
          : draft.kind === "text" || draft.kind === "number"
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

  const onPointerUp = () => {
    if (draft) {
      void api.screenshotTrace("pushed", draft.kind === "pen" ? draft.points.length : 0, 0);
      setHistory((h) => pushShape(h, draft));
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
  const inSel = !!(sel && cursor && inside(sel, cursor.x, cursor.y));
  const cursorStyle = tool
    ? inSel
      ? tool === "text"
        ? "text"
        : "crosshair"
      : "default"
    : handle
      ? HANDLE_CURSOR[handle]
      : inSel && !locked
        ? "move"
        : sel && locked
          ? "default"
          : "crosshair";
  const pr = active ? toPixelRect(active, sx, sy, info.pxW, info.pxH) : null;
  const labelAbove = active && active.y >= 26;
  const loupePos = cursor ? placeNear(cursor.x, cursor.y, LOUPE_SIZE, LOUPE_PANEL_H, W, H) : null;
  const showStyle = !!tool && tool !== "mosaic";
  const toolbarH = showStyle ? 70 : 36;
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
      onDoubleClick={(e) => !tool && sel && inside(sel, e.clientX, e.clientY) && confirm()}
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
          className="pointer-events-none absolute outline outline-1 outline-primary"
          style={{
            left: active.x,
            top: active.y,
            width: active.w,
            height: active.h,
            // token-exception: 截图遮罩的压暗层（选区外 45% 黑）
            boxShadow: "0 0 0 99999px rgba(0,0,0,0.45)",
          }}
        />
      ) : (
        // token-exception: 截图遮罩的压暗层
        <div className="pointer-events-none absolute inset-0" style={{ background: "rgba(0,0,0,0.45)" }} />
      )}

      {sel && (history.shapes.length > 0 || draft) && (
        <ShotShapesSvg
          shapes={draft ? [...history.shapes, draft] : history.shapes}
          clip={sel}
          img={img}
          sx={sx}
          sy={sy}
        />
      )}

      {active && pr && (
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
              className="pointer-events-none absolute size-2 rounded-full border border-primary bg-white"
              style={{ left: p.x - 4, top: p.y - 4 }}
            />
          );
        })}

      {sel && !dragging && (
        <div
          className={cn(floatingSurface(), "absolute flex flex-col justify-center gap-1 rounded-md px-1.5")}
          style={{ height: toolbarH, top: toolbarTop, ...(sel.x + sel.w < TOOLBAR_W_EST ? { left: 4 } : { right: Math.max(W - (sel.x + sel.w), 0) }) }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1">
            {TOOLS.map(({ tool: id, icon: Icon, label }) => (
              <IconButton
                key={id}
                label={t(label)}
                pressed={tool === id}
                onClick={() => {
                  commitEditing();
                  void api.screenshotTrace("tool", TOOLS.findIndex((x) => x.tool === id), 0);
                  setTool(tool === id ? null : id);
                }}
              >
                <Icon />
              </IconButton>
            ))}
            <span className="mx-0.5 h-4 w-px bg-border" />
            <IconButton label={t("撤销（⌘Z）")} disabled={!history.shapes.length} onClick={() => setHistory(undo)}>
              <Undo2 />
            </IconButton>
            <IconButton label={t("重做（⇧⌘Z）")} disabled={!history.redo.length} onClick={() => setHistory(redo)}>
              <Redo2 />
            </IconButton>
            <span className="mx-0.5 h-4 w-px bg-border" />
            {ACTIONS.map(({ action, icon: Icon, label }) => (
              <IconButton key={action} label={t(label)} onClick={() => confirm(action)}>
                <Icon />
              </IconButton>
            ))}
            <span className="mx-0.5 h-4 w-px bg-border" />
            <IconButton label={t("取消（Esc）")} onClick={cancel}>
              <X />
            </IconButton>
            <IconButton label={t("完成：复制并存入「剪贴」（Enter）")} onClick={() => confirm()}>
              <Check className="text-primary" />
            </IconButton>
          </div>
          {showStyle && (
            <div className="flex items-center gap-2 px-1">
              {SIZES.map((lv) => (
                <button
                  key={lv}
                  type="button"
                  aria-label={t("粗细 {n}", { n: lv + 1 })}
                  aria-pressed={size === lv}
                  onClick={() => setSize(lv)}
                  className={cn(
                    "flex size-5 items-center justify-center rounded-sm",
                    size === lv && "bg-accent"
                  )}
                >
                  <span className="rounded-full bg-foreground" style={{ width: 4 + lv * 3, height: 4 + lv * 3 }} />
                </button>
              ))}
              <span className="h-4 w-px bg-border" />
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  aria-pressed={ink === c}
                  onClick={() => setInk(c)}
                  className={cn(
                    "size-4 rounded-sm border border-border",
                    ink === c && "ring-2 ring-primary ring-offset-1 ring-offset-popover"
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          )}
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
            color: ink,
            fontSize: FONT_SIZE[size],
            lineHeight: 1.25,
            minWidth: 40,
            width: Math.max(40, ...editing.text.split("\n").map((l) => l.length * FONT_SIZE[size] * 0.9 + 12)),
          }}
        />
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
              {copied ? t("已复制") : `${sampled}  C`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
