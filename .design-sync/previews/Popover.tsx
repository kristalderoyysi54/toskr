import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "toskr";

const Row = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{label}</span>
    <div
      style={{
        height: 28,
        display: "flex",
        alignItems: "center",
        padding: "0 8px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        fontSize: 12,
        color: "var(--foreground)",
      }}
    >
      {value}
    </div>
  </div>
);

/** AI 设置页「API Key 说明」浮层：标题+说明 + 两行只读表单预览。
 *  trigger 用原生 button（非 DS 的 Button——Button 未 forwardRef，
 *  作为 asChild 子元素时 Radix PopperAnchor 拿不到 ref，定位失效，
 *  见 wave1-b 学习文件）。 */
export const Open = () => {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 8 }}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            style={{
              height: 28,
              padding: "0 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--background)",
              fontSize: 12,
              color: "var(--foreground)",
              cursor: "pointer",
            }}
          >
            API Key 说明
          </button>
        </PopoverTrigger>
        <PopoverContent>
          <PopoverHeader>
            <PopoverTitle>关于 API Key</PopoverTitle>
            <PopoverDescription>
              仅保存在本机数据文件，随请求发往下方 Base URL，不经过 Toskr 服务器。
            </PopoverDescription>
          </PopoverHeader>
          <Row label="Base URL" value="https://api.deepseek.com" />
          <Row label="API Key" value="sk-••••••••••••3f2a" />
        </PopoverContent>
      </Popover>
    </div>
  );
};
