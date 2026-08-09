import { EmptyState } from "toskr";

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

const InboxIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);

export const Full = () => (
  <EmptyState
    icon={<InboxIcon />}
    title="暂无卡片"
    hint="双击 ⇧ 划词捕获，或开启剪贴板收集自动入库"
  />
);

export const SearchMiss = () => (
  <EmptyState icon={<SearchIcon />} title="没有匹配「设计稿」的卡片" />
);

export const Inline = () => (
  <div style={{ width: 260, border: "1px dashed rgba(0,0,0,0.15)", borderRadius: 8 }}>
    <EmptyState variant="inline" title="此分组为空" />
  </div>
);
