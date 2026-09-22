import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { aiErrorTip, aiReady } from "@/lib/aiClient";
import { generatePromptTemplate } from "@/lib/promptTemplateAi";
import { tip } from "@/lib/tip";
import { isDataOperationLocked, useDataOperationStore } from "@/store/dataOperationStore";
import type { Settings } from "@/store/notesStore";

const IDEAS = [
  { label: "排查问题", instruction: "把报错整理成给开发者的排查请求，包含现象、复现步骤和预期结果；缺失的信息列为待确认，不要编造。" },
  { label: "整理周报", instruction: "将零散工作记录整理成简短周报，分为已完成、阻塞问题和下一步，保留关键事实。" },
  { label: "润色消息", instruction: "将草稿润色成适合发给同事的消息，语气自然礼貌、简洁直接，保留原意和明确的行动要求。" },
];

type Draft = { label: string; text: string };

export function PromptTemplateAssistant({
  label,
  text,
  settings,
  onApply,
}: {
  label: string;
  text: string;
  settings: Pick<Settings, "aiEnabled" | "aiBaseUrl" | "aiModel">;
  onApply: (draft: Draft) => void;
}) {
  const id = useId();
  const [instruction, setInstruction] = useState("");
  const [candidate, setCandidate] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const locked = useDataOperationStore((state) => state.locked);
  const ready = aiReady(settings);

  useEffect(() => () => {
    const active = request.current;
    request.current = null;
    active?.abort();
  }, []);

  const cancel = () => {
    const active = request.current;
    request.current = null;
    active?.abort();
    setBusy(false);
  };

  useEffect(() => {
    if (!locked) return;
    const active = request.current;
    request.current = null;
    active?.abort();
    setBusy(false);
    setCandidate(null);
  }, [locked]);

  const generate = async () => {
    if (!ready || isDataOperationLocked() || !instruction.trim() || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const result = await generatePromptTemplate({
        instruction,
        current: candidate ?? (label.trim() || text.trim() ? { label, text } : undefined),
        settings,
        signal: controller.signal,
      });
      if (request.current !== controller) return;
      setCandidate(result);
      setInstruction("");
    } catch (error) {
      if (request.current === controller) {
        tip("warn", error instanceof Error && error.message ? error.message : aiErrorTip(error));
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <section aria-label="AI 模板助手" className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
      <div className="space-y-1">
        <p className="text-body font-medium">{candidate ? "继续调整这份建议" : "描述你的想法"}</p>
        <p className="text-label text-muted-foreground">
          {ready ? `使用当前 AI · ${settings.aiModel.trim()}` : "请先在“更多功能 → AI 智能”中配置并启用，或直接手动编辑。"}
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-instruction`} className="block text-label text-muted-foreground">
          {candidate ? "想怎样调整？" : "用途、语气和输出格式"}
        </label>
        <textarea
          id={`${id}-instruction`}
          value={instruction}
          maxLength={2000}
          rows={3}
          disabled={busy}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder={candidate ? "例如：更简短，改成三条要点" : "例如：把客户反馈整理成开发需求，列出问题、期望结果和验收条件"}
          className="w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-body leading-relaxed outline-none focus:border-primary/50 disabled:opacity-60"
        />
        {!candidate && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-label text-muted-foreground">试试：</span>
            {IDEAS.map((idea) => (
              <Button key={idea.label} size="xs" disabled={busy} onClick={() => setInstruction(idea.instruction)}>{idea.label}</Button>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!ready || locked || !instruction.trim() || busy} onClick={() => void generate()}>
          {busy ? "正在生成…" : candidate || text.trim() ? "生成调整建议" : "生成模板建议"}
        </Button>
        {busy && <Button size="sm" onClick={cancel}>取消生成</Button>}
        <span className="text-micro text-muted-foreground">仅提交想法与当前模板；示例材料留在本地。</span>
      </div>
      {candidate && (
        <div className="space-y-2 border-t border-border pt-3">
          <p role="status" className="text-label text-muted-foreground">建议已生成，采用到编辑区后可继续修改和预览。</p>
          <p className="break-words text-title font-medium">{candidate.label}</p>
          <pre aria-label="AI 模板建议" className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-sans text-body leading-relaxed">{candidate.text}</pre>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || locked} onClick={() => { if (!isDataOperationLocked()) onApply(candidate); }}>采用到编辑区</Button>
            <Button size="sm" disabled={busy} onClick={() => { setCandidate(null); setInstruction(""); }}>放弃建议</Button>
          </div>
        </div>
      )}
    </section>
  );
}
