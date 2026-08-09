import { IconButton } from "toskr";

const ExpandIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </svg>
);

const PencilIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </svg>
);

const ArrowUpIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </svg>
);

const ArrowDownIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </svg>
);

const PinIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </svg>
);

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

/** 卡片悬浮工具条（NoteCard 场景）：size 默认 sm、surface 浮起底、tone default + danger 并列。 */
export const CardHoverActions = () => (
  <div
    style={{
      width: 240,
      borderRadius: 12,
      border: "1px solid rgba(0,0,0,0.08)",
      padding: "10px 10px 8px",
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}
  >
    <div style={{ fontSize: 13, lineHeight: 1.5, opacity: 0.85 }}>
      周四下午 3 点前把设计稿发到群里，记得带上尺寸标注。
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 2 }}>
      <IconButton label="预览" surface>
        <ExpandIcon />
      </IconButton>
      <IconButton label="编辑" surface>
        <PencilIcon />
      </IconButton>
      <IconButton label="删除" surface tone="danger">
        <TrashIcon />
      </IconButton>
    </div>
  </div>
);

/** 设置页列表行（SettingsView 场景）：size 2xs 密集排布，上移/下移 + 危险删除。 */
export const ListReorder = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      width: 260,
      padding: "6px 10px",
      borderRadius: 8,
      border: "1px solid rgba(0,0,0,0.08)",
    }}
  >
    <span style={{ fontSize: 13, flex: 1 }}>产品设计模板</span>
    <div style={{ display: "flex", gap: 2 }}>
      <IconButton label="上移" size="2xs">
        <ArrowUpIcon />
      </IconButton>
      <IconButton label="下移" size="2xs">
        <ArrowDownIcon />
      </IconButton>
      <IconButton label="删除模板" size="2xs" tone="danger">
        <TrashIcon />
      </IconButton>
    </div>
  </div>
);

/** 头部工具栏按下态（App.tsx 场景）：同一图标 pressed=false/true 对照，size sm 与 xs。 */
export const PressedToggle = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
    <div style={{ display: "flex", gap: 4 }}>
      <IconButton label="面板置顶">
        <PinIcon />
      </IconButton>
      <IconButton label="取消置顶" pressed>
        <PinIcon />
      </IconButton>
    </div>
    <div style={{ display: "flex", gap: 4 }}>
      <IconButton label="搜索" size="xs">
        <SearchIcon />
      </IconButton>
      <IconButton label="收起搜索" size="xs" pressed>
        <SearchIcon />
      </IconButton>
    </div>
  </div>
);
