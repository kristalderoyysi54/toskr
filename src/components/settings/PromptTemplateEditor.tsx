import { useId, useState } from "react";

import { SimpleSelect } from "@/components/SimpleSelect";
import { Button } from "@/components/ui/button";
import { applyPromptTemplate } from "@/lib/format";

const EXAMPLE_MATERIAL = "保存设置后，重新打开窗口仍显示旧值。希望关闭再打开后保留新设置。";

export function PromptTemplateEditor({
  label,
  text,
  groupId,
  groupOptions,
  onLabelChange,
  onTextChange,
  onGroupChange,
  onSave,
  onCancel,
  previewOpen,
  onPreviewOpenChange,
}: {
  label: string;
  text: string;
  groupId: string;
  groupOptions: { value: string; label: string }[];
  onLabelChange: (label: string) => void;
  onTextChange: (text: string) => void;
  onGroupChange: (groupId: string) => void;
  onSave: () => void;
  onCancel?: () => void;
  previewOpen?: boolean;
  onPreviewOpenChange?: (open: boolean) => void;
}) {
  const id = useId();
  const [material, setMaterial] = useState("");
  const preview = applyPromptTemplate(text, material || EXAMPLE_MATERIAL);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor={`${id}-name`} className="block text-label text-muted-foreground">模板名</label>
          <input
            id={`${id}-name`}
            value={label}
            onChange={(event) => onLabelChange(event.target.value)}
            className="h-8 w-full rounded-lg border border-border bg-transparent px-2 text-body outline-none focus:border-primary/50"
          />
        </div>
        <div className="w-32 shrink-0 space-y-1">
          <p className="text-label text-muted-foreground">提示词组</p>
          <SimpleSelect
            ariaLabel={onCancel ? "模板所属提示词组" : "新模板所属提示词组"}
            align="end"
            value={groupId}
            options={groupOptions}
            onChange={onGroupChange}
          />
        </div>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-text`} className="block text-label text-muted-foreground">模板内容</label>
        <textarea
          id={`${id}-text`}
          value={text}
          rows={4}
          autoFocus={Boolean(onCancel)}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.metaKey) {
              event.preventDefault();
              onSave();
            } else if (event.key === "Escape") {
              onCancel?.();
            }
          }}
          placeholder="模板内容，写 {内容} 指定插入位置，支持多行"
          className="w-full resize-y rounded-lg border border-border bg-transparent px-2 py-1.5 text-body leading-relaxed outline-none focus:border-primary/50"
        />
      </div>
      <details
        data-settings-search="试用预览"
        open={previewOpen}
        onToggle={(event) => onPreviewOpenChange?.(event.currentTarget.open)}
        className="rounded-lg border border-border/60 px-3 py-2"
      >
        <summary className="cursor-pointer text-body font-medium text-muted-foreground">试用预览</summary>
        <div className="mt-3 space-y-2">
          <p className="text-label text-muted-foreground">仅在本地组合文本，不调用 AI 或发送。留空时使用下面的示例。</p>
          <label htmlFor={`${id}-material`} className="block text-label text-muted-foreground">示例材料</label>
          <textarea
            id={`${id}-material`}
            value={material}
            rows={3}
            onChange={(event) => setMaterial(event.target.value)}
            placeholder={EXAMPLE_MATERIAL}
            className="w-full resize-y rounded-lg border border-border bg-transparent px-2 py-1.5 text-body leading-relaxed outline-none focus:border-primary/50"
          />
          <p className="text-label font-medium text-muted-foreground">组合全文</p>
          <pre aria-label="组合全文" className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-sans text-body leading-relaxed">
            {preview}
          </pre>
        </div>
      </details>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!label.trim() || !text.trim()} onClick={onSave} title="保存（⌘⏎）">
          {onCancel ? "保存" : "添加模板"}
        </Button>
        {onCancel && <Button size="sm" onClick={onCancel} title="取消（Esc）">取消编辑</Button>}
      </div>
    </div>
  );
}
