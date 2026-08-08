import { useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

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
  // 出场动画期间保持挂载：data-state 翻 closed → tw-animate 播出场，
  // animationend 当帧卸载；计时器只兜底系统禁动画等极端环境。
  const [rendered, setRendered] = useState(false);
  // 出场卸载计时器必须可取消：关闭后短时间内再开时，若旧计时器仍在飞行，
  // 会把「已经重新打开」的菜单直接卸载——open=true 却无渲染，状态与画面
  // 脱节（外点监听还挂着），表现为「点图标闪一下菜单就没了」。
  const lingerTimer = useRef(0);
  const setOpen = (v: boolean) => {
    setOpenRaw(v);
    window.clearTimeout(lingerTimer.current);
    if (v) setRendered(true);
    else lingerTimer.current = window.setTimeout(() => setRendered(false), 160);
  };
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      window.clearTimeout(lingerTimer.current);
    },
    []
  );

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
    // 窗口失焦即关：切到别的应用时本窗口收不到 pointerdown，菜单会一直
    // 挂着（面板默认常显示后尤其明显——回来还停在旧菜单上）。用 Tauri 的
    // 窗口焦点事件而非 DOM blur：WKWebView 里 document 常常压根没拿到过
    // 焦点（点 button 不给焦点是本项目既有的坑），DOM blur 不可靠。
    const unlistenFocus = getCurrentWebviewWindow().onFocusChanged(
      ({ payload: focused }) => {
        if (!focused) setOpen(false);
      }
    );
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      void unlistenFocus.then((fn) => fn()).catch(() => {});
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {trigger({ open, toggle: () => setOpen(!open) })}
      {rendered && (
        <div
          data-state={open ? "open" : "closed"}
          // 兜底计时器触发前也停在透明末帧，杜绝动画结束后闪回 opacity:1。
          style={!open ? { animationFillMode: "forwards" } : undefined}
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget || open) return;
            window.clearTimeout(lingerTimer.current);
            setRendered(false);
          }}
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
