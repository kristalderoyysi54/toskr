import type { ReactNode } from "react";

import { ContextMenuItem } from "@/components/ui/context-menu";

export type CardMenuPage = "main" | "send" | "more" | "other-templates";

/** 切换同一菜单的内容，不触发 Radix 的选中后关闭。 */
export function CardMenuPageItem({ page, back = page === "main", onNavigate, children }: {
  page: CardMenuPage;
  back?: boolean;
  onNavigate: (page: CardMenuPage) => void;
  children: ReactNode;
}) {
  return (
    <ContextMenuItem
      onSelect={(event) => {
        event.preventDefault();
        onNavigate(page);
      }}
      onKeyDown={(event) => {
        if (event.key !== (back ? "ArrowLeft" : "ArrowRight")) return;
        event.preventDefault();
        event.stopPropagation();
        onNavigate(page);
      }}
    >
      {children}
    </ContextMenuItem>
  );
}
