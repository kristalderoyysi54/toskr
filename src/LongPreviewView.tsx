import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, X } from "lucide-react";

import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { useT } from "@/lib/i18n";
import { api, LONG_PROGRESS_EVENT } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** 长截屏实时预览（选区旁，参照 iShot）：整张长图等比缩放完整显示，下方工具条显示尺寸、提示与 ✕ / ✓。 */
export default function LongPreviewView() {
  const t = useT();
  const [src, setSrc] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [stalled, setStalled] = useState(false);
  const [done, setDone] = useState(false);
  const lastHeight = useRef(0);
  const busy = useRef(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    const off = listen<{ width: number; height: number; stalled: boolean }>(LONG_PROGRESS_EVENT, (event) => {
      const { width, height, stalled } = event.payload;
      setSize({ width, height });
      setStalled(stalled);
      if (height === lastHeight.current || busy.current) return;
      lastHeight.current = height;
      busy.current = true;
      void api
        .longPreviewImage()
        .then((buf) => {
          const url = URL.createObjectURL(new Blob([buf], { type: "image/bmp" }));
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = url;
          setSrc(url);
        })
        .catch(() => {})
        .finally(() => {
          busy.current = false;
        });
    });
    return () => {
      void off.then((f) => f());
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const stop = (cancel: boolean) => {
    setDone(true);
    void api.longFinish(cancel);
  };

  return (
    <div className="fixed inset-0 flex flex-col gap-2 text-body">
      {/* 整张长图等比缩放、完整显示，越拼越长就越细 */}
      <div className="flex min-h-0 flex-1 items-start justify-center">
        {src && (
          <img
            src={src}
            alt=""
            className="block max-h-full max-w-full rounded-sm border border-white/70 object-contain shadow-lg"
          />
        )}
      </div>
      <div className={cn(floatingSurface(), "flex flex-col gap-1 rounded-md px-2 py-1.5")}>
        <div className="flex items-center gap-1">
          <span className="flex-1 font-mono text-label text-muted-foreground tabular-nums">
            {size.width > 0 && `${size.width} × ${size.height}`}
          </span>
          <IconButton label={t("取消")} disabled={done} onClick={() => stop(true)}>
            <X />
          </IconButton>
          <IconButton label={t("完成")} disabled={done} onClick={() => stop(false)}>
            <Check className="text-primary" />
          </IconButton>
        </div>
        <p className={cn("text-micro leading-snug", stalled ? "text-warning" : "text-muted-foreground")}>
          {stalled ? t("滚太快接不上，往回滚一点") : t("滚动鼠标滚轮或拖动滚动条截取长图")}
        </p>
      </div>
    </div>
  );
}
