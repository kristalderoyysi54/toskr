import { cn } from "@/lib/utils";

/**
 * 分段控件（单选组）：从 SettingsView 内部提升为共享原语，
 * 统一 4 处复制粘贴实现（设置页 Segmented / 主面板 PageTab / 任务行状态·优先级 picker）。
 * 语义：radiogroup/radio + aria-checked；焦点环与按压反馈内建。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "sm",
  ariaLabel,
  className,
}: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: "sm" | "xs";
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("flex gap-1", className)}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-md border outline-none transition-[color,background-color,transform] duration-100",
              "focus-visible:ring-2 focus-visible:ring-primary/50 active:scale-[0.97]",
              size === "sm" ? "px-2 py-1 text-label" : "px-1.5 py-0.5 text-micro",
              active
                ? "border-border bg-primary/10 font-medium dark:border-input"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
