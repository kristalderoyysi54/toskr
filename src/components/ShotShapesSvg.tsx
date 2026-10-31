import { memo, useMemo } from "react";

import {
  arrowGeometry,
  box,
  FONT_SIZE,
  LINE_WIDTH,
  mosaicTile,
  NUMBER_RADIUS,
  numberTextColor,
  SPOTLIGHT_DIM,
  TRANSLATE_PAD,
  type Shape,
} from "@/lib/screenshot/annotate";
import type { Rect } from "@/lib/screenshot/geometry";

/**
 * 截图遮罩上的标注显示层（SVG）。原生遮罩窗里整屏 2D canvas 画了不上屏，
 * 屏上显示改走 SVG；出图仍用 `drawShapes` 画 canvas，两边几何同源。
 */
export const ShotShapesSvg = memo(function ShotShapesSvg({
  shapes,
  clip,
  img,
  sx,
  sy,
  viewBox,
}: {
  shapes: Shape[];
  clip: Rect;
  img: HTMLImageElement;
  sx: number;
  sy: number;
  /** 长图标注窗：图形坐标为图片 pt，SVG 按显示尺寸缩放。 */
  viewBox?: string;
}) {
  const spots = shapes.filter((s) => s.kind === "spotlight");
  const mosaics = shapes.filter((s) => s.kind === "mosaic");
  const translations = shapes.flatMap((s) => (s.kind === "translate" ? s.items : []));
  const others = shapes.filter((s) => s.kind !== "mosaic" && s.kind !== "spotlight" && s.kind !== "translate");
  return (
    <svg className="pointer-events-none absolute inset-0 size-full" viewBox={viewBox} preserveAspectRatio="none">
      <defs>
        <clipPath id="shot-sel">
          <rect x={clip.x} y={clip.y} width={clip.w} height={clip.h} />
        </clipPath>
        {/* 聚光灯：白=压暗，黑=挖空；多个区域重叠自然取并集 */}
        <mask id="shot-spot">
          <rect x={clip.x} y={clip.y} width={clip.w} height={clip.h} fill="white" />
          {spots.map((s, i) => {
            if (s.kind !== "spotlight") return null;
            const b = box(s);
            return <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill="black" />;
          })}
        </mask>
      </defs>
      <g clipPath="url(#shot-sel)">
        {spots.length > 0 && (
          <rect x={clip.x} y={clip.y} width={clip.w} height={clip.h} fill={SPOTLIGHT_DIM} mask="url(#shot-spot)" />
        )}
        {mosaics.map((s, i) => (
          <MosaicImage key={`m${i}`} shape={s} img={img} sx={sx} sy={sy} />
        ))}
        {translations.map((it, i) => (
          <g key={`t${i}`}>
            <image
              href={it.patchUrl}
              x={it.x - TRANSLATE_PAD}
              y={it.y - TRANSLATE_PAD}
              width={it.w + TRANSLATE_PAD * 2}
              height={it.h + TRANSLATE_PAD * 2}
              preserveAspectRatio="none"
            />
            <text
              x={it.x}
              y={it.y + it.h / 2}
              fill={it.fg}
              fontSize={it.fontSize}
              fontWeight={500}
              fontFamily='-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
              dominantBaseline="central"
            >
              {it.text}
            </text>
          </g>
        ))}
        {others.map((s, i) => (
          <ShapeEl key={i} s={s} />
        ))}
      </g>
    </svg>
  );
});

function MosaicImage({ shape, img, sx, sy }: { shape: Shape; img: HTMLImageElement; sx: number; sy: number }) {
  const geo = shape.kind === "mosaic" ? shape : null;
  const href = useMemo(
    () => (geo ? (mosaicTile(geo, img, sx, sy)?.toDataURL() ?? "") : ""),
    // 已入历史的图形对象不可变，引用不变就不重新取样
    [geo, img, sx, sy]
  );
  if (!geo || !href) return null;
  const b = box(geo);
  return (
    <image
      href={href}
      x={b.x}
      y={b.y}
      width={b.w}
      height={b.h}
      preserveAspectRatio="none"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

function ShapeEl({ s }: { s: Shape }) {
  if (s.kind === "translate") return null;
  const stroke = { stroke: s.color, strokeWidth: LINE_WIDTH[s.size], fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (s.kind) {
    case "rect": {
      const b = box(s);
      return <rect x={b.x} y={b.y} width={b.w} height={b.h} {...stroke} />;
    }
    case "ellipse": {
      const b = box(s);
      return <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} {...stroke} />;
    }
    case "arrow": {
      const { bx, by, head } = arrowGeometry(s.x1, s.y1, s.x2, s.y2, LINE_WIDTH[s.size]);
      return (
        <g>
          <line x1={s.x1} y1={s.y1} x2={bx} y2={by} {...stroke} />
          <polygon points={head.map((p) => p.join(",")).join(" ")} fill={s.color} />
        </g>
      );
    }
    case "pen":
      return <polyline points={s.points.map((p) => p.join(",")).join(" ")} {...stroke} />;
    case "text": {
      const fs = FONT_SIZE[s.size];
      return (
        <text
          x={s.x}
          y={s.y}
          fill={s.color}
          fontSize={fs}
          fontWeight={600}
          fontFamily='-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
          dominantBaseline="text-before-edge"
        >
          {s.text.split("\n").map((line, i) => (
            <tspan key={i} x={s.x} dy={i ? fs * 1.25 : 0}>
              {line}
            </tspan>
          ))}
        </text>
      );
    }
    case "number": {
      const r = NUMBER_RADIUS[s.size];
      return (
        <g>
          <circle cx={s.x} cy={s.y} r={r} fill={s.color} />
          <text
            x={s.x}
            y={s.y + 0.5}
            fill={numberTextColor(s.color)}
            fontSize={Math.round(r * 1.2)}
            fontWeight={700}
            fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
            textAnchor="middle"
            dominantBaseline="central"
          >
            {s.n}
          </text>
        </g>
      );
    }
    default:
      return null;
  }
}
