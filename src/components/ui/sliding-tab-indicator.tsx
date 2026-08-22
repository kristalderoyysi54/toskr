import { motion } from "motion/react";

import { springControl } from "@/lib/motion";
import { cn } from "@/lib/utils";

const variantClass = {
  thumb: "inset-0 rounded-md bg-segmented-thumb shadow-(--segmented-thumb-shadow)",
  quiet: "inset-0 rounded-md bg-foreground/8",
  primary: "inset-0 rounded-lg bg-primary",
  underline: "inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground/85",
} as const;

/**
 * Tab / Segmented 的共享选中指示器。指示器单独承担 layout transform，
 * 不会与外层按钮的按压或 dnd-kit transform 争用同一个样式属性。
 */
export function SlidingTabIndicator({
  layoutId,
  variant = "thumb",
  className,
}: {
  layoutId: string;
  variant?: keyof typeof variantClass;
  className?: string;
}) {
  return (
    <motion.span
      aria-hidden
      layoutId={layoutId}
      transition={springControl}
      className={cn("pointer-events-none absolute", variantClass[variant], className)}
    />
  );
}
