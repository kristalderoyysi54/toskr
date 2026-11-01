import { useEffect, useRef } from "react";

import { useT } from "@/lib/i18n";
import { box, calloutNumbers, NUMBER_RADIUS, type NoteDraft, type Shape } from "@/lib/screenshot/annotate";

/**
 * 批注说明层：已填写的说明以小标签显示在编号旁（只在编辑时显示，不画进出图），
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
        const b = box(s);
        const r = NUMBER_RADIUS[s.size];
        return (
          <div
            key={n}
            className="pointer-events-none absolute max-w-60 truncate rounded-md bg-black/70 px-1.5 py-0.5 text-label text-white"
            style={{ left: (b.x + r + 4) * z, top: (b.y - r) * z }}
          >
            {s.note}
          </div>
        );
      })}
      {draft &&
        (() => {
          const b = box(draft.shape);
          const n = numbers.get(shapes.find((s) => s.kind === "callout" && s.x1 === draft.shape.x1 && s.y1 === draft.shape.y1) ?? draft.shape) ?? numbers.size;
          return (
            <div
              className="absolute flex w-64 items-center gap-1.5 rounded-full bg-black/75 py-1 pl-1 pr-3 shadow-md"
              style={{ left: b.x * z, top: (b.y + b.h) * z + 6 }}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-label font-bold"
                style={{ background: draft.shape.color }}
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
                className="min-w-0 flex-1 bg-transparent text-body text-white outline-none placeholder:text-white/50"
              />
            </div>
          );
        })()}
    </>
  );
}
