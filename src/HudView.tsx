import { useEffect, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import {
  AlarmClock,
  AlertTriangle,
  Check,
  CopyCheck,
  Info,
  Send,
  Undo2,
} from "lucide-react";

import { tweenMenu } from "@/lib/motion";
import {
  api,
  HUD_EVENT,
  HUD_EXIT_EVENT,
  HUD_HOVER_EVENT,
  HUD_OPEN_PANEL_EVENT,
  UNDO_CAPTURE_EVENT,
  type HudHoverPayload,
  type HudPayload,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * 迷你 HUD 窗口（独立 webview）：全应用统一的提示气泡（捕获/操作确认/警示）。
 * 默认点击穿透；Rust 侧检测到光标悬停会关闭穿透并推送 hover 态，
 * 此时对 undoable 的提示展示「撤销」按钮。
 */
export default function HudView() {
  const [item, setItem] = useState<(HudPayload & { key: number }) | null>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const un1 = listen<HudPayload>(HUD_EVENT, (event) => {
      setItem({ ...event.payload, key: performance.now() });
      setHovered(false);
    });
    const un2 = listen<HudHoverPayload>(HUD_HOVER_EVENT, (event) => {
      setHovered(event.payload.hovered);
    });
    // Rust 隐藏前的预告：清空内容播退场，160ms 后窗口才真正 hide
    const un3 = listen(HUD_EXIT_EVENT, () => setItem(null));
    return () => {
      un1.then((fn) => fn());
      un2.then((fn) => fn());
      un3.then((fn) => fn());
    };
  }, []);

  const undoable = !!item?.undoable;

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative flex h-screen w-screen items-center overflow-hidden rounded-xl bg-foreground/75 px-3 dark:bg-transparent">
        {/* token-exception: rounded-[14px] 对齐 Rust 原生 vibrancy 圆角（apply_vibrancy radius=14） */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[14px] shadow-[inset_0_1px_0_oklch(1_0_0/0.16)]"
        />
        {/* 进出场对称：入场沿用原 hud-pop 参数；退场淡出微缩。
            连发覆盖时 popLayout 让新旧内容交叉淡切，单槽替换不再是硬切 */}
        <AnimatePresence mode="popLayout">
          {item && (
            <motion.div
              key={item.key}
              initial={{ opacity: 0, y: -4, scale: 0.94 }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
                transition: { duration: 0.18, ease: [0.2, 0.9, 0.3, 1.2] },
              }}
              exit={{ opacity: 0, scale: 0.96, transition: tweenMenu }}
              className="flex w-full items-center gap-2"
            >
              <HudIcon kind={item.kind} />
              <div
                onClick={() => {
                  // 点击气泡本体：打开面板。到期提醒跳任务页并定位该任务；
                  // settings: 目标（更新提醒）改开设置窗对应分区；
                  // 其余定位到刚捕获的卡片。先本地播退场，再让窗口隐藏
                  void emitTo(
                    "main",
                    HUD_OPEN_PANEL_EVENT,
                    item.kind === "due"
                      ? { page: "tasks", taskId: item.targetId ?? null }
                      : item.targetId === "update"
                        ? { update: true }
                        : item.targetId?.startsWith("settings:")
                          ? { settings: item.targetId.slice("settings:".length) }
                          : {}
                  );
                  setItem(null);
                  window.setTimeout(() => void api.hideHud(), 150);
                }}
                title="点击查看"
                className="min-w-0 flex-1 cursor-pointer"
              >
                <p className="text-body font-medium leading-tight text-white">
                  {titleOf(item)}
                </p>
                {/* warn/undone/sent 的 text 已是标题本身，副行只给捕获类展示预览 */}
                {(item.kind === "added" || item.kind === "duplicate") && item.text && (
                  <p className="truncate text-micro leading-tight text-white/60">
                    {item.text}
                  </p>
                )}
              </div>
              {undoable && (
                <button
                  onClick={() => {
                    void emitTo("main", UNDO_CAPTURE_EVENT, {});
                  }}
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-sm border border-white/20 px-1.5 py-0.5 outline-none",
                    "text-micro text-white/90 transition-opacity hover:bg-white/15",
                    "focus-visible:ring-2 focus-visible:ring-white/60",
                    hovered ? "opacity-100" : "pointer-events-none opacity-0"
                  )}
                >
                  <Undo2 className="size-2.5" /> 撤销
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

function titleOf(item: HudPayload): string {
  switch (item.kind) {
    case "added":
      return item.count > 1 ? `已捕获 ×${item.count}` : "已捕获";
    case "duplicate":
      return "已存在相同内容";
    case "warn":
      return item.text || "注意";
    case "undone":
      return item.text || "已撤销";
    case "sent":
      return item.text || "已发送";
    case "ok":
      return item.text || "完成";
    case "info":
      return item.text || "提示";
    case "due":
      return item.text || "任务到期";
  }
}

function HudIcon({ kind }: { kind: HudPayload["kind"] }) {
  switch (kind) {
    case "added":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/90">
          <Check className="size-3 text-white" strokeWidth={3} />
        </span>
      );
    case "duplicate":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-500/90">
          <CopyCheck className="size-3 text-white" strokeWidth={2.5} />
        </span>
      );
    case "warn":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-orange-500/90">
          <AlertTriangle className="size-3 text-white" strokeWidth={2.5} />
        </span>
      );
    case "undone":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-500/90">
          <Undo2 className="size-3 text-white" strokeWidth={2.5} />
        </span>
      );
    case "sent":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sky-500/90">
          <Send className="size-3 text-white" strokeWidth={2.5} />
        </span>
      );
    case "ok":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/90">
          <Check className="size-3 text-white" strokeWidth={3} />
        </span>
      );
    case "info":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-500/90">
          <Info className="size-3 text-white" strokeWidth={2.5} />
        </span>
      );
    case "due":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive/90">
          <AlarmClock className="size-3 text-white" strokeWidth={2.5} />
        </span>
      );
  }
}
