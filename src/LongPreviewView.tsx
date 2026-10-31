import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { api, LONG_PROGRESS_EVENT } from "@/lib/tauri";

/** 长截屏预览条：随拼接变长的缩略图，始终显示最新拼上的一段（底部对齐）。
 * 页面不响应自动滚动时转手动：显示「完成」按钮，滚太快接不上时提示往回滚。 */
export default function LongPreviewView() {
  const t = useT();
  const [src, setSrc] = useState<string | null>(null);
  const [height, setHeight] = useState(0);
  const [manual, setManual] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [done, setDone] = useState(false);
  const lastHeight = useRef(0);
  const busy = useRef(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    const off = listen<{ height: number; manual: boolean; stalled: boolean }>(LONG_PROGRESS_EVENT, (event) => {
      setHeight(event.payload.height);
      setManual(event.payload.manual);
      setStalled(event.payload.stalled);
      if (event.payload.height === lastHeight.current || busy.current) return;
      lastHeight.current = event.payload.height;
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

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden rounded-md border border-white/40 bg-black/75 text-micro text-white">
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
        {src && <img src={src} alt="" className="block w-full" />}
      </div>
      <div className="px-2 py-1.5 leading-snug">
        <div className="font-mono tabular-nums">{t("已拼接 {n} px", { n: height })}</div>
        <div className={stalled ? "text-warning" : "text-white/70"}>
          {!manual ? t("动一下鼠标停止") : stalled ? t("滚太快接不上，往回滚一点") : t("手动往下滚，滚完点完成")}
        </div>
        {manual && (
          <Button
            size="xs"
            className="mt-1 w-full"
            disabled={done}
            onClick={() => {
              setDone(true);
              void api.longFinish();
            }}
          >
            {t("完成")}
          </Button>
        )}
      </div>
    </div>
  );
}
