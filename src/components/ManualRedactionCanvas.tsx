import { Grid3x3, Pipette, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import {
  containedImageRect,
  imagePointFromClient,
  moveBox,
  pixelBoxFromDrag,
  pixelBoxStyle,
  REDACTION_BLACK,
  REDACTION_STYLE_OPTIONS,
  redactedRegionPixels,
  resizeBox,
  sameRedactionStyle,
  transformedImageRect,
  type ResizeHandle,
} from "@/lib/imageEditor";
import {
  FIT_VIEW,
  wheelZoomFactor,
  zoomViewAround,
  type ZoomView,
} from "@/lib/imageZoom";
import type { ImagePixelBox, RedactionRegion, RedactionStyle } from "@/lib/tauri";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** 自动识别出的候选位置：未打码，点一下转为正式框。 */
export type RedactionCandidate = { box: ImagePixelBox; label: string };

type Point = { x: number; y: number };

type Gesture =
  | { kind: "draw"; pointerId: number; startClient: Point; startImage: Point; currentImage: Point }
  | { kind: "move"; pointerId: number; index: number; startImage: Point; origin: ImagePixelBox; current: ImagePixelBox }
  | { kind: "resize"; pointerId: number; index: number; handle: ResizeHandle; origin: ImagePixelBox; current: ImagePixelBox }
  | { kind: "pan"; pointerId: number; startX: number; startY: number; originX: number; originY: number };

const HANDLES: ResizeHandle[] = ["nw", "ne", "sw", "se"];
const HANDLE_POSITION: Record<ResizeHandle, string> = {
  nw: "-left-1 -top-1 cursor-nwse-resize",
  ne: "-right-1 -top-1 cursor-nesw-resize",
  sw: "-left-1 -bottom-1 cursor-nesw-resize",
  se: "-right-1 -bottom-1 cursor-nwse-resize",
};

/** 样式小图标：马赛克 / 色块 / 吸管。 */
export function RedactionStyleGlyph({ style }: { style: RedactionStyle }) {
  if (style.kind === "mosaic") return <Grid3x3 aria-hidden className="size-3.5" />;
  if (style.kind === "pick") return <Pipette aria-hidden className="size-3.5" />;
  return (
    <span
      aria-hidden
      className="size-3 rounded-[3px] ring-1 ring-inset ring-foreground/25"
      // token-exception: 遮挡填充色即内容色，与 Native 出图像素一致。
      style={{ backgroundColor: `rgb(${style.color.join(" ")})` }}
    />
  );
}

function centeredKeyboardBox(width: number, height: number): ImagePixelBox {
  const boxWidth = Math.max(1, Math.round(width / 4));
  const boxHeight = Math.max(1, Math.round(height / 4));
  return {
    x: Math.max(0, Math.floor((width - boxWidth) / 2)),
    y: Math.max(0, Math.floor((height - boxHeight) / 2)),
    width: boxWidth,
    height: boxHeight,
  };
}

function boxOf(region: ImagePixelBox): ImagePixelBox {
  return { x: region.x, y: region.y, width: region.width, height: region.height };
}

/** 单个框的成品预览：读原图像素，用与 Rust 相同的算法算出框内像素。 */
function RegionPreview({
  source,
  region,
  style,
}: {
  source: HTMLCanvasElement | null;
  region: RedactionRegion;
  style: React.CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { x, y, width, height } = region;
  const kind = region.style?.kind ?? "solid";
  const color = region.style?.kind === "solid" ? region.style.color.join(",") : "";
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !source) return;
    const src = source.getContext("2d", { willReadFrequently: true });
    if (!src) return;
    const box = { x, y, width, height };
    // 裁切 = 框外扩 1px（取色要外圈），越界夹回图内
    const cx = Math.max(0, x - 1);
    const cy = Math.max(0, y - 1);
    const cw = Math.min(source.width, x + width + 1) - cx;
    const ch = Math.min(source.height, y + height + 1) - cy;
    const crop = src.getImageData(cx, cy, cw, ch);
    const pixels = redactedRegionPixels(
      { data: crop.data, width: cw, height: ch },
      { x: x - cx, y: y - cy, width, height },
      region.style ?? { kind: "solid", color: REDACTION_BLACK },
      box
    );
    canvas.width = width;
    canvas.height = height;
    ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, x, y, width, height, kind, color]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute [image-rendering:pixelated]"
      style={style}
    />
  );
}

