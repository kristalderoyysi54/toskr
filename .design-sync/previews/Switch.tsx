import { Switch } from "toskr";

/** 设置页开关列表（SettingsView 原文案）：defaultChecked 开/关混列。 */
export const SettingsToggles = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Switch aria-label="剪贴板历史" defaultChecked />
      <span style={{ fontSize: 13 }}>剪贴板历史</span>
    </label>
    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Switch aria-label="面板置顶" />
      <span style={{ fontSize: 13 }}>面板置顶</span>
    </label>
    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Switch aria-label="隐身模式" />
      <span style={{ fontSize: 13 }}>隐身模式</span>
    </label>
    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Switch aria-label="开机启动" defaultChecked />
      <span style={{ fontSize: 13 }}>开机启动</span>
    </label>
  </div>
);

/** 尺寸对照：default 标准列表 vs sm 紧凑列表。 */
export const Sizes = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Switch aria-label="标准列表" defaultChecked />
      <span style={{ fontSize: 13 }}>标准列表</span>
    </label>
    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Switch aria-label="紧凑列表" size="sm" defaultChecked />
      <span style={{ fontSize: 13 }}>紧凑列表</span>
    </label>
  </div>
);

/** 禁用态：开/关各一，标签随之弱化。 */
export const Disabled = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
    <label style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.5 }}>
      <Switch aria-label="开机启动" defaultChecked disabled />
      <span style={{ fontSize: 13 }}>开机启动</span>
    </label>
    <label style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.5 }}>
      <Switch aria-label="自动安装更新" disabled />
      <span style={{ fontSize: 13 }}>自动安装更新</span>
    </label>
  </div>
);
