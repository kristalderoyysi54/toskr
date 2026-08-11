import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 独立详情窗共用的完整圆角细框，不参与原生窗口的尺寸与定位。 */
export function DetailWindowFrame({
  children,
  tone = "content",
  surfaceClassName,
}: {
  children: ReactNode;
  tone?: "content" | "lightbox";
  surfaceClassName?: string;
}) {
  return (
    <div
      data-detail-window-frame={tone}
      className="detail-window-frame"
    >
      <div className={cn("detail-window-frame__surface", surfaceClassName)}>
        {children}
      </div>
    </div>
  );
}
