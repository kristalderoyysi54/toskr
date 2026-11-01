import { forwardRef, useEffect, useMemo, useState, type ComponentProps } from "react";
import {
  Blend,
  Circle,
  Focus,
  Grid3x3,
  Hash,
  Layers2,
  MessageSquareText,
  MoveUpRight,
  Pencil,
  Square,
  Slash,
  SquareRoundCorner,
  Type,
  type LucideIcon,
} from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { useT, type MessageKey } from "@/lib/i18n";
import { COLORS, SIZES, type SizeLevel, type Tool } from "@/lib/screenshot/annotate";
import {
  MAX_RADIUS,
  MAX_SHADOW,
  SHADOW_ALPHA_DEFAULT,
  SHADOW_ALPHA_MAX,
  SHADOW_ALPHA_MIN,
} from "@/lib/screenshot/frame";
import { cn } from "@/lib/utils";

/** 截图遮罩与长图标注窗共用的标注工具；tip 为悬停说明。 */
export const SHOT_TOOLS: { tool: Tool; icon: LucideIcon; label: MessageKey; tip: MessageKey }[] = [
  { tool: "line", icon: Slash, label: "直线", tip: "直线：拖动画直线，按住 ⇧ 吸附水平 / 垂直 / 45°" },
  { tool: "rect", icon: Square, label: "矩形", tip: "矩形：拖动框出重点区域" },
  { tool: "ellipse", icon: Circle, label: "椭圆", tip: "椭圆：拖动圈出重点" },
  { tool: "arrow", icon: MoveUpRight, label: "箭头", tip: "箭头：从起点拖到要指向的位置" },
  { tool: "pen", icon: Pencil, label: "画笔", tip: "画笔：按住随手画" },
  { tool: "text", icon: Type, label: "文字", tip: "文字：点击位置输入，Enter 完成、Shift+Enter 换行" },
  { tool: "mosaic", icon: Grid3x3, label: "马赛克", tip: "马赛克：拖动框住要遮挡的隐私内容" },
  { tool: "spotlight", icon: Focus, label: "聚光灯", tip: "聚光灯：框出的区域保持原样，其余压暗" },
  { tool: "number", icon: Hash, label: "序号", tip: "序号：点击依次放置 1、2、3… 编号" },
  {
    tool: "callout",
    icon: MessageSquareText,
    label: "批注",
    tip: "批注：框出要改的地方并写下说明，自动编号；存入或发送时编号说明随图附上，方便交给 AI",
  },
];

/** 带悬停说明的工具条按钮：说明由 <HoverTip> 显示（不用原生 title，遮罩窗未激活时原生提示不出现）。 */
export const TipButton = forwardRef<HTMLButtonElement, ComponentProps<typeof IconButton> & { tip?: string }>(
  function TipButton({ tip, ...props }, ref) {
    return <IconButton ref={ref} withTitle={false} data-tip={tip ?? props.label} {...props} />;
  }
);

const TIP_DELAY_MS = 400;
const TIP_HALF_W = 120;

/**
 * 工具条悬停提示：找指针下最近的 [data-tip] 元素，停留片刻后在其下方（贴底时上方）显示说明。
 * 截图遮罩窗未激活时收不到 mousemove，由调用方传入轮询得到的光标位置；不传则自己监听指针。
 */
export function HoverTip({ point }: { point?: { x: number; y: number } | null }) {
  const external = point !== undefined;
  const [own, setOwn] = useState<{ x: number; y: number } | null>(null);
  const [shown, setShown] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (external) return;
    const move = (e: PointerEvent) => setOwn({ x: e.clientX, y: e.clientY });
    const leave = () => setOwn(null);
    window.addEventListener("pointermove", move);
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, [external]);
  const p = external ? point : own;
  const target = useMemo(
    () => (p ? (document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>("[data-tip]") ?? null) : null),
    [p]
  );
  useEffect(() => {
    if (!target) return;
    const id = window.setTimeout(() => setShown(target), TIP_DELAY_MS);
    // 点了按钮就收起，直到移到别的按钮
    const hide = () => {
      window.clearTimeout(id);
      setShown(null);
    };
    window.addEventListener("pointerdown", hide, { capture: true });
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", hide, { capture: true });
      setShown(null);
    };
  }, [target]);
  if (!shown || shown !== target || !shown.isConnected) return null;
  const r = shown.getBoundingClientRect();
  const below = r.bottom + 48 < window.innerHeight;
  const cx = Math.min(Math.max(r.left + r.width / 2, TIP_HALF_W + 4), window.innerWidth - TIP_HALF_W - 4);
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 w-max max-w-60 -translate-x-1/2 rounded-md bg-black/75 px-2 py-1 text-label text-white shadow-md"
      style={below ? { left: cx, top: r.bottom + 6 } : { left: cx, bottom: window.innerHeight - r.top + 6 }}
    >
      {shown.dataset.tip}
    </div>
  );
}

/** 聚光灯没有样式；马赛克只有粗细（颗粒大小），没有颜色。 */
export function toolHasStyle(tool: Tool | null): boolean {
  return !!tool && tool !== "spotlight";
}

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

