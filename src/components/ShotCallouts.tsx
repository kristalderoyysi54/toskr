import { useEffect, useRef } from "react";

import { floatingSurface } from "@/components/ui/floating-surface";
import { useT } from "@/lib/i18n";
import { box, calloutNumbers, calloutTag, numberTextColor, type NoteDraft, type Shape } from "@/lib/screenshot/annotate";
import { cn } from "@/lib/utils";

/**
 * 批注说明层：已填写的说明以浅色标签贴在编号贴片右侧（只在编辑时显示，不画进出图），
 * 正在填写时在框下方显示输入框（Enter / Esc 完成）。z 为 pt → 屏上像素比。
 */
export function ShotCallouts({
  shapes,
  draft,
  z = 1,
  onChange,
  onCommit,
}: {
  shapes: Shape[];
  draft: NoteDraft | null;
  z?: number;
  onChange: (text: string) => void;
  onCommit: () => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  // WKWebView 下 autoFocus 不可靠：输入框出现后显式聚焦
  const draftKey = draft ? `${draft.shape.x1},${draft.shape.y1}` : null;
  useEffect(() => {
    if (draftKey) inputRef.current?.focus();
  }, [draftKey]);
  const numbers = calloutNumbers(shapes);
  const editingShape = draft ? (draft.orig ?? null) : null;
  return (
    <>
      {[...numbers].map(([s, n]) => {
        if (s.kind !== "callout" || !s.note.trim() || s === editingShape || (draft && !draft.orig && s === shapes.at(-1))) {
          return null;
        }
        const tag = calloutTag(s, n);
        return (
          <div
            key={n}
            className={cn(floatingSurface(), "pointer-events-none absolute flex max-w-60 items-center rounded-r-md px-1.5 text-label")}
            style={{ left: (tag.x + tag.w) * z, top: tag.y * z, height: tag.h * z }}
          >
            <span className="truncate">{s.note}</span>
          </div>
        );
      })}
      {draft &&
        (() => {
          const b = box(draft.shape);
          const n = numbers.get(shapes.find((s) => s.kind === "callout" && s.x1 === draft.shape.x1 && s.y1 === draft.shape.y1) ?? draft.shape) ?? numbers.size;
          return (
            <div
              className={cn(floatingSurface(), "absolute flex w-64 items-center gap-2 rounded-md p-1 pr-2")}
              style={{ left: b.x * z, top: (b.y + b.h) * z + 6 }}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <span
                // 编号块与卡片同一圆角
                className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1 text-label font-bold"
                style={{ background: draft.shape.color, color: numberTextColor(draft.shape.color) }}
              >
                {n}
              </span>
              <input
                ref={inputRef}
                value={draft.text}
                placeholder={t("这里要怎么改？")}
                aria-label={t("批注说明")}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" || e.key === "Escape") {
                    e.preventDefault();
                    onCommit();
                  }
                }}
                className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          );
        })()}
    </>
  );
}
