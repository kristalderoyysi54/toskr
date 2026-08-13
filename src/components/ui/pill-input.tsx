import { useRef } from "react";
import { CornerDownLeft } from "lucide-react";

import { focusRingWithin } from "@/components/ui/focus-ring";
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
  /** 禁用（AI 请求在途等）：输入锁定、提交短路、壳降不透明度。 */
  disabled?: boolean;
  /** 粘贴内容含图片时回调（并阻断默认文本粘贴）；未传则粘贴行为保持原生。 */
  onPasteImage?: () => void;
  /** 输入行上方的附件区（如暂存图片缩略 chips）。 */
  attachmentsSlot?: React.ReactNode;
  /** 文本为空时也允许提交（有暂存附件的场景）。 */
  canSubmitEmpty?: boolean;
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
  disabled = false,
  onPasteImage,
  attachmentsSlot,
  canSubmitEmpty = false,
}: PillInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submittable = !!value.trim() || canSubmitEmpty;

  /** ⌘V 含图片 → 拦截默认粘贴交给回调（纯文本粘贴不受影响）。
   *  探测放宽：WKWebView 对「新鲜截图」（TIFF 形态）常不暴露 image/* 项，
   *  故追加「纯文本为空」兜底——截图剪贴板必然无文本，交给 Rust 直读判定；
   *  真没图时回调侧仅提示一次，等价无害的空粘贴。 */
  const handlePaste = (e: React.ClipboardEvent) => {
    if (!onPasteImage || disabled) return;
    const items = [...e.clipboardData.items];
    const hasImage = items.some(
      (i) => i.type.startsWith("image/") || i.kind === "file"
    );
    const textEmpty = !e.clipboardData.getData("text/plain").trim();
    if (hasImage || textEmpty) {
      e.preventDefault();
      onPasteImage();
    }
  };

  const submit = () => {
    if (disabled || !submittable) return;
    onSubmit();
    const ta = textareaRef.current;
    if (ta) ta.style.height = "auto";
    (multiline ? textareaRef : inputRef).current?.focus();
  };

  const fieldCls =
    "w-full bg-transparent text-title outline-none placeholder:text-muted-foreground";

  return (
    <div
      className={cn(
        "rounded-xl border px-2.5 py-2 backdrop-blur-sm",
        "surface-inset elevation-1",
        focusRingWithin,
        tone === "spark"
          ? "border-violet-400/60 bg-violet-500/[0.08] focus-within:border-violet-500/70"
          : "border-black/10 focus-within:border-primary/50 dark:border-white/10",
        disabled && "opacity-60",
        className
      )}
    >
      {attachmentsSlot && <div className="mb-1.5">{attachmentsSlot}</div>}
      <div className={cn("flex gap-1.5", multiline ? "items-end" : "items-center")}>
      {leftSlot}
      {multiline ? (
        <textarea
          ref={textareaRef}
          value={value}
          disabled={disabled}
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
          onPaste={handlePaste}
          className={cn(fieldCls, "max-h-[132px] min-h-5 resize-none leading-normal")}
        />
      ) : (
        <input
          ref={inputRef}
          value={value}
          disabled={disabled}
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
      {submittable && (
        <IconButton
          label={submitLabel}
          stopPropagation={false}
          disabled={disabled}
          onClick={submit}
          className={multiline ? "mb-0.5" : undefined}
        >
          <CornerDownLeft className="size-3.5" />
        </IconButton>
      )}
      </div>
    </div>
  );
}
