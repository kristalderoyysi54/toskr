import { useId } from "react";
import { MotionConfig } from "motion/react";

import { focusRingWithin } from "@/components/ui/focus-ring";
import { SlidingTabIndicator } from "@/components/ui/sliding-tab-indicator";
import { cn } from "@/lib/utils";

/**
 * 分段控件（单选组）：从 SettingsView 内部提升为共享原语，
 * 统一 4 处复制粘贴实现（设置页 Segmented / 主面板 PageTab / 任务行状态·优先级 picker）。
 * 语义：radiogroup/radio + aria-checked；焦点环与按压反馈内建。
 *
 * 形态（2026-08-13 质感批次）：凹陷轨道 + 浮起白 thumb（layoutId 位移 120ms），
 * 替代逐项描边 chips；选中不占用蓝色，蓝只出现在轨道整体的焦点环上。
 * 圆角遵守嵌套规则：轨道 rounded-lg(10) − p-0.5(2) = thumb rounded-md(8)。
 * 自带 MotionConfig：设置窗没有 App 根部的 reducedMotion 配置，就近兜底。
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
  const groupName = useId();
  return (
    <MotionConfig reducedMotion="user">
      <fieldset
        aria-label={ariaLabel}
        className={cn(
          "surface-inset elevation-1 inline-flex rounded-lg p-0.5",
          focusRingWithin,
          className
        )}
      >
        {options.map((o) => {
          const active = value === o.value;
          return (
            <label key={o.value} title={o.title} className="relative cursor-pointer">
              <input
                type="radio"
                name={groupName}
                checked={active}
                onChange={() => onChange(o.value)}
                className="sr-only"
              />
              {active && (
                <SlidingTabIndicator
                  layoutId={`${groupName}-thumb`}
                />
              )}
              <span
                className={cn(
                  "relative block rounded-md transition-colors duration-(--duration-control) motion-reduce:transition-none",
                  size === "sm" ? "px-2 py-1 text-label" : "px-1.5 py-0.5 text-micro",
                  active
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {o.label}
              </span>
            </label>
          );
        })}
      </fieldset>
    </MotionConfig>
  );
}
