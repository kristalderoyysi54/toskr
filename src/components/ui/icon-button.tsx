import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * 统一图标按钮：收编全应用手写的 ghost 图标钮（App 头部、卡片/任务行悬浮操作、
 * 设置页列表管理等）。内建四态 + 键盘可达性：
 * - 显式 tabIndex=0：WebKit 在系统「全键盘访问」关闭时默认跳过 button，
 *   显式设置是 Tab 可达的承重修复，非装饰
 * - reveal="hover-focus"：用 opacity 方案替代 display:none（display:none 键盘永远够不到）；
 *   依赖父级带 `group` 类
 * - after 伪元素扩热区（沿用 checkbox/switch 的既有技法）
 */
const iconButtonVariants = cva(
  cn(
    "relative inline-flex shrink-0 items-center justify-center outline-none select-none",
    "transition-[color,background-color,transform,opacity] duration-100",
    "after:absolute after:-inset-x-1.5 after:-inset-y-1",
    "focus-visible:ring-2 focus-visible:ring-primary/50",
    "active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0"
  ),
  {
    variants: {
      size: {
        sm: "rounded-md p-1 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "rounded-md p-1 [&_svg:not([class*='size-'])]:size-3",
        "2xs": "rounded-sm p-0.5 [&_svg:not([class*='size-'])]:size-3",
      },
      tone: {
        default:
          "text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10",
        danger:
          "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
      },
      reveal: {
        always: "",
        hover: "opacity-0 group-hover:opacity-100",
        "hover-focus":
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
      },
      surface: {
        true: "border border-foreground/10 bg-surface-raised/95 elevation-2",
        false: "",
      },
      pressedLook: {
        true: "bg-black/5 text-foreground dark:bg-white/10",
        false: "",
      },
    },
    defaultVariants: {
      size: "sm",
      tone: "default",
      reveal: "always",
      surface: false,
      pressedLook: false,
    },
  }
);

type IconButtonProps = Omit<React.ComponentProps<"button">, "children"> &
  Omit<VariantProps<typeof iconButtonVariants>, "pressedLook"> & {
    /** 无障碍名 + 原生 title 提示（chrome 级消费者外包 Radix Tooltip 时传 withTitle=false 防双提示） */
    label: string;
    withTitle?: boolean;
    /** 开关型按钮的按下态：同时驱动 aria-pressed 与视觉 */
    pressed?: boolean;
    /** 行内使用时阻断冒泡（避免触发卡片/行自身的 onClick），工具栏场景可关 */
    stopPropagation?: boolean;
    children: React.ReactNode;
  };

export function IconButton({
  label,
  withTitle = true,
  pressed,
  stopPropagation = true,
  size,
  tone,
  reveal,
  surface,
  className,
  onClick,
  children,
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      tabIndex={0}
      aria-label={label}
      title={withTitle ? label : undefined}
      aria-pressed={pressed}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        onClick?.(e);
      }}
      className={cn(
        iconButtonVariants({ size, tone, reveal, surface, pressedLook: pressed === true }),
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
