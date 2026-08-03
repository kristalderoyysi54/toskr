import { useEffect, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  AlarmClock,
  AlertTriangle,
  Check,
  CopyCheck,
  Info,
  Send,
  Undo2,
} from "lucide-react";

import {
  api,
  HUD_EVENT,
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
    return () => {
      un1.then((fn) => fn());
      un2.then((fn) => fn());
    };
  }, []);

  if (!item) {
    return <div className="h-screen w-screen bg-transparent" />;
  }

  const undoable = !!item.undoable;

  return (
    <div className="flex h-screen w-screen items-center overflow-hidden bg-transparent px-3">
      <div key={item.key} className="hud-pop flex w-full items-center gap-2">
        <HudIcon kind={item.kind} />
        <div
          onClick={() => {
            // 点击气泡本体：打开面板。到期提醒跳任务页并定位该任务，
            // 其余定位到刚捕获的卡片
            void emitTo(
              "main",
              HUD_OPEN_PANEL_EVENT,
              item.kind === "due"
                ? { page: "tasks", taskId: item.targetId ?? null }
                : {}
            );
            void api.hideHud();
          }}
          title="点击查看"
          className="min-w-0 flex-1 cursor-pointer">
          <p className="text-[12px] font-medium leading-tight text-white">
            {titleOf(item)}
          </p>
          {/* warn/undone/sent 的 text 已是标题本身，副行只给捕获类展示预览 */}
          {(item.kind === "added" || item.kind === "duplicate") && item.text && (
            <p className="truncate text-[10px] leading-tight text-white/60">
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
              "flex shrink-0 items-center gap-1 rounded-md border border-white/20 px-1.5 py-0.5",
              "text-[10px] text-white/90 transition-opacity hover:bg-white/15",
              hovered ? "opacity-100" : "pointer-events-none opacity-0"
            )}
          >
            <Undo2 className="size-2.5" /> 撤销
          </button>
        )}
      </div>
    </div>
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
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/90">
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
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/90">
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
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-red-500/90">
          <AlarmClock className="size-3 text-white" strokeWidth={2.5} />
        </span>
      );
  }
}
