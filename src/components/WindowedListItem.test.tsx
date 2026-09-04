import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WindowedListItem } from "@/components/WindowedListItem";
import { shouldResetPlaceholderHeight } from "@/components/windowedListHeight";

describe("WindowedListItem", () => {
  it("挂载的条目按内容自然高度，不被 estimatedHeight 撑出留白", () => {
    // 短消息卡场景：estimatedHeight 远大于真实内容高度。若把它当 minHeight，
    // 卡片会被撑到 160px，下方留大片空白（消息页红框空白卡的成因）。
    const html = renderToStaticMarkup(
      <WindowedListItem itemId="message:1" estimatedHeight={160} eager>
        <article data-testid="card">短消息</article>
      </WindowedListItem>
    );

    // 挂载：真实内容直出
    expect(html).toContain('data-testid="card"');
    // 关键回归断言：挂载容器不得强加 estimatedHeight 作为 minHeight
    expect(html).not.toMatch(/min-height:\s*160/);
  });

  it("离开渲染窗口时保留最后实测高度，避免滚动锚定反复校正", () => {
    expect(shouldResetPlaceholderHeight(160, 160, false)).toBe(false);
  });

  it("屏外形态的估算高度真的变化时才允许重置", () => {
    expect(shouldResetPlaceholderHeight(160, 112, false)).toBe(true);
    expect(shouldResetPlaceholderHeight(160, 112, true)).toBe(false);
  });
});
