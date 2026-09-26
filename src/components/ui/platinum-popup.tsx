import { cn } from "@/lib/utils";

/**
 * Platinum 弹出菜单按钮（Mac OS 9 HIG fig. 2-7）：黑描边圆角框 + 右侧箭头井，
 * 内嵌透明原生 select，展开的列表是系统原生菜单。仅 Platinum 配色方案使用。
 */
export function PlatinumPopup<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <span className={cn("platinum-popup", className)}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span aria-hidden className="platinum-popup__well">
        <i>
          <b />
        </i>
      </span>
    </span>
  );
}
