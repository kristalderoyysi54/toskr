import { useRef } from "react";
import { CornerDownLeft } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { autoResizeTextarea } from "@/lib/textarea";
import { cn } from "@/lib/utils";

type PillInputProps = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  /** true = textarea（Enter 提交 / Shift+Enter 换行 / 自适应高度）；false = 单行 input */
  multiline?: boolean;
  /** spark = 灵感模式的紫色壳（TaskQuickAdd 专用） */
  tone?: "default" | "spark";
  /** 左槽（如闪念模式切换钮） */
  leftSlot?: React.ReactNode;
  submitLabel?: string;
  className?: string;
};

/**
 * 底部/顶部速记输入条的统一外壳：DraftInput 与 TaskQuickAdd 的双胞胎合一。
 * 壳：凹陷底 + 细边 + focus-within 高亮；IME 组合输入保护（isComposing）内建。
 */
export function PillInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  multiline = false,
  tone = "default",
  leftSlot,
  submitLabel = "添加",
  className,
}: PillInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    if (!value.trim()) return;
    onSubmit();
    const ta = textareaRef.current;
    if (ta) ta.style.height = "auto";
    (multiline ? textareaRef : inputRef).current?.focus();
  };

  const fieldCls =
    "w-full bg-transparent text-title outline-none placeholder:text-muted-foreground/70";

  return (
    <div
      className={cn(
        "flex gap-1.5 rounded-xl border px-2.5 py-2 backdrop-blur-sm",
        multiline ? "items-end" : "items-center",
        "surface-inset elevation-1",
        tone === "spark"
          ? "border-violet-400/60 bg-violet-500/[0.08] focus-within:border-violet-500/70"
          : "border-black/10 focus-within:border-primary/50 dark:border-white/10",
        className
      )}
    >
      {leftSlot}
      {multiline ? (
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            autoResizeTextarea(e.target);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className={cn(fieldCls, "max-h-[132px] min-h-5 resize-none leading-normal")}
        />
      ) : (
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className={fieldCls}
        />
      )}
      {value.trim() && (
        <IconButton
          label={submitLabel}
          stopPropagation={false}
          className={multiline ? "mb-0.5" : undefined}
        >
          <CornerDownLeft className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}