export function useShotStyle() {
  const [ink, setInk] = useState(() => loadStyle().ink);
  const [size, setSize] = useState<SizeLevel>(() => loadStyle().size);
  useEffect(() => {
    localStorage.setItem(STYLE_KEY, JSON.stringify({ ink, size }));
  }, [ink, size]);
  return { ink, setInk, size, setSize };
}

/** 出图圆角（pt）与阴影开关（每台机器的使用习惯，存 localStorage）。 */
const FRAME_KEY = "toskr.screenshotFrame";

export interface ShotFrame {
  /** 圆角（pt） */
  radius: number;
  /** 阴影大小（pt），0 = 无 */
  shadow: number;
  /** 阴影浓淡（不透明度 %） */
  shadowAlpha: number;
}

function loadFrame(): ShotFrame {
  try {
    const v = JSON.parse(localStorage.getItem(FRAME_KEY) ?? "{}") as {
      radius?: unknown;
      shadow?: unknown;
      shadowAlpha?: unknown;
    };
    const num = (x: unknown, max: number) => (typeof x === "number" && x >= 0 ? Math.min(x, max) : 0);
    const alpha =
      typeof v.shadowAlpha === "number"
        ? Math.min(SHADOW_ALPHA_MAX, Math.max(SHADOW_ALPHA_MIN, v.shadowAlpha))
        : SHADOW_ALPHA_DEFAULT;
    // 旧版阴影是开关：true 折算为 24
    return { radius: num(v.radius, MAX_RADIUS), shadow: v.shadow === true ? 24 : num(v.shadow, MAX_SHADOW), shadowAlpha: alpha };
  } catch {
    return { radius: 0, shadow: 0, shadowAlpha: SHADOW_ALPHA_DEFAULT };
  }
}

/** 出图圆角 / 阴影：记在本机，下次截图沿用；截图遮罩与标注窗之间实时同步。 */
export function useShotFrame() {
  const [frame, setFrame] = useState<ShotFrame>(loadFrame);
  useEffect(() => {
    localStorage.setItem(FRAME_KEY, JSON.stringify(frame));
  }, [frame]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== FRAME_KEY) return;
      const next = loadFrame();
      setFrame((f) =>
        f.radius === next.radius && f.shadow === next.shadow && f.shadowAlpha === next.shadowAlpha ? f : next
      );
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return [frame, setFrame] as const;
}

/** 出图圆角与阴影滑块（截图遮罩与长图 / 钉图标注窗共用）。 */
export function ShotFrameControls({
  frame,
  setFrame,
}: {
  frame: ShotFrame;
  setFrame: (update: (f: ShotFrame) => ShotFrame) => void;
}) {
  const t = useT();
  const slider = (
    key: keyof ShotFrame,
    icon: LucideIcon,
    label: MessageKey,
    tip: MessageKey,
    max: number,
    min = 0,
    step = 2
  ) => {
    const Icon = icon;
    return (
      <span className="flex items-center gap-1" data-tip={t(tip)}>
        <Icon className="size-3.5 text-muted-foreground" />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={frame[key]}
          aria-label={t(label)}
          onChange={(e) => {
            const v = Number(e.target.value);
            setFrame((f) => ({ ...f, [key]: v }));
          }}
          className="w-20 accent-primary"
        />
        <span className="w-6 font-mono text-label tabular-nums">{frame[key]}</span>
      </span>
    );
  };
  return (
    <>
      {slider("radius", SquareRoundCorner, "圆角", "圆角：出图四角裁成圆角（外侧透明）", MAX_RADIUS)}
      {slider("shadow", Layers2, "阴影", "阴影：出图四周加投影，数值为阴影大小（0 = 无）", MAX_SHADOW)}
      {frame.shadow > 0 &&
        slider("shadowAlpha", Blend, "阴影浓淡", "阴影浓淡：投影的深浅（%）", SHADOW_ALPHA_MAX, SHADOW_ALPHA_MIN, 5)}
    </>
  );
}

/** 粗细三档 + 6 色（马赛克只显示粗细，即颗粒大小）。 */
export function ShotStyleRow({
  ink,
  setInk,
  size,
  setSize,
  colors = true,
}: {
  ink: string;
  setInk: (c: string) => void;
  size: SizeLevel;
  setSize: (lv: SizeLevel) => void;
  colors?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 px-1">
      {SIZES.map((lv) => (
        <button
          key={lv}
          type="button"
          aria-label={t("粗细 {n}", { n: lv + 1 })}
          aria-pressed={size === lv}
          onClick={() => setSize(lv)}
          className={cn("flex size-5 items-center justify-center rounded-sm", size === lv && "bg-accent")}
        >
          <span className="rounded-full bg-foreground" style={{ width: 4 + lv * 3, height: 4 + lv * 3 }} />
        </button>
      ))}
      {colors && <span className="h-4 w-px bg-border" />}
      {colors &&
        COLORS.map((c) => (
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
  );
}
