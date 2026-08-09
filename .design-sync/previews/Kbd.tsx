import { Button, Kbd } from "toskr";

/** 默认键帽态：嵌在引导文案句子里（App.tsx 首屏引导原文）。 */
export const InSentence = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 300, fontSize: 13, lineHeight: 1.6 }}>
    <p style={{ margin: 0 }}>
      去任意应用选中一段文字，连按两次 <Kbd>⇧ Shift</Kbd> 捕获
    </p>
    <p style={{ margin: 0 }}>
      勾选卡片，按 <Kbd>⌘⏎</Kbd> 发送回你的 AI 对话
    </p>
  </div>
);

/** inline 裸字态：嵌在按钮标签内（SelectionBar「发送到对话」原样式）。 */
export const InlineInButton = () => (
  <Button size="xs">
    发送到对话
    <Kbd inline className="ml-0.5 text-[9px]">⌘⏎</Kbd>
  </Button>
);

/** inline 裸字态：菜单行尾快捷键提示（TextSelectionToolbar 格式菜单原样式）。 */
export const InlineMenuRow = () => (
  <div style={{ width: 180, borderRadius: 10, border: "1px solid rgba(0,0,0,0.08)", padding: 4 }}>
    {[
      { label: "加粗", shortcut: "⌘B", active: true },
      { label: "斜体", shortcut: "⌘I" },
      { label: "插入链接", shortcut: "⌘K" },
    ].map((row) => (
      <div
        key={row.label}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          borderRadius: 6,
          background: row.active ? "rgba(0,0,0,0.05)" : "transparent",
          fontSize: 13,
        }}
      >
        <span style={{ flex: 1 }}>{row.label}</span>
        <Kbd inline>{row.shortcut}</Kbd>
      </div>
    ))}
  </div>
);
