import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Download, Redo2, Undo2, X } from "lucide-react";

import { ShotShapesSvg } from "@/components/ShotShapesSvg";
import { SHOT_TOOLS, ShotStyleRow, toolHasStyle, useShotStyle } from "@/components/ShotToolParts";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { NOTE_SECTIONS, type NoteSectionOption } from "@/lib/draftSection";
import { useT } from "@/lib/i18n";
import { createLongPress } from "@/lib/longPress";
import {
  drawShapes,
  emptyHistory,
  FONT_SIZE,
  nextNumber,
  pushShape,
  redo,
  undo,
  type History,
  type Shape,
  type Tool,
} from "@/lib/screenshot/annotate";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** 长图标注窗：可滚动查看拼好的长截屏，用与截图遮罩相同的工具标注，完成后存入「剪贴」/ 分组 / 另存为。 */
export default function LongShotView() {
  const t = useT();
  const [info, setInfo] = useState<{ pxW: number; pxH: number; scale: number } | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const style = useShotStyle();
  const { ink, size } = style;
  const [history, setHistory] = useState<History>(emptyHistory);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [editing, setEditing] = useState<{ x: number; y: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewW, setViewW] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

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
    if (!editing) return;
    setHistory((h) => pushShape(h, { kind: "text", x: editing.x, y: editing.y, text: editing.text, color: ink, size }));
    setEditing(null);
  }, [editing, ink, size]);

  const editingAt = editing ? `${editing.x},${editing.y}` : null;
  useEffect(() => {
    if (editingAt) textRef.current?.focus();
  }, [editingAt]);

  const finish = useCallback(
    (action: "save" | "section" | "saveas", sectionId?: string) => {
      if (!info || !img || busy) return;
      const shapes = editing?.text.trim()
        ? [...history.shapes, { kind: "text" as const, x: editing.x, y: editing.y, text: editing.text, color: ink, size }]
        : history.shapes;
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
      const data = new Uint8Array(ctx.getImageData(0, 0, info.pxW, info.pxH).data.buffer);
      setBusy(true);
      void api.longCommit(data, info.pxW, info.pxH, action, sectionId).catch(() => setBusy(false));
    },
    [info, img, busy, editing, history.shapes, ink, size, scale]
  );

  // 长按 ✓（或右键）选笔记分组
  const [sections, setSections] = useState<NoteSectionOption[]>([]);
  const [sectionMenu, setSectionMenu] = useState(false);
  const longPress = useMemo(() => createLongPress(() => setSectionMenu(true)), []);
  useEffect(() => {
    const off = listen<NoteSectionOption[]>(NOTE_SECTIONS, (event) => setSections(event.payload));
    void api.screenshotRequestSections().catch(() => {});
    return () => void off.then((f) => f());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing) return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape") {
        stop();
        if (sectionMenu) setSectionMenu(false);
        else setTool(null);
      } else if (e.metaKey && e.key.toLowerCase() === "z") {
        stop();
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
      } else if (e.key === "Enter" && !sectionMenu) {
        stop();
        finish("save");
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [editing, sectionMenu, finish]);

  const point = (e: ReactPointerEvent) => {
    const r = pageRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !tool) return;
    const p = point(e);
    if (editing) commitEditing();
    if (tool === "text") {
      if (!editing) setEditing({ x: p.x, y: p.y - FONT_SIZE[size] / 2, text: "" });
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
        : { kind: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: ink, size }
    );
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draft) return;
    const p = point(e);
    setDraft(
      draft.kind === "pen"
        ? { ...draft, points: [...draft.points, [p.x, p.y]] }
        : draft.kind === "text" || draft.kind === "number" || draft.kind === "translate"
          ? draft
          : { ...draft, x2: p.x, y2: p.y }
    );
  };

  const onPointerUp = () => {
    if (!draft) return;
    setHistory((h) => pushShape(h, draft));
    setDraft(null);
  };

  if (!info || !img) return null;
  const shapes = draft ? [...history.shapes, draft] : history.shapes;

  return (
    <div className="fixed inset-0 flex flex-col bg-background text-body text-foreground">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1">
          {SHOT_TOOLS.map(({ tool: id, icon: Icon, label }) => (
            <IconButton
              key={id}
              label={t(label)}
              pressed={tool === id}
              onClick={() => {
                commitEditing();
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
          <span className="flex-1" />
          <span className="mr-1 font-mono text-label text-muted-foreground tabular-nums">
            {info.pxW} × {info.pxH}
          </span>
          <IconButton label={t("另存为图片…")} disabled={busy} onClick={() => finish("saveas")}>
            <Download />
          </IconButton>
          <IconButton label={t("放弃长截屏")} onClick={() => void api.longClose()}>
            <X />
          </IconButton>
          <span className="relative inline-flex">
            <IconButton
              label={t("完成：复制并存入「剪贴」（Enter）；长按选择存入的分组")}
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
                finish("save");
              }}
            >
              <Check className="text-primary" />
            </IconButton>
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
        {toolHasStyle(tool) && <ShotStyleRow {...style} />}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-muted/40 p-4">
        <div
          ref={pageRef}
          className="relative mx-auto select-none shadow-md"
          style={{ width: ptW * z, height: ptH * z, cursor: tool ? (tool === "text" ? "text" : "crosshair") : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          // 阻止按下时浏览器把焦点挪回 body（会抢走刚聚焦的文字框）
          onMouseDown={(e) => tool && e.target === e.currentTarget && e.preventDefault()}
        >
          <img src={img.src} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full" />
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
                color: ink,
                fontSize: FONT_SIZE[size] * z,
                lineHeight: 1.25,
                minWidth: 40,
                width: Math.max(40, ...editing.text.split("\n").map((l) => l.length * FONT_SIZE[size] * z * 0.9 + 12)),
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
