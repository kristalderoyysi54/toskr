import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { X } from "lucide-react";

import { api } from "@/lib/tauri";

/**
 * 图片原尺寸预览窗（独立 webview，Paste 风格）：
 * 标题栏与图片区均可拖动窗口、可缩放；⊗ / Esc / Space 关闭（隐藏复用）。
 * 刻意不做失焦关闭——可拖动窗口的语义是「摆在一边对照看」。
 */
export default function ImagePreviewView() {
  const [file, setFile] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [dims, setDims] = useState("");

  useEffect(() => {
    const un = listen<string>("toskr://preview-image", (e) => setFile(e.payload));
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!file) return;
    setUrl(null);
    setDims("");
    void api
      .imageDataUrl(file)
      .then((u) => setUrl(u))
      .catch(() => setUrl(null));
  }, [file]);

  const close = () => void getCurrentWebviewWindow().hide();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-white/10 bg-zinc-900/95">
      {/* 标题栏：可拖动窗口 */}
      <div
        data-tauri-drag-region
        className="flex h-8 shrink-0 cursor-grab items-center gap-1.5 px-2 active:cursor-grabbing"
      >
        <button
          aria-label="关闭预览"
          onClick={close}
          className="rounded-full p-0.5 text-white/60 hover:bg-white/10 hover:text-white"
        >
          <X className="size-3.5" />
        </button>
        <span data-tauri-drag-region className="select-none text-[12px] font-medium text-white/80">
          图片
        </span>
      </div>
      {/* 图片区：同样可拖动窗口（img 关闭指针事件，拖拽落在容器上） */}
      <div
        data-tauri-drag-region
        className="flex min-h-0 flex-1 cursor-grab items-center justify-center p-2 active:cursor-grabbing"
      >
        {url ? (
          <img
            src={url}
            alt=""
            onLoad={(e) =>
              setDims(
                `${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`
              )
            }
            className="pointer-events-none max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="text-[12px] text-white/50">加载中…</span>
        )}
      </div>
      <div className="flex h-6 shrink-0 items-center justify-center text-[11px] tabular-nums text-white/60">
        {dims}
      </div>
    </div>
  );
}
