import { useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";

import { enrichLinkMeta } from "@/lib/actions";
import { tip } from "@/lib/tip";
import { cn } from "@/lib/utils";
import { useNotesStore } from "@/store/notesStore";

/** 常驻底部的思考/Prompt 缓冲输入框：Enter 提交，Shift+Enter 换行。 */
export function DraftInput() {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  };

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    const { result, id } = useNotesStore.getState().addNote(text);
    if (result === "duplicate") {
      tip("duplicate", "");
    }
    if (result === "added" && id) void enrichLinkMeta(id);
    setValue("");
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.focus();
    }
  };

  return (
    <div className="px-3 pb-3 pt-1.5">
      <div
        className={cn(
          "flex items-end gap-1.5 rounded-xl border border-black/10 px-2.5 py-2",
          "bg-white/60 shadow-sm backdrop-blur-sm",
          "focus-within:border-primary/50 dark:border-white/10 dark:bg-white/[0.06]"
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder="添加笔记或提示词…"
          onChange={(e) => {
            setValue(e.target.value);
            autoResize(e.target);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className={cn(
            "max-h-[132px] min-h-5 w-full resize-none bg-transparent text-[13px] leading-[1.55]",
            "outline-none placeholder:text-muted-foreground/70"
          )}
        />
        {value.trim() && (
          <button
            onClick={submit}
            aria-label="添加"
            className="mb-0.5 rounded-md p-1 text-muted-foreground hover:text-foreground"
          >
            <CornerDownLeft className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
