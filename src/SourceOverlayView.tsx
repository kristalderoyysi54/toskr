import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Crosshair, EyeOff } from "lucide-react";

import {
  SOURCE_OVERLAY_EVENT,
  type MessageSourceOverlayPayload,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

export default function SourceOverlayView() {
  const [payload, setPayload] = useState<MessageSourceOverlayPayload | null>(null);

  useEffect(() => {
    const subscription = listen<MessageSourceOverlayPayload>(
      SOURCE_OVERLAY_EVENT,
      (event) => setPayload(event.payload)
    );
    return () => {
      void subscription.then((stop) => stop());
    };
  }, []);

  if (!payload) return <div className="h-screen w-screen" />;
  const pointer = payload.pointerSide ?? "left";
  return (
    <div className="relative flex h-screen w-screen items-center px-2 py-2 text-foreground">
      <div
        aria-hidden
        className={cn(
          "absolute top-12 z-0 size-4 rotate-45 border bg-popover/95",
          pointer === "left"
            ? "left-1 border-b-0 border-l border-r-0 border-t"
            : "right-1 border-b border-l-0 border-r border-t-0"
        )}
      />
      <section className="relative z-10 flex h-full w-full flex-col overflow-hidden rounded-xl border border-foreground/12 bg-popover/95 px-3 py-2.5 shadow-lg backdrop-blur-xl">
        <div className="flex items-center gap-1.5 text-label text-primary">
          <Crosshair className="size-3.5" />
          <span className="font-semibold">来源 · {payload.sourceApp}</span>
          <span className="ml-auto rounded-sm bg-primary/8 px-1.5 py-0.5 text-micro">
            {payload.reason}
          </span>
        </div>
        <p className="mt-1 truncate text-title font-semibold">
          {payload.conversationName}
        </p>
        <p className="mt-0.5 truncate text-label text-muted-foreground">
          {payload.senderName}
        </p>
        <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-body leading-relaxed">
          {payload.text}
        </p>
        <div className="mt-auto flex items-center gap-1 text-micro text-muted-foreground">
          <EyeOff className="size-3" />
          未打开会话 · 未改变IM当前选中状态
        </div>
      </section>
    </div>
  );
}
