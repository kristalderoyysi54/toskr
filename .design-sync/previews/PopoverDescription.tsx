import { PopoverDescription } from "toskr";

const Panel = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      width: 280,
      padding: 12,
      border: "1px solid rgba(0,0,0,0.08)",
      borderRadius: 10,
      background: "#fff",
    }}
  >
    {children}
  </div>
);

/** 单独渲染：muted 说明文字。 */
export const Standalone = () => (
  <Panel>
    <PopoverDescription>
      清空后卡片将无法恢复，请谨慎操作。
    </PopoverDescription>
  </Panel>
);
