import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { NOTE_SECTIONS, type NoteSectionOption } from "@/lib/draftSection";

import { useT } from "@/lib/i18n";
import { api } from "@/lib/tauri";

/** 钉图窗：置顶显示一张截图。拖动移动、滚轮缩放、⌘C 复制、双击或 Esc 关闭、右键菜单。 */
const PIN_ZOOM_RESET_EVENT = "toskr://pin-zoom-reset";
const PIN_RELOAD_EVENT = "toskr://pin-reload";

export default function PinView() {
  const t = useT();
  const [src, setSrc] = useState<string | null>(null);
  const factor = useRef(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const zoomTimer = useRef<number | null>(null);
  const sections = useRef<NoteSectionOption[]>([]);

  const showZoom = (pct: number) => {
    setZoom(pct);
    if (zoomTimer.current) window.clearTimeout(zoomTimer.current);
    zoomTimer.current = window.setTimeout(() => setZoom(null), 900);
  };

  // 右键菜单「存入分组」要的分组列表；「恢复原大小」由 Rust 改窗口后通知这里复位倍率
  useEffect(() => {
    const offSections = listen<NoteSectionOption[]>(NOTE_SECTIONS, (event) => {
      sections.current = event.payload;
    });
    const offReset = listen(PIN_ZOOM_RESET_EVENT, () => {
      factor.current = 1;
      showZoom(100);
    });
    void api.screenshotRequestSections().catch(() => {});
    return () => {
      void offSections.then((f) => f());
      void offReset.then((f) => f());
    };
  }, []);

  // 「编辑标注」完成后 Rust 换了图，收到通知重新拉取
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const off = listen(PIN_RELOAD_EVENT, () => setRevision((r) => r + 1));
    return () => void off.then((f) => f());
  }, []);

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
  }, [revision]);

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
      title={t("钉图：拖动移动 · 滚轮缩放 · ⌘C 复制 · 双击或 Esc 关闭 · 右键更多")}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if (e.detail >= 2) void api.pinClose();
        else void getCurrentWindow().startDragging();
      }}
      onWheel={(e) => {
        factor.current = Math.min(4, Math.max(0.2, factor.current * (1 - e.deltaY * 0.002)));
        void api.pinZoom(factor.current);
        // 缩放时在图上短暂显示当前比例
        showZoom(Math.round(factor.current * 100));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        void api.pinMenu(sections.current);
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
