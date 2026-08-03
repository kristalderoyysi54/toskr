import { useRef, useState } from "react";
import { CornerDownLeft, Lightbulb } from "lucide-react";

import { cn } from "@/lib/utils";
import { useNotesStore } from "@/store/notesStore";

/**
 * 任务页顶部速记框：回车即存、保持焦点可连续录入。
 * 左侧 💡 可点击切换「闪念模式」——录入的内容进灵感区（紫色标识）。
 */
export function TaskQuickAdd() {
  const [value, setValue] = useState("");
  const [spark, setSpark] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    useNotesStore.getState().addTask(text, spark ? { kind: "spark" } : undefined);
    setValue("");
    inputRef.current?.focus();
  };

  return (
    <div className="mx-3 mb-1.5">
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-xl border px-2.5 py-2 shadow-sm backdrop-blur-sm",
          spark
            ? "border-violet-400/60 bg-violet-500/[0.08] focus-within:border-violet-500/70"
            : "border-black/10 bg-white/60 focus-within:border-primary/50 dark:border-white/10 dark:bg-white/[0.06]"
        )}
      >
        <button
          aria-label={spark ? "退出闪念模式" : "切换为闪念灵感模式"}
          title={spark ? "闪念模式：回车存为灵感（点击退出）" : "点击进入闪念模式：随手记灵感"}
          onClick={() => {
            setSpark(!spark);
            inputRef.current?.focus();
          }}
          className="shrink-0 rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
        >
          <Lightbulb
            className={cn(
              "size-3.5",
              spark ? "fill-violet-400 text-violet-500" : "text-muted-foreground/60"
            )}
          />
        </button>
        <input
          ref={inputRef}
          value={value}
          placeholder={spark ? "记录闪念灵感，回车保存…" : "记下待办，回车保存…"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
        />
        {value.trim() && (
          <button
            onClick={submit}
            aria-label="添加"
            className="rounded-md p-1 text-muted-foreground hover:text-foreground"
          >
            <CornerDownLeft className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
