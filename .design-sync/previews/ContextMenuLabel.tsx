import { ContextMenuLabel } from "toskr";

const rowStyle = {
  padding: "6px 8px",
  fontSize: 13,
  color: "#1f2937",
  borderRadius: 6,
};

/** 分组小标题：置于模拟菜单面板中，对比下方普通菜单行的角色差异。 */
export const GroupHeading = () => (
  <div
    style={{
      width: 180,
      padding: 4,
      background: "#fff",
      borderRadius: 10,
      boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
    }}
  >
    <ContextMenuLabel>卡片操作</ContextMenuLabel>
    <div style={rowStyle}>编辑内容</div>
    <div style={rowStyle}>复制文本</div>
  </div>
);
