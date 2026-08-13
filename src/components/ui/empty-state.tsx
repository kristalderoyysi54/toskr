import { cn } from "@/lib/utils";

/**
 * 统一空态：收编全应用 7 处各写各样的空状态
 * （含裸文字 "空"——一律升格为 icon/标题/提示的完整结构或 inline 轻量行）。
 */
export function EmptyState({
  icon,
  title,
  hint,
  variant = "full",
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  variant?: "full" | "inline";
  className?: string;
}) {
  if (variant === "inline") {
    return (
      <p className={cn("py-2 text-center text-label text-muted-foreground", className)}>
        {title}
      </p>
    );
  }
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-6 pb-10 pt-16 text-center",
        className
      )}
    >
      {/* 图标属纯装饰，保留 alpha 弱化；文字一律实色（13px 以下禁 alpha 灰，对比度批次） */}
      {icon && (
        <span className="text-muted-foreground/50 [&_svg]:size-6">{icon}</span>
      )}
      <p className="text-title font-medium text-muted-foreground">{title}</p>
      {hint && (
        <p className="text-label leading-normal text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
