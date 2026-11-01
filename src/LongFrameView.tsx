import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { floatingSurface } from "@/components/ui/floating-surface";
import { useT } from "@/lib/i18n";
import { LONG_PROGRESS_EVENT } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** 长截屏选区边框：窗口比选区每边大 4pt、鼠标穿透，边框画在选区外不会被截进去
 * （SCK 取帧排除本应用窗口，接不上时贴在选区顶部的提示也不会进长图）。
 * 滚太快接不上时边框变警示色并提示往回滚，接上后恢复。 */
export default function LongFrameView() {
  const t = useT();
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const off = listen<{ stalled: boolean }>(LONG_PROGRESS_EVENT, (event) => setStalled(event.payload.stalled));
    return () => void off.then((f) => f());
  }, []);
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0.5 flex justify-center rounded-sm border-2",
        stalled ? "animate-pulse border-warning" : "border-primary"
      )}
    >
      {stalled && (
        <span className={cn(floatingSurface(), "mt-2 h-fit rounded-md px-2 py-1 text-label text-warning")}>
          {t("滚太快接不上，往回滚一点")}
        </span>
      )}
    </div>
  );
}
