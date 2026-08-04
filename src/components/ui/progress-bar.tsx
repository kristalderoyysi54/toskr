import { cn } from "@/lib/utils";

/**
 * 进度条：凹槽轨 + primary 填充（tactile 时叠 glass-sheen-flat 薄光泽——
 * 与 Switch「光泽件骑在凹槽上」同一母题）。value ∈ [0,100]。
 */
export function ProgressBar({
  value,
  tactile = false,
  className,
}: {
  value: number;
  tactile?: boolean;
  className?: string;
}) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={v}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "surface-inset elevation-1 h-1.5 w-24 overflow-hidden rounded-full",
        className
      )}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-200",
          tactile && "glass-sheen-flat"
        )}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}
