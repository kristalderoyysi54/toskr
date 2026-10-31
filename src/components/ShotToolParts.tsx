import { useEffect, useState } from "react";
import { Circle, Focus, Grid3x3, Hash, MoveUpRight, Pencil, Square, Type, type LucideIcon } from "lucide-react";

import { useT, type MessageKey } from "@/lib/i18n";
import { COLORS, SIZES, type SizeLevel, type Tool } from "@/lib/screenshot/annotate";
import { cn } from "@/lib/utils";

/** 截图遮罩与长图标注窗共用的标注工具。 */
export const SHOT_TOOLS: { tool: Tool; icon: LucideIcon; label: MessageKey }[] = [
  { tool: "rect", icon: Square, label: "矩形" },
  { tool: "ellipse", icon: Circle, label: "椭圆" },
  { tool: "arrow", icon: MoveUpRight, label: "箭头" },
  { tool: "pen", icon: Pencil, label: "画笔" },
  { tool: "text", icon: Type, label: "文字" },
  { tool: "mosaic", icon: Grid3x3, label: "马赛克" },
  { tool: "spotlight", icon: Focus, label: "聚光灯" },
  { tool: "number", icon: Hash, label: "序号" },
];

/** 马赛克、聚光灯不需要颜色与粗细。 */
export function toolHasStyle(tool: Tool | null): boolean {
  return !!tool && tool !== "mosaic" && tool !== "spotlight";
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

/** 粗细三档 + 6 色。 */
export function ShotStyleRow({
  ink,
  setInk,
  size,
  setSize,
}: ReturnType<typeof useShotStyle>) {
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
  );
}
