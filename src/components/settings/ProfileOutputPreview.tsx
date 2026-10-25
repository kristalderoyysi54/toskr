import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n";
import { DELIVERY_FORMAT_OPTIONS } from "@/lib/profileManager";
import {
  buildDeliveryOutputPreview,
  defaultDeliveryOutputPreviewText,
  MAX_DELIVERY_OUTPUT_PREVIEW_LENGTH,
} from "@/lib/profileOutputPreview";
import type { DeliveryOutputMode } from "@/lib/targetProfiles";

export function ProfileOutputPreview({ mode }: { mode: DeliveryOutputMode }) {
  const t = useT();
  const [sourceText, setSourceText] = useState(defaultDeliveryOutputPreviewText);
  const outputText = buildDeliveryOutputPreview(sourceText, mode);
  const modeLabel = t(DELIVERY_FORMAT_OPTIONS.find(
    (option) => option.value === mode
  )?.label ?? "原文");
  const previewStatus = t("{mode}预览已更新，共 {n} 个字符", { mode: modeLabel, n: [...outputText].length });
  const [announcement, setAnnouncement] = useState(previewStatus);

  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncement(previewStatus), 300);
    return () => window.clearTimeout(timer);
  }, [previewStatus]);

  return (
    <div className="mt-2 min-w-0 max-w-full rounded-lg border border-border/60 bg-card p-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="min-w-0 text-micro font-medium text-muted-foreground">
          {t("测试内容（可编辑，最多 4000 字符）")}
          <textarea
            aria-label={t("输出方式预览测试内容")}
            value={sourceText}
            rows={5}
            maxLength={MAX_DELIVERY_OUTPUT_PREVIEW_LENGTH}
            onChange={(event) => setSourceText(event.target.value)}
            className="mt-1 min-h-24 w-full resize-y rounded-lg border border-border bg-transparent px-2 py-1.5 font-mono text-micro font-normal leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
        </label>
        <div className="min-w-0">
          <p className="text-micro font-medium text-muted-foreground">
            {t("格式预览 · {mode}", { mode: modeLabel })}
          </p>
          <pre
            aria-label={t("{mode}格式预览结果", { mode: modeLabel })}
            tabIndex={0}
            className="mt-1 min-h-24 max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-2 py-1.5 font-mono text-micro leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            {outputText || t("（空内容不会发送）")}
          </pre>
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {announcement}
          </span>
        </div>
      </div>
    </div>
  );
}
