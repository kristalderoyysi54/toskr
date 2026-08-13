import { useState } from "react";
import { Lightbulb, Loader2, Sparkles } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { PillInput } from "@/components/ui/pill-input";
import { parseTaskInput } from "@/lib/ai";
import { cn } from "@/lib/utils";
import { useNotesStore } from "@/store/notesStore";

/**
 * 任务页顶部速记框：回车即存、保持焦点可连续录入。
 * 左侧 💡 切换「闪念模式」（内容进灵感区）；✨ 切换「AI 模式」——
 * 「下午3点提醒我开会」等自然语言由 AI 解析出到期/优先级后入库，
 * 失败自动回退普通任务（输入永不丢失）。💡 与 ✨ 互斥。
 */
export function TaskQuickAdd() {
  const [value, setValue] = useState("");
  const [spark, setSpark] = useState(false);
  const [aiMode, setAiMode] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const text = value.trim();
    if (!text || busy) return;
    if (aiMode) {
      setBusy(true);
      try {
        await parseTaskInput(text);
      } finally {
        setBusy(false);
      }
    } else {
      useNotesStore.getState().addTask(text, spark ? { kind: "spark" } : undefined);
    }
    setValue("");
  };

  return (
    <div className="mx-3 mb-1.5">
      <PillInput
        value={value}
        onChange={setValue}
        onSubmit={() => void submit()}
        disabled={busy}
        tone={spark ? "spark" : "default"}
        placeholder={
          busy
            ? "AI 解析中…"
            : aiMode
              ? "试试「下午3点提醒我开会」，回车交给 AI…"
              : spark
                ? "记录闪念灵感，回车保存…"
                : "记下待办，回车保存…"
        }
        leftSlot={
          <>
            <IconButton
              label={
                spark
                  ? "闪念模式：回车存为灵感（点击退出）"
                  : "点击进入闪念模式：随手记灵感"
              }
              size="2xs"
              pressed={spark}
              disabled={busy}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setSpark(!spark);
                if (!spark) setAiMode(false);
              }}
            >
              <Lightbulb
                className={cn(
                  "size-3.5",
                  spark ? "fill-violet-400 text-violet-500" : "text-muted-foreground"
                )}
              />
            </IconButton>
            <IconButton
              label={
                aiMode
                  ? "AI 模式：回车让 AI 解析时间与优先级（点击退出）"
                  : "点击进入 AI 模式：自然语言建任务"
              }
              size="2xs"
              pressed={aiMode}
              disabled={busy}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setAiMode(!aiMode);
                if (!aiMode) setSpark(false);
              }}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin text-amber-500" />
              ) : (
                <Sparkles
                  className={cn(
                    "size-3.5",
                    aiMode
                      ? "fill-amber-400 text-amber-500"
                      : "text-muted-foreground"
                  )}
                />
              )}
            </IconButton>
          </>
        }
      />
    </div>
  );
}
