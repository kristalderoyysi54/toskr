import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { ContextMenuItem } from "@/components/ui/context-menu";
import {
  closeMenuFlyoutIfOwner,
  isMenuFlyoutOpen,
  openMenuFlyout,
  setMenuFlyoutTriggerHovered,
  type MenuFlyoutSource,
} from "@/lib/menuFlyout";
import { cn } from "@/lib/utils";

/** 悬停/→ 展开前的停留时间（ms），与原生子菜单同量级。 */
const HOVER_OPEN_MS = 110;

/**
 * 主菜单里的「› 子菜单」行：悬停或 →/回车展开独立小窗（menuflyout），
 * 子项在小窗里点选后回传主窗口执行。`getSource` 在展开时才序列化，避免每次渲染都遍历菜单。
 */
export function MenuFlyoutTrigger({
  label,
  icon,
  width = 208,
  getSource,
}: {
  label: string;
  icon: ReactNode;
  width?: number;
  getSource: () => MenuFlyoutSource;
}) {
  // React 18 下 ContextMenuItem 不转发 ref：锚点元素从事件的 currentTarget 取
  const anchorRef = useRef<HTMLElement | null>(null);
  const ownerRef = useRef({});
  const openTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);

  const clearOpenTimer = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };
  const openNow = (keyboard: boolean) => {
    clearOpenTimer();
    const anchorEl = anchorRef.current;
    if (!anchorEl) return;
    setOpen(true);
    void openMenuFlyout({
      owner: ownerRef.current,
      anchorEl,
      width,
      source: getSource(),
      keyboard,
      onClose: () => setOpen(false),
    });
  };
  // 卸载（主菜单关闭）时只收自己打开的小窗；被另一触发行接管时由管理器回调 onClose
  useEffect(() => () => {
    clearOpenTimer();
    closeMenuFlyoutIfOwner(ownerRef.current);
  }, []);

  return (
    <ContextMenuItem
      data-state={open ? "open" : "closed"}
      className={cn(open && "bg-accent text-accent-foreground")}
      onSelect={(event) => {
        // 点击/回车：展开而不是关闭主菜单
        event.preventDefault();
        if (event.currentTarget instanceof HTMLElement) anchorRef.current = event.currentTarget;
        if (!isMenuFlyoutOpen() || !open) openNow(true);
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        anchorRef.current = event.currentTarget;
        setMenuFlyoutTriggerHovered(true);
        if (open) return;
        clearOpenTimer();
        openTimer.current = window.setTimeout(() => openNow(false), HOVER_OPEN_MS);
      }}
      onPointerLeave={() => {
        clearOpenTimer();
        setMenuFlyoutTriggerHovered(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        anchorRef.current = event.currentTarget;
        openNow(true);
      }}
    >
      {icon} {label}
      <ChevronRight className="ml-auto size-3.5" />
    </ContextMenuItem>
  );
}
