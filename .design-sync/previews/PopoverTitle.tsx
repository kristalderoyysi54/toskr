import { PopoverTitle } from "toskr";

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

/** 单独渲染：font-medium 小标题字重。 */
export const Standalone = () => (
  <Panel>
    <PopoverTitle>清空回收站</PopoverTitle>
  </Panel>
);
