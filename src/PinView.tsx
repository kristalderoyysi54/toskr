import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useT } from "@/lib/i18n";
import { api } from "@/lib/tauri";

/** 钉图窗：置顶显示一张截图。拖动移动、滚轮缩放、⌘C 复制、双击或 Esc 关闭。 */
export default function PinView() {
  const t = useT();
  const [src, setSrc] = useState<string | null>(null);
  const factor = useRef(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const zoomTimer = useRef<number | null>(null);

  useEffect(() => {
    let url: string | null = null;
    void api
      .pinImage()
      .then((buf) => {
        url = URL.createObjectURL(new Blob([buf], { type: "image/bmp" }));
        setSrc(url);
      })
      .catch(() => void api.pinClose());
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void api.pinClose();
      } else if (e.metaKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void api.pinCopy();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  if (!src) return null;
  return (
    <div
      className="fixed inset-0 cursor-grab select-none overflow-hidden border border-primary/40"
      title={t("钉图：拖动移动 · 滚轮缩放 · ⌘C 复制 · 双击或 Esc 关闭")}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if (e.detail >= 2) void api.pinClose();
        else void getCurrentWindow().startDragging();
      }}
      onWheel={(e) => {
        factor.current = Math.min(4, Math.max(0.2, factor.current * (1 - e.deltaY * 0.002)));
        void api.pinZoom(factor.current);
        // 缩放时在图上短暂显示当前比例
        setZoom(Math.round(factor.current * 100));
        if (zoomTimer.current) window.clearTimeout(zoomTimer.current);
        zoomTimer.current = window.setTimeout(() => setZoom(null), 900);
      }}
    >
      <img src={src} alt="" draggable={false} className="pointer-events-none size-full object-fill" />
      {zoom !== null && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-md bg-black/70 px-2 py-1 font-mono text-body text-white tabular-nums">{zoom}%</span>
        </div>
      )}
    </div>
  );
}