export function ManualRedactionCanvas({
  url,
  imageWidth,
  imageHeight,
  regions,
  drawStyle,
  selected,
  candidates = [],
  failed = [],
  disabled = false,
  onSelect,
  onAdd,
  onChange,
  onRemove,
  onAcceptCandidate,
}: {
  url: string;
  imageWidth: number;
  imageHeight: number;
  regions: readonly RedactionRegion[];
  /** 新画框的样式。 */
  drawStyle: RedactionStyle;
  selected: number | null;
  candidates?: readonly RedactionCandidate[];
  /** 复检未通过的框（0 起）。 */
  failed?: readonly number[];
  disabled?: boolean;
  onSelect: (index: number | null) => void;
  onAdd: (region: RedactionRegion) => void;
  onChange: (index: number, region: RedactionRegion) => void;
  onRemove: (index: number) => void;
  onAcceptCandidate: (index: number) => void;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ZoomView>(FIT_VIEW);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [keyboardBox, setKeyboardBox] = useState<ImagePixelBox | null>(null);
  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const baseImageRect = useMemo(
    () => containedImageRect(size.width, size.height, imageWidth, imageHeight),
    [imageHeight, imageWidth, size.height, size.width]
  );
  const imageRect = useMemo(
    () => baseImageRect ? transformedImageRect(baseImageRect, view) : null,
    [baseImageRect, view]
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => setSize({
      width: node.clientWidth,
      height: node.clientHeight,
    });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // 原图像素：url 是同源 data URL，可读像素，预览与 Native 出图同算法
  useEffect(() => {
    let active = true;
    setSource(null);
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d", { willReadFrequently: true })?.drawImage(image, 0, 0);
      setSource(canvas);
    };
    image.src = url;
    return () => { active = false; };
  }, [url]);

  useEffect(() => {
    setView(FIT_VIEW);
    setGesture(null);
    setKeyboardBox(null);
  }, [imageHeight, imageWidth, url]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" || disabled ||
        document.activeElement !== containerRef.current
      ) return;
      event.preventDefault();
      setSpaceHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      setSpaceHeld(false);
    };
    const release = () => setSpaceHeld(false);
    const onVisibilityChange = () => {
      if (document.hidden) release();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [disabled]);

  const pointForEvent = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || !imageRect) return null;
    return imagePointFromClient(
      { x: event.clientX, y: event.clientY },
      container.getBoundingClientRect(),
      imageRect,
      imageWidth,
      imageHeight
    );
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !imageRect) return;
    const container = containerRef.current;
    if (!container) return;
    const target = event.target as HTMLElement;
    // 浮条按钮自己处理点击，不起手势
    if (target.closest("[data-redaction-toolbar]")) return;
    container.focus({ preventScroll: true });
    if ((spaceHeld && event.button === 0) || event.button === 1) {
      if (view.zoom <= 1) return;
      setGesture({
        kind: "pan",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: view.x,
        originY: view.y,
      });
      container.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    setKeyboardBox(null);
    const point = pointForEvent(event);
    if (!point) return;
    const candidate = target.closest<HTMLElement>("[data-candidate]");
    if (candidate) {
      onAcceptCandidate(Number(candidate.dataset.candidate));
      return;
    }
    const handle = target.closest<HTMLElement>("[data-handle]");
    const regionEl = target.closest<HTMLElement>("[data-region]");
    if (handle && selected !== null && regions[selected]) {
      const origin = boxOf(regions[selected]!);
      setGesture({
        kind: "resize",
        pointerId: event.pointerId,
        index: selected,
        handle: handle.dataset.handle as ResizeHandle,
        origin,
        current: origin,
      });
      container.setPointerCapture(event.pointerId);
      return;
    }
    if (regionEl) {
      const index = Number(regionEl.dataset.region);
      const origin = boxOf(regions[index]!);
      onSelect(index);
      setGesture({ kind: "move", pointerId: event.pointerId, index, startImage: point, origin, current: origin });
      container.setPointerCapture(event.pointerId);
      return;
    }
    const bounds = container.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    onSelect(null);
    if (
      localX < imageRect.left || localX > imageRect.left + imageRect.width ||
      localY < imageRect.top || localY > imageRect.top + imageRect.height
    ) return;
    setGesture({
      kind: "draw",
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startImage: point,
      currentImage: point,
    });
    container.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "pan") {
      setView((current) => ({
        ...current,
        x: gesture.originX + event.clientX - gesture.startX,
        y: gesture.originY + event.clientY - gesture.startY,
      }));
      return;
    }
    const point = pointForEvent(event);
    if (!point) return;
    if (gesture.kind === "draw") {
      setGesture({ ...gesture, currentImage: point });
    } else if (gesture.kind === "move") {
      setGesture({
        ...gesture,
        current: moveBox(
          gesture.origin,
          point.x - gesture.startImage.x,
          point.y - gesture.startImage.y,
          imageWidth,
          imageHeight
        ),
      });
    } else {
      setGesture({
        ...gesture,
        current: resizeBox(gesture.origin, gesture.handle, point, imageWidth, imageHeight),
      });
    }
  };

  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !gesture || gesture.pointerId !== event.pointerId) return;
    setGesture(null);
    if (gesture.kind === "draw") {
      const moved = Math.hypot(
        event.clientX - gesture.startClient.x,
        event.clientY - gesture.startClient.y
      );
      const point = pointForEvent(event) ?? gesture.currentImage;
      const box = pixelBoxFromDrag(gesture.startImage, point, imageWidth, imageHeight);
      if (moved >= 6 && box) onAdd({ ...box, style: drawStyle });
      return;
    }
    if (gesture.kind === "move" || gesture.kind === "resize") {
      const { origin, current, index } = gesture;
      const region = regions[index];
      if (
        region &&
        (current.x !== origin.x || current.y !== origin.y ||
          current.width !== origin.width || current.height !== origin.height)
      ) {
        onChange(index, { ...region, ...current });
      }
    }
  };

  /** 渲染用的框列表：正在移动 / 缩放的框显示实时位置。 */
  const shownRegions = regions.map((region, index) =>
    (gesture?.kind === "move" || gesture?.kind === "resize") && gesture.index === index
      ? { ...region, ...gesture.current }
      : region
  );
  const drawing = gesture?.kind === "draw"
    ? pixelBoxFromDrag(gesture.startImage, gesture.currentImage, imageWidth, imageHeight)
    : null;
  const selectedRegion = selected !== null ? shownRegions[selected] ?? null : null;
  const place = (box: ImagePixelBox) =>
    imageRect ? pixelBoxStyle(box, imageRect, imageWidth, imageHeight) : {};

  // 选中框浮条：放框上方，放不下放下方；水平夹在画布内
  const toolbarPos = (() => {
    if (!selectedRegion || !imageRect || gesture) return null;
    const rect = pixelBoxStyle(selectedRegion, imageRect, imageWidth, imageHeight);
    const barWidth = 138;
    const top = rect.top - 34 >= 4 ? rect.top - 34 : rect.top + rect.height + 8;
    const left = Math.min(
      Math.max(4, rect.left + rect.width / 2 - barWidth / 2),
      size.width - barWidth - 4
    );
    return { top, left };
  })();

  return (
    <div
      ref={containerRef}
      role="group"
      tabIndex={0}
      autoFocus
      aria-label={t("手动打码画布，拖动框选要遮挡的区域，点击已有框可移动或调整大小")}
      aria-description={t("键盘可用方向键移动选区或选中的框，按住 Shift 加大步长，Enter 添加遮挡")}
      aria-busy={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={() => setGesture(null)}
      onKeyDown={(event) => {
        if (disabled) return;
        const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
        if (arrows.includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const stepX = Math.max(1, Math.round(imageWidth / 100)) * (event.shiftKey && selected !== null ? 5 : 1);
          const stepY = Math.max(1, Math.round(imageHeight / 100)) * (event.shiftKey && selected !== null ? 5 : 1);
          const dx = event.key === "ArrowLeft" ? -stepX : event.key === "ArrowRight" ? stepX : 0;
          const dy = event.key === "ArrowUp" ? -stepY : event.key === "ArrowDown" ? stepY : 0;
          if (selected !== null && regions[selected]) {
            const region = regions[selected]!;
            onChange(selected, { ...region, ...moveBox(region, dx, dy, imageWidth, imageHeight) });
            return;
          }
          setKeyboardBox((current) => {
            const box = current ?? centeredKeyboardBox(imageWidth, imageHeight);
            if (event.shiftKey) {
              return {
                ...box,
                width: Math.min(imageWidth - box.x, Math.max(1, box.width + dx)),
                height: Math.min(imageHeight - box.y, Math.max(1, box.height + dy)),
              };
            }
            return moveBox(box, dx, dy, imageWidth, imageHeight);
          });
          return;
        }
        if (
          event.key === "Enter" && !event.metaKey && !event.ctrlKey &&
          !event.altKey && selected === null
        ) {
          event.preventDefault();
          event.stopPropagation();
          onAdd({ ...(keyboardBox ?? centeredKeyboardBox(imageWidth, imageHeight)), style: drawStyle });
          setKeyboardBox(null);
        }
      }}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("[data-region], [data-redaction-toolbar]")) return;
        setView(FIT_VIEW);
      }}
      onWheel={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.stopPropagation();
        const node = containerRef.current;
        if (!node) return;
        const bounds = node.getBoundingClientRect();
        const anchor = {
          x: event.clientX - bounds.left - bounds.width / 2,
          y: event.clientY - bounds.top - bounds.height / 2,
        };
        setView((current) => zoomViewAround(
          current,
          Math.max(1, current.zoom * wheelZoomFactor(event.deltaY)),
          anchor
        ));
      }}
      className={cn(
        "relative size-full touch-none select-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        disabled
          ? "cursor-wait"
          : gesture?.kind === "move"
            ? "cursor-grabbing"
            : spaceHeld && view.zoom > 1
              ? "cursor-grab active:cursor-grabbing"
              : "cursor-crosshair"
      )}
    >
      {imageRect && (
        <>
          <img
            src={url}
            alt={t("待编辑图片")}
            draggable={false}
            className="pointer-events-none absolute max-w-none"
            style={imageRect}
          />
          {shownRegions.map((region, index) => (
            <RegionPreview
              key={`preview-${index}`}
              source={source}
              region={region}
              style={place(region)}
            />
          ))}
          {drawing && (
            <RegionPreview source={source} region={{ ...drawing, style: drawStyle }} style={place(drawing)} />
          )}
          {/* 命中层：悬停白描边提示可点；选中蓝描边 + 四角手柄；复检未通过红描边 */}
          {shownRegions.map((region, index) => (
            <span
              key={`hit-${index}`}
              data-region={index}
              aria-hidden
              className={cn(
                "absolute rounded-[1px]",
                disabled ? "pointer-events-none" : "cursor-move",
                selected === index
                  ? "outline outline-[1.5px] outline-offset-1 outline-primary"
                  : failed.includes(index)
                    ? "outline outline-2 outline-offset-1 outline-destructive"
                    : "hover:outline hover:outline-[1.5px] hover:outline-offset-1 hover:outline-white/80"
              )}
              style={place(region)}
            >
              {selected === index && !disabled && HANDLES.map((handle) => (
                <span
                  key={handle}
                  data-handle={handle}
                  className={cn(
                    "absolute size-2 rounded-[2px] border-[1.5px] border-primary bg-background",
                    HANDLE_POSITION[handle]
                  )}
                />
              ))}
            </span>
          ))}
          {candidates.map((candidate, index) => (
            <span
              key={`candidate-${candidate.box.x}-${candidate.box.y}-${index}`}
              data-candidate={index}
              title={t("点击打码：{label}", { label: candidate.label })}
              className={cn(
                "absolute rounded-[1px] border-[1.5px] border-dashed border-warning bg-warning/10",
                disabled ? "pointer-events-none" : "cursor-pointer hover:bg-warning/20"
              )}
              style={place(candidate.box)}
            >
              <span className="absolute -top-4 left-[-1.5px] whitespace-nowrap rounded-t-[3px] rounded-br-[3px] bg-warning px-1 text-micro font-semibold leading-4 text-black">
                {candidate.label}
              </span>
            </span>
          ))}
          {keyboardBox && (
            <span
              aria-hidden
              className="pointer-events-none absolute border-2 border-dashed border-white bg-black/25 shadow-[0_0_0_1px_rgb(0_0_0/0.65)]"
              style={place(keyboardBox)}
            />
          )}
          {toolbarPos && selected !== null && selectedRegion && (
            <div
              data-redaction-toolbar
              role="toolbar"
              aria-label={t("选中遮挡框")}
              className={cn(floatingSurface(2), "absolute z-10 flex items-center gap-0.5 rounded-lg p-0.5")}
              style={toolbarPos}
            >
              {REDACTION_STYLE_OPTIONS.map((option) => {
                const active = sameRedactionStyle(
                  selectedRegion.style ?? { kind: "solid", color: REDACTION_BLACK },
                  option.style
                );
                return (
                  <IconButton
                    key={option.label}
                    label={t("改为{label}", { label: t(option.label) })}
                    pressed={active}
                    onClick={() => onChange(selected, { ...regions[selected]!, style: option.style })}
                  >
                    <RedactionStyleGlyph style={option.style} />
                  </IconButton>
                );
              })}
              <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
              <IconButton label={t("删除这个框（⌫）")} tone="danger" onClick={() => onRemove(selected)}>
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          )}
        </>
      )}
      <span className="sr-only" aria-live="polite">
        {t("已选择 {n} 个打码区域", { n: regions.length })}
        {selected !== null ? t("，选中第 {n} 个", { n: selected + 1 }) : ""}
        {candidates.length ? t("，识别到 {n} 处候选", { n: candidates.length }) : ""}
        {t("，当前缩放 {zoom}%", { zoom: Math.round(view.zoom * 100) })}
      </span>
    </div>
  );
}
