import { useEffect, useMemo, useRef, useState } from "react";

import {
  containedImageRect,
  imagePointFromClient,
  pixelBoxFromDrag,
  pixelBoxStyle,
  transformedImageRect,
} from "@/lib/imageEditor";
import {
  FIT_VIEW,
  wheelZoomFactor,
  zoomViewAround,
  type ZoomView,
} from "@/lib/imageZoom";
import type { ImagePixelBox } from "@/lib/tauri";

type DragState = {
  pointerId: number;
  startClient: { x: number; y: number };
  startImage: { x: number; y: number };
  currentImage: { x: number; y: number };
};

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

export function ManualRedactionCanvas({
  url,
  imageWidth,
  imageHeight,
  regions,
  disabled = false,
  onAdd,
}: {
  url: string;
  imageWidth: number;
  imageHeight: number;
  regions: readonly ImagePixelBox[];
  disabled?: boolean;
  onAdd: (region: ImagePixelBox) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ZoomView>(FIT_VIEW);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [keyboardBox, setKeyboardBox] = useState<ImagePixelBox | null>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
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

  useEffect(() => {
    setView(FIT_VIEW);
    setDrag(null);
    setKeyboardBox(null);
    panRef.current = null;
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
      panRef.current = null;
    };
    const releasePanModifier = () => {
      setSpaceHeld(false);
      panRef.current = null;
    };
    const onVisibilityChange = () => {
      if (document.hidden) releasePanModifier();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releasePanModifier);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releasePanModifier);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [disabled]);

  const pointForEvent = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || !imageRect) return null;
    const rect = container.getBoundingClientRect();
    return imagePointFromClient(
      { x: event.clientX, y: event.clientY },
      rect,
      imageRect,
      imageWidth,
      imageHeight
    );
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !imageRect) return;
    const container = containerRef.current;
    if (!container) return;
    container.focus({ preventScroll: true });
    if ((spaceHeld && event.button === 0) || event.button === 1) {
      if (view.zoom <= 1) return;
      panRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: view.x,
        originY: view.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    setKeyboardBox(null);
    const bounds = container.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    if (
      localX < imageRect.left || localX > imageRect.left + imageRect.width ||
      localY < imageRect.top || localY > imageRect.top + imageRect.height
    ) return;
    const point = pointForEvent(event);
    if (!point) return;
    setDrag({
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startImage: point,
      currentImage: point,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const pan = panRef.current;
    if (pan?.pointerId === event.pointerId) {
      setView((current) => ({
        ...current,
        x: pan.originX + event.clientX - pan.startX,
        y: pan.originY + event.clientY - pan.startY,
      }));
      return;
    }
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = pointForEvent(event);
    if (point) setDrag((current) => current ? { ...current, currentImage: point } : null);
  };

  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null;
      return;
    }
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = Math.hypot(
      event.clientX - drag.startClient.x,
      event.clientY - drag.startClient.y
    );
    const point = pointForEvent(event) ?? drag.currentImage;
    const region = pixelBoxFromDrag(
      drag.startImage,
      point,
      imageWidth,
      imageHeight
    );
    setDrag(null);
    if (moved >= 6 && region) onAdd(region);
  };

  const activeRegion = drag
    ? pixelBoxFromDrag(drag.startImage, drag.currentImage, imageWidth, imageHeight)
    : null;

  return (
    <div
      ref={containerRef}
      role="group"
      tabIndex={0}
      autoFocus
      aria-label="手动打码画布，拖动框选要遮挡的区域"
      aria-description="键盘可用方向键移动选区，按住 Shift 加方向键调整大小，Enter 添加遮挡"
      aria-busy={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={() => {
        setDrag(null);
        panRef.current = null;
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
        if (arrows.includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const stepX = Math.max(1, Math.round(imageWidth / 100));
          const stepY = Math.max(1, Math.round(imageHeight / 100));
          setKeyboardBox((current) => {
            const box = current ?? centeredKeyboardBox(imageWidth, imageHeight);
            if (event.shiftKey) {
              if (event.key === "ArrowLeft") {
                return { ...box, width: Math.max(1, box.width - stepX) };
              }
              if (event.key === "ArrowRight") {
                return {
                  ...box,
                  width: Math.min(imageWidth - box.x, box.width + stepX),
                };
              }
              if (event.key === "ArrowUp") {
                return { ...box, height: Math.max(1, box.height - stepY) };
              }
              return {
                ...box,
                height: Math.min(imageHeight - box.y, box.height + stepY),
              };
            }
            if (event.key === "ArrowLeft") {
              return { ...box, x: Math.max(0, box.x - stepX) };
            }
            if (event.key === "ArrowRight") {
              return {
                ...box,
                x: Math.min(imageWidth - box.width, box.x + stepX),
              };
            }
            if (event.key === "ArrowUp") {
              return { ...box, y: Math.max(0, box.y - stepY) };
            }
            return {
              ...box,
              y: Math.min(imageHeight - box.height, box.y + stepY),
            };
          });
          return;
        }
        if (
          event.key === "Enter" && !event.metaKey && !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          onAdd(keyboardBox ?? centeredKeyboardBox(imageWidth, imageHeight));
          setKeyboardBox(null);
        }
      }}
      onDoubleClick={() => setView(FIT_VIEW)}
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
      className={
        "relative size-full touch-none select-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring " +
        (disabled
          ? "cursor-wait"
          : spaceHeld && view.zoom > 1
            ? "cursor-grab active:cursor-grabbing"
            : "cursor-crosshair")
      }
    >
      {imageRect && (
        <>
          <img
            src={url}
            alt="待编辑图片"
            draggable={false}
            className="pointer-events-none absolute max-w-none"
            style={imageRect}
          />
          {[...regions, ...(activeRegion ? [activeRegion] : [])].map(
            (region, index) => (
              <span
                key={`${region.x}-${region.y}-${region.width}-${region.height}-${index}`}
                aria-hidden
                className="pointer-events-none absolute ring-1 ring-white/60"
                // token-exception: 与 Native 固定不透明遮挡像素色完全一致。
                style={{
                  ...pixelBoxStyle(region, imageRect, imageWidth, imageHeight),
                  backgroundColor: "rgb(20 20 22)",
                }}
              />
            )
          )}
          {keyboardBox && (
            <span
              aria-hidden
              className="pointer-events-none absolute border-2 border-dashed border-white bg-black/25 shadow-[0_0_0_1px_rgb(0_0_0/0.65)]"
              style={pixelBoxStyle(
                keyboardBox,
                imageRect,
                imageWidth,
                imageHeight
              )}
            />
          )}
        </>
      )}
      <span className="sr-only" aria-live="polite">
        已选择 {regions.length} 个打码区域，当前缩放 {Math.round(view.zoom * 100)}%
        {keyboardBox
          ? `，键盘选区 ${keyboardBox.x}, ${keyboardBox.y}, ${keyboardBox.width} × ${keyboardBox.height}`
          : ""}
      </span>
    </div>
  );
}
