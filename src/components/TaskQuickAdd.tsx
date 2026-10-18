import { useEffect, useState } from "react";
import { Lightbulb, Loader2, Repeat, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { PillInput } from "@/components/ui/pill-input";
import { commitTaskDraft, parseTaskDraft, type TaskDraft } from "@/lib/ai";
import { dueBadgeLabel, PRIORITY_LABEL } from "@/lib/tasks";
import { recurrenceLabel } from "@/lib/taskRecurrence";
import { cn } from "@/lib/utils";
import { TASK_INBOX_ID, useNotesStore, type TaskPriority } from "@/store/notesStore";

const PRIORITY_NEXT: Record<TaskPriority, TaskPriority> = {
  none: "low",
  low: "mid",
  mid: "high",
  high: "none",
};

/**
 * 任务页顶部速记框：回车即存、保持焦点可连续录入。
 * 左侧 💡 切换「闪念模式」（内容进灵感区）；✨ 切换「AI 模式」——
 * 「下午3点提醒我开会」等自然语言由 AI 解析出到期/优先级/重复/分组，
 * 先在下方预览确认（回车确认、Esc 回到编辑），失败自动回退普通任务（输入永不丢失）。
 * 💡 与 ✨ 互斥。
 */
export function TaskQuickAdd() {
  const [value, setValue] = useState("");
  const [spark, setSpark] = useState(false);
  const [aiMode, setAiMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<TaskDraft | null>(null);

  const submit = async () => {
    const text = value.trim();
    if (!text || busy) return;
    if (aiMode) {
      setBusy(true);
      try {
        const parsed = await parseTaskDraft(text);
        if (parsed) setDraft(parsed);
      } finally {
        setBusy(false);
      }
    } else {
      useNotesStore.getState().addTask(text, spark ? { kind: "spark" } : undefined);
    }
    setValue("");
  };

  const confirm = () => {
    if (draft) commitTaskDraft(draft);
    setDraft(null);
  };
  const backToEdit = () => {
    if (draft) setValue(draft.original);
    setDraft(null);
  };
  const saveOriginal = () => {
    if (draft) useNotesStore.getState().addTask(draft.original);
    setDraft(null);
  };

  // 预览期间临时接管回车/Esc（WKWebView 焦点不可靠，按约定走 window capture）
  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        confirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        backToEdit();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  return (
    <div className="mx-3 mb-1.5 flex flex-col gap-1.5">
      <PillInput
        value={value}
        onChange={setValue}
        onSubmit={() => void submit()}
        disabled={busy || !!draft}
        tone={spark ? "spark" : "default"}
        placeholder={
          busy
            ? "AI 解析中…"
            : draft
              ? "确认下方解析结果，或按 Esc 回到编辑"
              : aiMode
                ? "试试「每周一10点交周报，放工作组」，回车交给 AI…"
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
                  ? "AI 模式：回车让 AI 解析时间、重复与分组（点击退出）"
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
      {draft && (
        <DraftPreview
          draft={draft}
          onChange={setDraft}
          onConfirm={confirm}
          onSaveOriginal={saveOriginal}
        />
      )}
    </div>
  );
}

/** AI 解析结果预览：标题可改；到期/重复/检查项可去掉，优先级与分组点按循环。 */
function DraftPreview({
  draft,
  onChange,
  onConfirm,
  onSaveOriginal,
}: {
  draft: TaskDraft;
  onChange: (d: TaskDraft) => void;
  onConfirm: () => void;
  onSaveOriginal: () => void;
}) {
  const sections = useNotesStore((s) => s.taskSections);
  const sectionIndex = Math.max(
    0,
    sections.findIndex((s) => s.id === (draft.sectionId ?? TASK_INBOX_ID))
  );
  const section = sections[sectionIndex];
  const now = Date.now();
  return (
    <div className="surface-inset flex flex-col gap-1.5 rounded-xl p-2">
      <p className="px-0.5 text-micro text-muted-foreground">AI 解析结果 · 回车确认，Esc 回到编辑</p>
      <input
        value={draft.title}
        onChange={(e) => onChange({ ...draft, title: e.target.value })}
        aria-label="任务标题"
        className="rounded-md bg-transparent px-1 py-0.5 text-body font-medium outline-none focus:ring-1 focus:ring-primary/40"
      />
      <div className="flex flex-wrap gap-1">
        {draft.dueAtMs !== null && (
          <DraftChip onRemove={() => onChange({ ...draft, dueAtMs: null })} removeLabel="去掉到期时间">
            {dueBadgeLabel(draft.dueAtMs, now)}
          </DraftChip>
        )}
        {draft.recurrence && (
          <DraftChip onRemove={() => onChange({ ...draft, recurrence: null })} removeLabel="去掉重复">
            <Repeat className="size-2.5" />
            {recurrenceLabel(draft.recurrence, draft.dueAtMs)}
          </DraftChip>
        )}
        <DraftChip
          onClick={() => onChange({ ...draft, priority: PRIORITY_NEXT[draft.priority] })}
          title="点击切换优先级"
        >
          优先级 {draft.priority === "none" ? "无" : PRIORITY_LABEL[draft.priority]}
        </DraftChip>
        {sections.length > 1 && section && (
          <DraftChip
            onClick={() => {
              const next = sections[(sectionIndex + 1) % sections.length];
              onChange({ ...draft, sectionId: next.id === TASK_INBOX_ID ? null : next.id });
            }}
            title="点击切换分组"
          >
            {section.name}
          </DraftChip>
        )}
        {draft.checklist.length > 0 && (
          <DraftChip onRemove={() => onChange({ ...draft, checklist: [] })} removeLabel="去掉检查项">
            {draft.checklist.length} 项检查
          </DraftChip>
        )}
      </div>
      <div className="flex justify-end gap-1.5">
        <Button size="xs" onClick={onSaveOriginal}>
          按原文存为普通任务
        </Button>
        <Button size="xs" onClick={onConfirm}>
          确认 ⏎
        </Button>
      </div>
    </div>
  );
}

function DraftChip({
  children,
  onClick,
  onRemove,
  removeLabel,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
  title?: string;
}) {
  return (
    <span className="flex items-center gap-0.5 rounded-full border border-primary/40 bg-primary/10 py-0.5 pl-2 pr-1 text-micro text-primary">
      {onClick ? (
        <button type="button" onClick={onClick} title={title} className="flex items-center gap-0.5 outline-none focus-visible:underline">
          {children}
        </button>
      ) : (
        <span className="flex items-center gap-0.5">{children}</span>
      )}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="rounded-full p-0.5 outline-none hover:bg-primary/15 focus-visible:ring-1 focus-visible:ring-primary"
        >
          <X className="size-2.5" />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  );
}
