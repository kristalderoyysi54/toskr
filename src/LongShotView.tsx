import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Crop, Download, Redo2, Undo2, X } from "lucide-react";

import { ShapeEditFrame } from "@/components/ShapeEditFrame";
import { ShotShapesSvg } from "@/components/ShotShapesSvg";
import {
  HoverTip,
  SHOT_TOOLS,
  ShotFrameControls,
  ShotStyleRow,
  TipButton,
  toolHasStyle,
  useShotFrame,
  useShotStyle,
} from "@/components/ShotToolParts";
import { clampRadius, frameImage, shadowCss } from "@/lib/screenshot/frame";
import { shapeAt } from "@/lib/screenshot/shapeEdit";
import { floatingSurface } from "@/components/ui/floating-surface";
import { NOTE_SECTIONS, type NoteSectionOption } from "@/lib/draftSection";
import { useT } from "@/lib/i18n";
import { createLongPress } from "@/lib/longPress";
import {
  drawShapes,
  emptyHistory,
  FONT_SIZE,
  nextNumber,
  dragEnd,
  pushShape,
  redo,
  undo,
  type History,
  commitText,
  type Shape,
  type SizeLevel,
  type TextDraft,
  withTextDraft,
  type Tool,
  calloutPrompt,
  commitNote,
  isMeaningful,
  type NoteDraft,
  withNoteDraft,
} from "@/lib/screenshot/annotate";
import { ShotCallouts } from "@/components/ShotCallouts";
import { handlePoint, HANDLES, resizeRect, toPixelRect, type Handle, type Rect } from "@/lib/screenshot/geometry";
import { useShapeEdit } from "@/lib/screenshot/useShapeEdit";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** 裁剪框最小边长（pt）。 */
const MIN_CROP = 16;

/** 长图标注窗：可滚动查看拼好的长截屏，用与截图遮罩相同的工具标注，可裁剪，完成后存入「剪贴」/ 分组 / 另存为。
 * 从钉图或图片卡打开时，✓ 改为写回来源（更新钉图 / 替换卡片里的原图）。 */
