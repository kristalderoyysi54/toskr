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
      <p className="text-label text-muted-foreground">
        只添加字段名，例如「内部口令」。其后的值会作为高风险内容检查，适用于文字和图片；不需要填写真实密钥。
      </p>
      {!enabled && <p className="text-label text-warning">隐私检查已关闭，重新启用后这些字段才会参与检测。</p>}
      <form className="space-y-1" onSubmit={(event) => {
        event.preventDefault();
        const error = customSensitiveFieldIssue(input, fields);
        setIssue(error);
        if (error) return;
        onChange([...fields, input.trim()]);
        setInput("");
      }}>
        <label htmlFor={id} className="text-label font-medium">敏感字段名</label>
        <div className="flex gap-1.5">
          <input id={id} value={input} autoComplete="off" spellCheck={false}
            placeholder="例如：内部口令、partner_secret"
            aria-invalid={Boolean(issue)} aria-describedby={`${id}-hint`}
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => { setInput(event.target.value); setIssue(null); }} />
          <Button type="submit">添加</Button>
        </div>
        <p id={`${id}-hint`} className={issue ? "text-label text-destructive" : "text-micro text-muted-foreground"} role={issue ? "alert" : undefined}>
          {issue ?? "英文不区分大小写；支持汉字、字母、数字、_ . -，不含空格。最多 32 个。"}
        </p>
      </form>
      {fields.length ? (
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
      ) : <p className="text-label text-muted-foreground">尚未添加，内置密钥检测仍会正常运行。</p>}
      <p className="text-micro text-muted-foreground">匹配字段后的冒号、等号或空白分列值。已打开的发送预检需要重新检查。</p>
    </div>
  );
}
