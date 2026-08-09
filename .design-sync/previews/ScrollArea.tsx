import { ScrollArea, ScrollBar } from "toskr";

const rows = [
  "周会纪要：确认 v0.14 发布节奏，优先修复剪贴板监听偶发丢字问题",
  "灵感：菜单栏图标可加未读数角标，弱化未读心智负担",
  "会议室 B 下午 3 点被占用，改约 D 座 4 层茶水间旁小间",
  "读者反馈：拖拽分组排序后偶尔卡片顺序未落盘，需要复现",
  "报销单已提交，等财务审批，预计周五到账",
  "设计稿：卡片描边清理后与深色模式对比度需要再核一遍",
  "剪贴板默认开启后，用户教育文案要在设置页补充说明",
  "任务：给「发送到」菜单加最近使用应用置顶",
  "客户来信：希望增加导出为 Markdown 的选项",
  "周五前完成 dmg 签名验证脚本的自动化补丁",
  "全屏 Space 面板可见性已在 QA 清单里补充回归项",
  "待办：把撤销气泡的悬停态延迟从 300ms 调到 200ms",
];

const tags = [
  "全部",
  "收集箱",
  "工作",
  "灵感",
  "待复核",
  "已归档",
  "周报草稿",
  "客户反馈",
  "设计评审",
  "本周待办",
];

/** 竖向长列表：显式高度约束触发滚动，type="always" 强制滚动条常显。 */
export const VerticalList = () => (
  <ScrollArea
    type="always"
    style={{
      width: 260,
      height: 160,
      border: "1px solid rgba(0,0,0,0.12)",
      borderRadius: 10,
      background: "#fff",
    }}
  >
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map((text, i) => (
        <div
          key={text}
          style={{
            padding: "8px 12px",
            fontSize: 13,
            lineHeight: 1.5,
            color: "#1f2937",
            borderBottom:
              i < rows.length - 1 ? "1px solid rgba(0,0,0,0.06)" : "none",
          }}
        >
          {text}
        </div>
      ))}
    </div>
  </ScrollArea>
);

/** 横向分组胶囊行：宽内容超出容器宽度，显式引入 ScrollBar 补横向轨道。 */
export const HorizontalTags = () => (
  <ScrollArea
    type="always"
    style={{
      width: 260,
      height: 80,
      border: "1px solid rgba(0,0,0,0.12)",
      borderRadius: 10,
      background: "#fff",
    }}
  >
    <div style={{ display: "flex", gap: 8, padding: 12, width: "max-content" }}>
      {tags.map((tag) => (
        <span
          key={tag}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            background: "rgba(0,0,0,0.06)",
            fontSize: 12,
            color: "#374151",
            whiteSpace: "nowrap",
          }}
        >
          {tag}
        </span>
      ))}
    </div>
    <ScrollBar orientation="horizontal" />
  </ScrollArea>
);
