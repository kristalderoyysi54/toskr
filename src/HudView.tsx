import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion, MotionConfig, type Variants } from "motion/react";
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
import { hudActionable } from "@/lib/hudForm";
import { tweenMenu, tweenOverlay } from "@/lib/motion";
import {
  api,
  HUD_EVENT,
  HUD_EXIT_EVENT,
  HUD_HOVER_EVENT,
  type HudHoverPayload,
  type HudPayload,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

import logoUrl from "../src-tauri/icons/128x128.png";

/** 气泡离场原因：被新气泡顶替 → 退成残影；主动关闭/超时 → 快速淡出。 */
type ExitReason = "replaced" | "dismiss";

/**
 * 到达式进出场（2026-09-11 案 1）：从 logo 方向 10px 升起落定（160ms ease-standard）；
 * 被顶替时下沉 8px、缩到 .95、换暗一档纸色停 0.7s 再淡出，连发时能看出「刚才还有一条」。
 * exit 的 custom 由 AnimatePresence 注入，子元素（气泡底色/尾巴）的 exit 变体共用同一原因。
 */
const bubbleVariants: Variants = {
  hidden: { opacity: 0, y: 10, scale: 0.982 },
  shown: { opacity: 1, y: 0, scale: 1, transition: tweenOverlay },
  exit: (reason: ExitReason) =>
    reason === "replaced"
      ? {
          zIndex: 0,
          y: [0, 8, 8, 10],
          scale: [1, 0.95, 0.95, 0.93],
          opacity: [1, 0.85, 0.85, 0],
          transition: {
            duration: 1.14,
            times: [0, 0.14, 0.75, 1],
            ease: ["easeOut", "linear", "easeIn"],
          },
        }
      : { opacity: 0, scale: 0.96, transition: tweenMenu },
};
const balloonVariants: Variants = {
  exit: (reason: ExitReason) =>
    reason === "replaced"
      ? { backgroundColor: "var(--paper-ghost)", transition: tweenOverlay }
      : {},
};
const tailVariants: Variants = {
  exit: (reason: ExitReason) =>
    reason === "replaced" ? { opacity: 0, transition: { duration: 0.08 } } : {},
};
/** logo 独立进出：连发替换时不随每条气泡重新入场。 */
const logoVariants: Variants = {
  hidden: { opacity: 0, y: 4 },
  shown: { opacity: 1, y: 0, transition: tweenOverlay },
  exit: { opacity: 0, transition: tweenMenu },
};

/**
 * 迷你 HUD 窗口（独立 webview）：全应用统一的提示气泡（捕获/操作确认/警示）。
 * 形态：纸白说话气泡 + 尾巴指向右下角 logo（「logo 在说话」），右侧常显关闭钮。
 * 默认点击穿透；Rust 侧检测到光标悬停会关闭穿透并推送 hover 态，
 * 此时关闭钮可点、对 undoable 的提示展示「撤销」按钮。
 */
export default function HudView() {
  const [item, setItem] = useState<(HudPayload & { key: number }) | null>(null);
  const [hovered, setHovered] = useState(false);
  // 离场原因在 setItem 之前写入；同一次渲染里 AnimatePresence 读到的 custom 即为本次原因
  const exitReason = useRef<ExitReason>("dismiss");

  useEffect(() => {
    const un1 = listen<HudPayload>(HUD_EVENT, (event) => {
      exitReason.current = "replaced";
      setItem({ ...event.payload, key: performance.now() });
      setHovered(false);
    });
    const un2 = listen<HudHoverPayload>(HUD_HOVER_EVENT, (event) => {
      setHovered(event.payload.hovered);
    });
    // Rust 隐藏前的预告：清空内容播退场，160ms 后窗口才真正 hide
    const un3 = listen(HUD_EXIT_EVENT, () => {
      exitReason.current = "dismiss";
      setItem(null);
    });
    return () => {
      un1.then((fn) => fn());
      un2.then((fn) => fn());
      un3.then((fn) => fn());
    };
  }, []);

  const undoable = !!item?.undoable;
  const pill = !!item && !hudActionable(item);

  const dismiss = () => {
    // 与点击气泡同一退场节奏：先本地播退场，再让窗口隐藏
    exitReason.current = "dismiss";
    setItem(null);
    window.setTimeout(() => void api.hideHud(), 150);
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-screen w-screen flex-col items-end overflow-hidden px-3 pt-2">
        {/* popLayout：被顶替的旧气泡脱离文档流原地退成残影（zIndex 0），新气泡在其上方到达 */}
        <AnimatePresence mode="popLayout" custom={exitReason.current}>
          {item && (
            <motion.div
              key={item.key}
              custom={exitReason.current}
              variants={bubbleVariants}
              initial="hidden"
              animate="shown"
              exit="exit"
              className="relative z-10 w-full"
            >
              {pill ? (
                // 药丸：单行、无尾巴无头像；点击即收起（纯告知，无动作可执行）
                <div className="flex w-full justify-end">
                  <motion.div
                    variants={balloonVariants}
                    onClick={dismiss}
                    title="点击关闭"
                    className="flex max-w-full cursor-default items-center gap-1.5 rounded-full bg-paper py-1 pl-1.5 pr-3 text-paper-foreground elevation-2"
                  >
                    <HudIcon kind={item.kind} />
                    <p className="min-w-0 truncate text-body font-medium leading-tight">{titleOf(item)}</p>
                  </motion.div>
                </div>
              ) : (
              /* token-exception: 气泡与尾巴合成一个异形剪影，须用多层 drop-shadow
                 统一投影 + 0.5px 描边（elevation 系列是 box-shadow，罩不住尾巴） */
              <div className="relative w-full [filter:drop-shadow(0_1px_1px_rgb(20_20_24/0.10))_drop-shadow(0_4px_10px_rgb(20_20_24/0.16))_drop-shadow(0_0_0.5px_rgb(20_20_24/0.30))] dark:[filter:drop-shadow(0_1px_1px_rgb(0_0_0/0.35))_drop-shadow(0_5px_14px_rgb(0_0_0/0.45))_drop-shadow(0_0_0.5px_rgb(0_0_0/0.60))]">
                <motion.div
                  variants={balloonVariants}
                  className="flex w-full items-center gap-2 rounded-2xl bg-paper py-1.5 pl-2.5 pr-1.5 text-paper-foreground"
                >
                  <HudIcon kind={item.kind} />
                  <div
                    onClick={() => {
                      // 点击气泡本体：打开面板。到期提醒跳任务页并定位该任务；
                      // settings: 目标（更新提醒）改开设置窗对应分区；
                      // 其余定位到刚捕获的卡片。先本地播退场，再让窗口隐藏
                      void api.hudAction("open", item.targetId ?? undefined, item.kind === "due");
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
                        void api.hudAction("undo");
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
                </motion.div>
                {/* token-exception: 尾巴为固定几何 SVG（22×13），从气泡右下弯向 logo */}
                <motion.svg
                  variants={tailVariants}
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
                </motion.svg>
              </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        {/* token-exception: 头像投影须跟随图标透明轮廓，box-shadow 做不到 */}
        <AnimatePresence>
          {item && !pill && (
            <motion.img
              key="logo"
              variants={logoVariants}
              initial="hidden"
              animate="shown"
              exit="exit"
              src={logoUrl}
              alt=""
              draggable={false}
              className="mr-0.5 mt-1.5 size-9 select-none [filter:drop-shadow(0_2px_5px_rgb(20_20_24/0.28))] dark:[filter:drop-shadow(0_3px_7px_rgb(0_0_0/0.55))]"
            />
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
