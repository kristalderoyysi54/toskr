/**
 * 全应用统一 focus-visible 焦点环配方（2026-08-13 质感批次定稿）：
 * 2px 实色 ring + 1px offset（offset 用底色制造呼吸缝，环在任何表面都清晰）。
 * 旧配方（ring-3 ring-ring/50、ring-2 ring-primary/50 半透明系）勿再新增；
 * 环的圆角由组件自身 rounded-* 决定，仅 :focus-visible 出现（鼠标点击不出环）。
 */
export const focusRing =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

/** 内部件（sr-only radio / input）聚焦时，环打在容器整体上：Segmented 轨道、输入壳。 */
export const focusRingWithin =
  "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-background";
