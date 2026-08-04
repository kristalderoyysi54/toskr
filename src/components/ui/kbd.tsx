import { cn } from "@/lib/utils";

/**
 * 键帽 chip：统一全应用 6 处手写 <kbd>。
 * default = 带边框的键帽；inline = 按钮标签里的裸字提示（如「发送 ⌘⏎」）。
 */
export function Kbd({
  children,
  inline = false,
  className,
}: {
  children: React.ReactNode;
  inline?: boolean;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "font-sans text-micro tabular-nums",
        inline
          ? "opacity-70"
          : "inline-flex min-w-4 items-center justify-center rounded-sm border border-foreground/10 bg-foreground/5 px-1 text-muted-foreground",
        className
      )}
    >
      {children}
    </kbd>
  );
}
