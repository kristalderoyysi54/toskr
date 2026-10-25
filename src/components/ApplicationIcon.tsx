import { AppWindow } from "lucide-react";
import { useState } from "react";

import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 统一应用图标渲染：原生调用缓存由上层负责，这里只处理 URL/解码失败。
 * failedSrc 与当前 src 绑定，目标切换后不会把旧图标失败状态带给新目标。
 */
export function ApplicationIcon({
  src,
  name,
  className,
}: {
  src: string | null | undefined;
  name: string;
  className?: string;
}) {
  const t = useT();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src && src !== failedSrc);

  if (showImage && src) {
    return (
      <img
        key={src}
        src={src}
        alt={t("{name} 应用图标", { name })}
        onError={() => setFailedSrc(src)}
        className={cn(
          "shrink-0 animate-in fade-in-0 duration-100 motion-reduce:animate-none",
          className
        )}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={t("{name} 应用图标", { name })}
      className={cn(
        "flex shrink-0 items-center justify-center bg-muted text-muted-foreground",
        className
      )}
    >
      <AppWindow aria-hidden className="size-1/2" />
    </span>
  );
}
