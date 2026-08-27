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
  X,
} from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
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

import logoUrl from "../src-tauri/icons/128x128.png";

/**
 * 迷你 HUD 窗口（独立 webview）：全应用统一的提示气泡（捕获/操作确认/警示）。
 * 形态：纸白说话气泡 + 尾巴指向右下角 logo（「logo 在说话」），右侧常显关闭钮。
 * 默认点击穿透；Rust 侧检测到光标悬停会关闭穿透并推送 hover 态，
 * 此时关闭钮可点、对 undoable 的提示展示「撤销」按钮。
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

  const dismiss = () => {
    // 与点击气泡同一退场节奏：先本地播退场，再让窗口隐藏
    setItem(null);
    window.setTimeout(() => void api.hideHud(), 150);
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-screen w-screen flex-col items-end overflow-hidden px-3 pt-2">
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
              className="flex w-full flex-col items-end"
            >
              {/* token-exception: 气泡与尾巴合成一个异形剪影，须用多层 drop-shadow
                  统一投影 + 0.5px 描边（elevation 系列是 box-shadow，罩不住尾巴） */}
              <div className="relative w-full [filter:drop-shadow(0_1px_1px_rgb(20_20_24/0.10))_drop-shadow(0_4px_10px_rgb(20_20_24/0.16))_drop-shadow(0_0_0.5px_rgb(20_20_24/0.30))] dark:[filter:drop-shadow(0_1px_1px_rgb(0_0_0/0.35))_drop-shadow(0_5px_14px_rgb(0_0_0/0.45))_drop-shadow(0_0_0.5px_rgb(0_0_0/0.60))]">
                <div className="flex w-full items-center gap-2 rounded-2xl bg-paper py-1.5 pl-2.5 pr-1.5 text-paper-foreground">
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
                          ? item.targetId?.startsWith("bill:")
                            ? { page: "tasks", billId: item.targetId.slice("bill:".length) }
                            : { page: "tasks", taskId: item.targetId ?? null }
                          : item.targetId === "update"
                            ? { update: true }
                            : item.targetId?.startsWith("settings:")
                              ? { settings: item.targetId.slice("settings:".length) }
                              : item.targetId === "page:secret"
                                ? { page: "secret" }
                                : {}
                      );
                      dismiss();
                    }}
                    title="点击查看"
                    className="min-w-0 flex-1 cursor-pointer"
                  >
                    <p className="text-body font-medium leading-tight">
                      {titleOf(item)}
                    </p>
                    {/* warn/undone/sent 的 text 已是标题本身，副行只给捕获类展示预览 */}
                    {(item.kind === "added" || item.kind === "duplicate") &&
                      item.text && (
                        <p className="truncate text-micro leading-tight text-paper-foreground/55">
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
                        "flex shrink-0 items-center gap-1 rounded-sm border border-paper-foreground/25 px-1.5 py-0.5 outline-none",
                        "text-micro text-paper-foreground/75 transition-opacity hover:bg-paper-foreground/10",
                        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                        hovered ? "opacity-100" : "pointer-events-none opacity-0"
                      )}
                    >
                      <Undo2 className="size-2.5" /> 撤销
                    </button>
                  )}
                  <IconButton
                    label="关闭"
                    onClick={dismiss}
                    className="rounded-full bg-paper-foreground/10 text-paper-foreground/60 hover:bg-paper-foreground/15 hover:text-paper-foreground/85 dark:hover:bg-paper-foreground/15 dark:hover:text-paper-foreground/85"
                  >
                    <X strokeWidth={2.5} />
                  </IconButton>
                </div>
                {/* token-exception: 尾巴为固定几何 SVG（22×13），从气泡右下弯向 logo */}
                <svg
                  className="absolute right-3.5 top-full -mt-px"
                  width="22"
                  height="13"
                  viewBox="0 0 22 13"
                  aria-hidden="true"
                >
                  <path
                    className="fill-paper"
                    d="M2 0 H20 C19.6 3.8 20.2 7.6 21.6 10.8 Q22.4 12.6 20.6 12.3 C13.8 11.2 6 7.4 2 0 Z"
                  />
                </svg>
              </div>
              {/* token-exception: 头像投影须跟随图标透明轮廓，box-shadow 做不到 */}
              <img
                src={logoUrl}
                alt=""
                draggable={false}
                className="mr-0.5 mt-1.5 size-9 select-none [filter:drop-shadow(0_2px_5px_rgb(20_20_24/0.28))] dark:[filter:drop-shadow(0_3px_7px_rgb(0_0_0/0.55))]"
              />
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
