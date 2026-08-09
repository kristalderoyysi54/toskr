import { PopoverDescription, PopoverHeader, PopoverTitle } from "toskr";

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

/** Content 内的标题区容器：竖排 gap-0.5，标题+说明成组。 */
export const WithTitleAndDescription = () => (
  <Panel>
    <PopoverHeader>
      <PopoverTitle>自动清理已发送卡片</PopoverTitle>
      <PopoverDescription>
        超过 30 天未编辑的已发送卡片会移入回收站，30 天后彻底删除。
      </PopoverDescription>
    </PopoverHeader>
  </Panel>
);
