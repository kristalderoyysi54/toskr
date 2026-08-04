import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * 关键配置：把自定义 5 档字阶注册进 tailwind-merge 的 font-size 分组。
 * 不注册时 twMerge 会把 text-micro/label/… 当作「文字颜色类」，
 * 与后出现的 text-muted-foreground 等颜色类判定冲突而被吞掉——
 * 字号跌回继承值（16px），表现为"全应用字体莫名变大"（2026-08 真机排查实锤）。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "label", "body", "title", "heading"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
