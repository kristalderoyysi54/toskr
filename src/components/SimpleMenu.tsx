import { useEffect, useRef, useState } from "react";

import { floatingSurface } from "@/components/ui/floating-surface";
import { cn } from "@/lib/utils";

/**
 * 轻量自绘菜单：不用 Radix Portal / 焦点锁。
 * 无边框置顶透明窗口里 Radix 的 Portal + 焦点模型会吞掉菜单项点击，
 * 这里用普通 DOM 层级 + 绝对定位，和面板里其他按钮同一套事件路径，稳定可点。
 */
export function SimpleMenu({
  trigger,
  children,
  align = "end",
  side = "bottom",
  menuClassName,
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
  menuClassName?: string;
  /** 根容器附加类。默认 block 会让触发按钮参与基线对齐产生亚像素错位，
   *  与相邻按钮拼「分裂按钮」时传 "flex" 消除。 */
  className?: string;
}) {
  const [open, setOpenRaw] = useState(false);
  // 出场动画期间保持挂载（同 DuePopover 的 lingering 先例）：
  // data-state 翻 closed → tw-animate 播出场 → 120ms 后真正卸载
  const [rendered, setRendered] = useState(false);
  const setOpen = (v: boolean) => {
    setOpenRaw(v);
    if (v) setRendered(true);
    else window.setTimeout(() => setRendered(false), 120);
  };
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {trigger({ open, toggle: () => setOpen(!open) })}
      {rendered && (
        <div
          data-state={open ? "open" : "closed"}
          className={cn(
            "absolute z-50 min-w-40 rounded-lg p-1",
            floatingSurface(2),
            // 与 Radix 菜单同一套 tw-animate 进出场（duration-100 对齐）
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            "duration-100",
            side === "bottom" ? "top-full mt-1 origin-top" : "bottom-full mb-1 origin-bottom",
            align === "end" ? "right-0" : "left-0",
            menuClassName
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** 菜单项。 */
export function SimpleMenuItem({
  onClick,
  children,
  title,
  disabled,
  destructive,
}: {
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body outline-none",
        "hover:bg-black/5 focus-visible:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10 dark:focus-visible:bg-white/10",
        destructive && "text-destructive"
      )}
    >
      {children}
    </button>
  );
}

/** 菜单分组标题。 */
export function SimpleMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 py-1 text-micro font-medium text-muted-foreground">{children}</p>
  );
}

/** 分隔线。 */
export function SimpleMenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}
