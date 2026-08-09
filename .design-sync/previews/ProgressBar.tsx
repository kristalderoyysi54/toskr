import { ProgressBar } from "toskr";

/** 更新下载进度（SettingsView 原样式）：tactile 光泽态 + 行内百分比说明。 */
export const DownloadProgress = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <ProgressBar value={65} tactile className="w-24" />
    <span style={{ fontSize: 12, opacity: 0.6 }}>65% · 完成后自动重启</span>
  </div>
);

/** 三档进度堆叠：value 30/65/100，tactile 光泽态贯穿全程。 */
export const Stages = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 200 }}>
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, opacity: 0.6 }}>下载中 30%</span>
      <ProgressBar value={30} tactile className="w-full" />
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, opacity: 0.6 }}>处理中 65%</span>
      <ProgressBar value={65} tactile className="w-full" />
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, opacity: 0.6 }}>已完成 100%</span>
      <ProgressBar value={100} tactile className="w-full" />
    </div>
  </div>
);

/** 本地备份进度：非 tactile 默认态，扁平填充对照上面两卡的光泽态。 */
export const Backup = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 220 }}>
    <span style={{ fontSize: 12 }}>正在导出本地备份…</span>
    <ProgressBar value={45} className="w-full" />
  </div>
);
