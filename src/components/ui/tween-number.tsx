import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "motion/react";

import { tweenValue } from "@/lib/motion";

const defaultFormat = (value: number) => String(Math.round(value));

/**
 * 数值切换的连续过渡（2026-09-11 案 4）：value 变化时从旧值缓动到新值再格式化；
 * 首次挂载直接显示，reduce-motion 直接落终值。搭配 tabular-nums，过程中不抖宽。
 */
export function TweenNumber({
  value,
  format = defaultFormat,
}: {
  value: number;
  format?: (value: number) => string;
}) {
  const reduced = useReducedMotion();
  const formatRef = useRef(format);
  formatRef.current = format;
  const previous = useRef(value);
  const [display, setDisplay] = useState(() => format(value));
  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (reduced || from === value) {
      setDisplay(formatRef.current(value));
      return;
    }
    const controls = animate(from, value, {
      ...tweenValue,
      onUpdate: (latest) => setDisplay(formatRef.current(latest)),
      onComplete: () => setDisplay(formatRef.current(value)),
    });
    return () => controls.stop();
  }, [value, reduced]);
  return <>{display}</>;
}