export default function LongShotView() {
  const t = useT();
  const [info, setInfo] = useState<{ pxW: number; pxH: number; scale: number; origin: "capture" | "pin" | "note" } | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const style = useShotStyle(tool);
  const { ink, size } = style;
  const [history, setHistory] = useState<History>(emptyHistory);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [editing, setEditing] = useState<TextDraft | null>(null);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  // 出图圆角 / 阴影 / 背景（与截图遮罩共用设置）
  const [frame, setFrame] = useShotFrame();
  const [busy, setBusy] = useState(false);
  const [viewW, setViewW] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  // 裁剪框（图片 pt），null = 整张；cropping 时显示手柄
  const [crop, setCrop] = useState<Rect | null>(null);
  const [cropping, setCropping] = useState(false);
  const cropDrag = useRef<{ handle: Handle; x: number; y: number; orig: Rect } | null>(null);

  useEffect(() => {
    let url: string | null = null;
    void Promise.all([api.longInfo(), api.longImage()])
      .then(async ([meta, buf]) => {
        if (!meta) return;
        url = URL.createObjectURL(new Blob([buf], { type: "image/bmp" }));
        const image = new Image();
        image.src = url;
        await image.decode();
        setInfo(meta);
        setImg(image);
      })
      .catch(() => void api.longClose());
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [info]);

  const ptW = info ? info.pxW / info.scale : 0;
  const ptH = info ? info.pxH / info.scale : 0;
  // 宽于窗口时等比缩小显示；图形坐标始终是图片 pt
  const z = ptW > 0 && viewW > 0 ? Math.min(1, (viewW - 32) / ptW) : 1;
  const scale = info?.scale ?? 1;

  const commitEditing = useCallback(() => {
    if (editing) {
      setHistory((h) => commitText(h, editing));
      setEditing(null);
    }
    if (noteDraft) {
      setHistory((h) => commitNote(h, noteDraft));
      setNoteDraft(null);
    }
  }, [editing, noteDraft]);

  const editingAt = editing ? `${editing.x},${editing.y}` : null;
  useEffect(() => {
    const el = textRef.current;
    if (!editingAt || !el) return;
    el.focus();
    // 双击改已有文字时光标放到末尾
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editingAt]);

  const finish = useCallback(
    (action: "save" | "section" | "saveas" | "replace", sectionId?: string) => {
      if (!info || !img || busy) return;
      const shapes = withNoteDraft(withTextDraft(history.shapes, editing), noteDraft);
      const canvas = document.createElement("canvas");
      canvas.width = info.pxW;
      canvas.height = info.pxH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      ctx.save();
      ctx.scale(scale, scale);
      drawShapes(ctx, shapes, img, scale, scale);
      ctx.restore();
      const out = crop ? toPixelRect(crop, scale, scale, info.pxW, info.pxH) : { x: 0, y: 0, w: info.pxW, h: info.pxH };
      const raw = { data: new Uint8Array(ctx.getImageData(out.x, out.y, out.w, out.h).data.buffer), w: out.w, h: out.h };
      const pad = Math.round(frame.shadow * scale);
      const img2 = frame.radius > 0 || pad > 0 ? frameImage(raw, frame.radius * scale, pad, frame.shadowAlpha) : raw;
      setBusy(true);
      // 批注说明：新图随图入库；图片卡写回时追加到卡片备注
      const caption = calloutPrompt(shapes, t("图上的标注（序号对应图中区域）："));
      void api.longCommit(img2.data, img2.w, img2.h, action, sectionId, caption).catch(() => setBusy(false));
    },
    [info, img, busy, editing, noteDraft, history.shapes, scale, crop, frame, t]
  );

  // 钉图 / 图片卡：✓ 写回来源；新截的长图：✓ 存入「剪贴」
  const primary = info && info.origin !== "capture" ? "replace" : "save";

  // 长按 ✓（或右键）选笔记分组
  const [sections, setSections] = useState<NoteSectionOption[]>([]);
  const [sectionMenu, setSectionMenu] = useState(false);
  const longPress = useMemo(() => createLongPress(() => setSectionMenu(true)), []);
  useEffect(() => {
    const off = listen<NoteSectionOption[]>(NOTE_SECTIONS, (event) => setSections(event.payload));
    void api.screenshotRequestSections().catch(() => {});
    return () => void off.then((f) => f());
  }, []);

  // 已画图形的选中与调整（钉图编辑也走这里）：无工具时可选任意图形，有工具时只选同类
  const edit = useShapeEdit({
    history,
    setHistory,
    W: ptW,
    H: ptH,
    tol: 6 / z,
    canPick: (s) => !tool || s.kind === tool,
  });
  const editRef = useRef(edit);
  editRef.current = edit;
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || noteDraft) return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (!sectionMenu && editRef.current.key(e)) {
        stop();
      } else if (e.key === "Escape") {
        stop();
        if (sectionMenu) setSectionMenu(false);
        else if (cropping) setCropping(false);
        else setTool(null);
      } else if (e.metaKey && e.key.toLowerCase() === "z") {
        stop();
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
      } else if (e.key === "Enter" && !sectionMenu) {
        stop();
        finish(primary);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [editing, noteDraft, sectionMenu, cropping, finish, primary]);

  const point = (e: ReactPointerEvent) => {
    const r = pageRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || cropping) return;
    const p = point(e);
    if (editing || noteDraft) commitEditing();
    if (edit.down(p.x, p.y)) {
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (!tool) return;
    if (tool === "text") {
      if (!editing) setEditing({ x: p.x, y: p.y - FONT_SIZE[size] / 2, text: "", color: ink, size });
      return;
    }
    if (tool === "number") {
      setHistory((h) => pushShape(h, { kind: "number", x: p.x, y: p.y, n: nextNumber(h.shapes), color: ink, size }));
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft(
      tool === "pen"
        ? { kind: "pen", points: [[p.x, p.y]], color: ink, size }
        : tool === "callout"
          ? { kind: "callout", x1: p.x, y1: p.y, x2: p.x, y2: p.y, note: "", color: ink, size }
          : { kind: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: ink, size }
    );
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = point(e);
    if (edit.move(p.x, p.y)) return;
    if (!draft) {
      setHoverCursor(cropping ? null : edit.cursor(p.x, p.y));
      return;
    }
    setDraft(
      draft.kind === "pen"
        ? { ...draft, points: [...draft.points, [p.x, p.y]] }
        : draft.kind === "text" || draft.kind === "number" || draft.kind === "translate"
          ? draft
          : { ...draft, ...dragEnd(draft, p.x, p.y, e.shiftKey) }
    );
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = point(e);
    if (edit.up(p.x, p.y)) return;
    if (!draft) return;
    // 按松手处收尾：最后一次 pointermove 的状态可能还没渲染进 draft
    const done: Shape =
      draft.kind === "pen"
        ? { ...draft, points: [...draft.points, [p.x, p.y]] }
        : "x2" in draft
          ? { ...draft, ...dragEnd(draft, p.x, p.y, e.shiftKey) }
          : draft;
    // 批注框画完先填说明
    if (done.kind === "callout" && isMeaningful(done)) setNoteDraft({ shape: done, text: "" });
    else setHistory((h) => pushShape(h, done));
    setDraft(null);
  };

  if (!info || !img) return null;
  // 改已有文字时原文字先藏起来，由输入框显示
  const shown = withNoteDraft(editing?.orig ? edit.shapes.filter((s) => s !== editing.orig) : edit.shapes, noteDraft);
  const shapes = draft ? [...shown, draft] : shown;
  // 选中图形时样式行显示并修改该图形的颜色 / 粗细；输入文字时改正在输入的文字
  const pickedStyled = editing ?? (edit.picked && "size" in edit.picked ? edit.picked : null);
  const styleKind = editing ? "text" : (pickedStyled && "kind" in pickedStyled ? pickedStyled.kind : tool);
  const styleRow = {
    ink: pickedStyled?.color ?? ink,
    size: (pickedStyled?.size ?? size) as SizeLevel,
    setInk: (c: string) => {
      style.setInk(c, styleKind);
      if (editing) setEditing({ ...editing, color: c });
      else edit.restyle({ color: c });
    },
    setSize: (lv: SizeLevel) => {
      style.setSize(lv, styleKind);
      if (editing) setEditing({ ...editing, size: lv });
      else edit.restyle({ size: lv });
    },
    colors: styleKind !== "mosaic",
  };
  const cropRect = crop ?? { x: 0, y: 0, w: ptW, h: ptH };
  const outPx = crop ? toPixelRect(crop, scale, scale, info.pxW, info.pxH) : { w: info.pxW, h: info.pxH };

  return (
    <div className="fixed inset-0 flex flex-col bg-background text-body text-foreground">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1">
          {SHOT_TOOLS.map(({ tool: id, icon: Icon, label, tip }) => (
            <TipButton
              key={id}
              label={t(label)}
              tip={t(tip)}
              pressed={tool === id}
              onClick={() => {
                commitEditing();
                setCropping(false);
                setTool(tool === id ? null : id);
              }}
            >
              <Icon />
            </TipButton>
          ))}
          <TipButton
            label={t("裁剪：拖动边角调整，Esc 结束")}
            pressed={cropping}
            onClick={() => {
              commitEditing();
              setTool(null);
              setCropping(!cropping);
            }}
          >
            <Crop />
          </TipButton>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <TipButton label={t("撤销（⌘Z）")} disabled={!history.undo.length} onClick={() => setHistory(undo)}>
            <Undo2 />
          </TipButton>
          <TipButton label={t("重做（⇧⌘Z）")} disabled={!history.redo.length} onClick={() => setHistory(redo)}>
            <Redo2 />
          </TipButton>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <ShotFrameControls frame={frame} setFrame={setFrame} />
          <span className="flex-1" />
          <span className="mr-1 font-mono text-label text-muted-foreground tabular-nums">
            {outPx.w} × {outPx.h}
          </span>
          <TipButton
            label={t("另存为图片…")}
            tip={t("另存为图片…：保存为 PNG 文件")}
            disabled={busy}
            onClick={() => finish("saveas")}
          >
            <Download />
          </TipButton>
          <TipButton label={info.origin === "capture" ? t("放弃长截屏") : t("放弃标注")} onClick={() => void api.longClose()}>
            <X />
          </TipButton>
          <span className="relative inline-flex">
            <TipButton
              label={
                info.origin === "pin"
                  ? t("完成：更新钉图（Enter）；长按选择存入的分组")
                  : info.origin === "note"
                    ? t("完成：替换卡片里的原图（Enter，可撤销）；长按选择存入的分组")
                    : t("完成：复制并存入「剪贴」（Enter）；长按选择存入的分组")
              }
              disabled={busy}
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
                finish(primary);
              }}
            >
              <Check className="text-primary" />
            </TipButton>
            {sectionMenu && (
              <div
                className={cn(
                  floatingSurface(),
                  "absolute right-0 top-8 z-10 flex max-h-72 w-48 flex-col overflow-y-auto rounded-md p-1 text-body"
                )}
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
                      finish("section", sec.id);
                    }}
                  >
                    {sec.name}
                  </button>
                ))}
              </div>
            )}
          </span>
        </div>
        {toolHasStyle(styleKind) && <ShotStyleRow {...styleRow} />}
      </div>
      {!sectionMenu && <HoverTip />}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-muted/40 p-4">
        <div
          ref={pageRef}
          className={cn("relative mx-auto select-none", !frame.shadow && "shadow-md")}
          style={{
            boxShadow: frame.shadow ? shadowCss(frame.shadow * z, frame.shadowAlpha) : undefined,
            borderRadius: clampRadius(frame.radius, ptW, ptH) * z,
            width: ptW * z, height: ptH * z, cursor: hoverCursor ?? (tool ? (tool === "text" ? "text" : "crosshair") : "default") }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          // 阻止按下时浏览器把焦点挪回 body（会抢走刚聚焦的文字框）
          onMouseDown={(e) => tool && e.target === e.currentTarget && e.preventDefault()}
          onDoubleClick={(e) => {
            // 双击已有文字改内容；双击批注改说明
            const r = pageRef.current!.getBoundingClientRect();
            const x = (e.clientX - r.left) / z;
            const y = (e.clientY - r.top) / z;
            if (!tool || tool === "callout") {
              const ci = shapeAt(history.shapes, x, y, 4 / z, (s) => s.kind === "callout");
              const c = ci === null ? undefined : history.shapes[ci];
              if (c?.kind === "callout") {
                edit.clear();
                setNoteDraft({ shape: c, text: c.note, orig: c });
                return;
              }
            }
            if (tool && tool !== "text") return;
            const i = shapeAt(history.shapes, x, y, 4 / z, (s) => s.kind === "text");
            const s = i === null ? undefined : history.shapes[i];
            if (s?.kind !== "text") return;
            edit.clear();
            setEditing({ x: s.x, y: s.y, text: s.text, color: s.color, size: s.size, orig: s });
          }}
        >
          <img
            src={img.src}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-0 size-full"
            style={{ borderRadius: clampRadius(frame.radius, ptW, ptH) * z }}
          />
          {shapes.length > 0 && (
            <ShotShapesSvg
              shapes={shapes}
              clip={{ x: 0, y: 0, w: ptW, h: ptH }}
              img={img}
              sx={scale}
              sy={scale}
              viewBox={`0 0 ${ptW} ${ptH}`}
            />
          )}
          {edit.picked && <ShapeEditFrame shape={edit.picked} z={z} />}
          <ShotCallouts
            shapes={shown}
            draft={noteDraft}
            z={z}
            onChange={(text) => setNoteDraft((d) => d && { ...d, text })}
            onCommit={commitEditing}
          />
          {crop && (
            <div
              className="pointer-events-none absolute outline outline-1 outline-primary"
              style={{
                left: cropRect.x * z,
                top: cropRect.y * z,
                width: cropRect.w * z,
                height: cropRect.h * z,
                // token-exception: 裁掉区域的压暗层（同截图遮罩 45% 黑）
                boxShadow: "0 0 0 99999px rgba(0,0,0,0.45)",
              }}
            />
          )}
          {cropping &&
            HANDLES.map((h) => {
              const p = handlePoint(cropRect, h);
              return (
                <div
                  key={h}
                  className="absolute size-3 rounded-full border border-primary bg-white"
                  style={{ left: p.x * z - 6, top: p.y * z - 6, cursor: `${h}-resize` }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const q = point(e);
                    cropDrag.current = { handle: h, x: q.x, y: q.y, orig: cropRect };
                  }}
                  onPointerMove={(e) => {
                    const d = cropDrag.current;
                    if (!d || d.handle !== h) return;
                    const q = point(e);
                    const next = resizeRect(d.orig, h, q.x - d.x, q.y - d.y, ptW, ptH);
                    if (next.w >= MIN_CROP && next.h >= MIN_CROP) setCrop(next);
                  }}
                  onPointerUp={() => (cropDrag.current = null)}
                />
              );
            })}
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
              className="absolute resize-none overflow-hidden border border-dashed border-foreground/50 bg-transparent p-0 font-semibold outline-none"
              style={{
                left: editing.x * z,
                top: editing.y * z,
                color: editing.color,
                fontSize: FONT_SIZE[editing.size] * z,
                lineHeight: 1.25,
                minWidth: 40,
                width: Math.max(40, ...editing.text.split("\n").map((l) => l.length * FONT_SIZE[editing.size] * z * 0.9 + 12)),
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
