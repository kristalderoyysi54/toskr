import { useId, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { customSensitiveFieldIssue } from "@/lib/delivery/customSensitiveFields";

export function CustomSensitiveFields({ fields, onChange, enabled }: {
  fields: string[];
  onChange: (fields: string[]) => void;
  enabled: boolean;
}) {
  const id = useId();
  const [input, setInput] = useState("");
  const [issue, setIssue] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      {!enabled && <p className="text-label text-warning">隐私检查已关闭，重新开启后这些字段才会参与检测。</p>}
      <form className="space-y-1" onSubmit={(event) => {
        event.preventDefault();
        const error = customSensitiveFieldIssue(input, fields);
        setIssue(error);
        if (error) return;
        onChange([...fields, input.trim()]);
        setInput("");
      }}>
        <label htmlFor={id} className="sr-only">敏感字段名</label>
        <div className="flex gap-1.5">
          <input id={id} value={input} autoComplete="off" spellCheck={false}
            placeholder="字段名，如 内部口令、partner_secret"
            aria-invalid={Boolean(issue)} aria-describedby={`${id}-hint`}
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2.5 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => { setInput(event.target.value); setIssue(null); }} />
          <Button type="submit">添加</Button>
        </div>
        {/* 格式规则只在填错时由校验提示给出，平时只留一句用途说明 */}
        <p id={`${id}-hint`} className={issue ? "text-label text-destructive" : "text-label text-muted-foreground"} role={issue ? "alert" : undefined}>
          {issue ?? "字段后面的值会按高风险内容检查，不需要填写真实密钥。"}
        </p>
      </form>
      {fields.length > 0 && (
        <ul className="space-y-1" aria-label="自定义敏感字段">
          {fields.map((field) => (
            <li key={field} className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1">
              <span className="min-w-0 flex-1 break-all text-body">{field}</span>
              <IconButton label={`删除敏感字段 ${field}`} size="xs" onClick={() => onChange(fields.filter((item) => item !== field))}>
                <Trash2 className="size-3.5" aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
