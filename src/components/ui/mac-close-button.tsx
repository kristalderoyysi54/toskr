import { Minus, Plus, X } from "lucide-react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { cn } from "@/lib/utils";

/**
 * macOS 交通灯（红=关 黄=最小化 绿=缩放）：无边框详情窗专用，对齐系统窗口
 * 的关窗肌肉记忆位（用户 2026-08-27 指定，随后补齐黄绿两枚）。
 * 悬停整组任意一枚，三枚同时显出字形（原生同款行为）；after 伪元素扩热区。
 * 最小化的窗口无 Dock 图标（Accessory 应用），Rust 侧展示详情窗前会
 * unminimize 兜底——重开任意卡片即可复原。
 */

const DOT_BASE = cn(
  "relative flex size-3 shrink-0 items-center justify-center rounded-full",
  "after:absolute after:-inset-1",
  "ring-1 ring-inset ring-black/15",
  "outline-none transition-[filter] duration-(--duration-control) hover:brightness-95",
  "focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
);

const GLYPH_BASE = cn(
  "size-2 opacity-0 transition-opacity duration-(--duration-control)",
  "group-hover/traffic:opacity-100 group-focus-within/traffic:opacity-100"
);

export function MacTrafficLights({
  closeLabel = "关闭",
  closeDisabled,
  onClose,
  className,
}: {
  closeLabel?: string;
  closeDisabled?: boolean;
  onClose: () => void;
  className?: string;
}) {
  const win = getCurrentWebviewWindow();
  return (
    <div className={cn("group/traffic flex shrink-0 items-center gap-2", className)}>
      <button
        aria-label={closeLabel}
        title={closeLabel}
        disabled={closeDisabled}
        onClick={onClose}
        // token-exception: macOS 交通灯系统红/深红字形，刻意与系统窗口控件同色
        className={cn(DOT_BASE, "bg-[#ff5f57]")}
      >
        <X className={cn(GLYPH_BASE, "text-[#7d0d06]")} strokeWidth={3} />
      </button>
      <button
        aria-label="最小化"
        title="最小化（重开卡片即复原）"
        onClick={() => void win.minimize()}
        // token-exception: macOS 交通灯系统黄/深黄字形
        className={cn(DOT_BASE, "bg-[#febc2e]")}
      >
        <Minus className={cn(GLYPH_BASE, "text-[#8a5a09]")} strokeWidth={3} />
      </button>
      <button
        aria-label="缩放"
        title="缩放：占满/还原"
        onClick={() => void win.toggleMaximize()}
        // token-exception: macOS 交通灯系统绿/深绿字形
        className={cn(DOT_BASE, "bg-[#28c840]")}
      >
        <Plus className={cn(GLYPH_BASE, "text-[#0b6120]")} strokeWidth={3} />
      </button>
    </div>
  );
}
