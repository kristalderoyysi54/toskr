import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { useT } from "@/lib/i18n";
import { api, LONG_PROGRESS_EVENT } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** 长截屏预览面板（选区旁）：缩略长图随拼接变长并停在最新一段，下方提示与「取消 / 完成」。 */
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
    <div className={cn(floatingSurface(), "fixed inset-0 flex flex-col overflow-hidden rounded-lg text-body")}>
      <div className="flex items-baseline justify-between gap-2 px-3 pt-2.5 pb-1.5">
        <span className="font-medium">{t("长截屏")}</span>
        <span className="font-mono text-label text-muted-foreground tabular-nums">
          {size.width > 0 && `${size.width} × ${size.height}`}
        </span>
      </div>
      <div
        className="mx-3 min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/40 [&::-webkit-scrollbar]:hidden"
      >
        {/* 底部对齐：始终看到最新拼上的一段 */}
        <div className="flex min-h-full flex-col justify-end">
          {src && <img src={src} alt="" className="block w-full" />}
        </div>
      </div>
      <div className="px-3 py-2">
        <p className={cn("min-h-8 text-label leading-snug", stalled ? "text-warning" : "text-muted-foreground")}>
          {stalled ? t("滚太快接不上，往回滚一点") : t("滚动鼠标滚轮或拖动滚动条截取长图")}
        </p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" className="flex-1" disabled={done} onClick={() => stop(true)}>
            {t("取消")}
          </Button>
          <Button size="sm" className="flex-1" disabled={done} onClick={() => stop(false)}>
            {t("完成")}
          </Button>
        </div>
      </div>
    </div>
  );
}
