import { useState } from "react";
import { Lightbulb } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { PillInput } from "@/components/ui/pill-input";
import { cn } from "@/lib/utils";
import { useNotesStore } from "@/store/notesStore";

/**
 * 任务页顶部速记框：回车即存、保持焦点可连续录入。
 * 左侧 💡 可点击切换「闪念模式」——录入的内容进灵感区（紫色标识）。
 */
export function TaskQuickAdd() {
  const [value, setValue] = useState("");
  const [spark, setSpark] = useState(false);

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    useNotesStore.getState().addTask(text, spark ? { kind: "spark" } : undefined);
    setValue("");
  };

  return (
    <div className="mx-3 mb-1.5">
      <PillInput
        value={value}
        onChange={setValue}
        onSubmit={submit}
        tone={spark ? "spark" : "default"}
        placeholder={spark ? "记录闪念灵感，回车保存…" : "记下待办，回车保存…"}
        leftSlot={
          <IconButton
            label={spark ? "闪念模式：回车存为灵感（点击退出）" : "点击进入闪念模式：随手记灵感"}
            size="2xs"
            pressed={spark}
            // 点击不偷走输入框焦点：WKWebView 下 button 点击本不给焦点，
            // 但 pnpm dev 走普通浏览器会，这里显式压制以保持连续录入
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setSpark(!spark)}
          >
            <Lightbulb
              className={cn(
                "size-3.5",
                spark ? "fill-violet-400 text-violet-500" : "text-muted-foreground/60"
              )}
            />
          </IconButton>
        }
      />
    </div>
  );
}
