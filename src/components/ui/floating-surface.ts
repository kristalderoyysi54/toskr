import { cn } from "@/lib/utils";

/**
 * 浮层统一配方（类名函数而非包装组件——SimpleMenu 的非 portal DOM 结构不能动）。
 * 统一原先散落的两套手写浮层底色（bg-white/95 dark:bg-zinc-900/95 与其漂移变体），
 * surface-raised 别名双主题通吃；elevation 自带顶缘 rim-light。
 * tier 2 = 悬浮（菜单/卡上簇）；tier 3 = 模态/大浮层（预览卡/速查层）。
 */
export function floatingSurface(tier: 2 | 3 = 2) {
  return cn(
    "border border-foreground/10 bg-surface-raised/95",
    tier === 2 ? "elevation-2" : "elevation-3"
  );
}
