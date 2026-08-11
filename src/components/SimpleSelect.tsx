import { ChevronDown } from "lucide-react";

import { SimpleMenu, SimpleMenuItem, SimpleMenuLabel } from "@/components/SimpleMenu";
import { cn } from "@/lib/utils";

export interface SimpleSelectOption<T extends string = string> {
  value: T;
  label: string;
}

/**
 * SimpleMenu 风格的下拉选择器，替代原生 <select>（系统灰渐变外观与应用
 * 风格脱节，用户否决）。触发钮沿用设置行控件外观；浮层与停靠菜单同款：
 * 分组标题 + ✓ 前缀勾选项（勾选项不对齐是既定风格，见停靠菜单）。
 */
export function SimpleSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  menuLabel,
  disabled,
  size = "body",
  align = "start",
  className,
}: {
  value: T;
  options: readonly SimpleSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  /** 浮层顶部分组标题（同停靠菜单的「磁吸方向」）。 */
  menuLabel?: string;
  disabled?: boolean;
  /** body = 设置行（h-8）；micro = 目标栏弹层（h-6）。 */
  size?: "body" | "micro";
  align?: "start" | "end";
  className?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <SimpleMenu
      align={align}
      menuRole="listbox"
      menuAriaLabel={ariaLabel}
      className={cn("block", className)}
      menuClassName="max-h-64 w-full min-w-full overflow-y-auto"
      trigger={({ open, toggle, controls }) => (
        <button
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={controls}
          disabled={disabled}
          onClick={toggle}
          className={cn(
            "flex w-full items-center gap-1 border border-border bg-transparent text-left text-foreground outline-none",
            "hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50 dark:hover:bg-white/10",
            size === "body"
              ? "h-8 rounded-lg px-2 text-body"
              : "h-6 rounded-sm px-1 text-micro"
          )}
        >
          <span className="min-w-0 flex-1 truncate">{current?.label ?? ""}</span>
          <ChevronDown
            aria-hidden
            className={cn(
              "shrink-0 text-muted-foreground",
              size === "body" ? "size-3.5" : "size-2.5"
            )}
          />
        </button>
      )}
    >
      {(close) => (
        <>
          {menuLabel && <SimpleMenuLabel>{menuLabel}</SimpleMenuLabel>}
          {options.map((option) => (
            <SimpleMenuItem
              key={option.value}
              selected={option.value === value}
              onClick={() => {
                close();
                if (option.value !== value) onChange(option.value);
              }}
            >
              {option.value === value ? "✓ " : ""}
              {option.label}
            </SimpleMenuItem>
          ))}
        </>
      )}
    </SimpleMenu>
  );
}
