import { ContextMenuShortcut } from "toskr";

/** 行尾快捷键提示：模拟菜单行内 ml-auto 靠右角色。 */
export const TrailingShortcut = () => (
  <div
    style={{
      width: 180,
      padding: 4,
      background: "#fff",
      borderRadius: 10,
      boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "6px 8px",
        fontSize: 13,
        color: "#1f2937",
        borderRadius: 6,
        background: "rgba(0,0,0,0.05)",
      }}
    >
      复制文本
      <ContextMenuShortcut>⌘C</ContextMenuShortcut>
    </div>
  </div>
);
