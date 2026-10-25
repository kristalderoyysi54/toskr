import { slicePlaceholderSegments } from "@/lib/delivery/findingSegments";
import { useT } from "@/lib/i18n";

/** P3：将要粘贴的最终文本（只读），占位符以成功色标出，确认的是最终会出现在对话框里的字。 */
export function SendPreviewText({ text, placeholders }: { text: string; placeholders: readonly string[] }) {
  const t = useT();
  const segments = slicePlaceholderSegments(text, placeholders);
  return (
    <pre
      aria-label={t("将要粘贴的文本")}
      className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono text-label leading-relaxed"
    >
      {segments.length === 0 ? (
        <span className="text-muted-foreground">{t("（无文字，仅图片）")}</span>
      ) : (
        segments.map((segment, index) =>
          segment.placeholder ? (
            <mark key={index} className="rounded-[2px] bg-success/20 px-0.5 text-inherit">
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )
      )}
    </pre>
  );
}
