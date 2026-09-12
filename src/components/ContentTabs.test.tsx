import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ContentTabPanels, ContentTabs } from "./ContentTabs";

import { handleContentTabKeyDown } from "@/lib/contentTabsKeyboard";

function keyboard(key: string) {
  const buttons = [0, 1, 2].map(() => ({ focus: vi.fn() }));
  const event = {
    key, altKey: false, ctrlKey: false, metaKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    currentTarget: { closest: () => ({ querySelectorAll: () => buttons }) } as unknown as HTMLButtonElement,
  };
  return { event, buttons };
}

const values = ["notes", "messages", "secret"] as const;
describe("内容标签键盘", () => {
  it.each([
    ["ArrowRight", 0, 1], ["ArrowRight", 2, 0],
    ["ArrowLeft", 0, 2], ["ArrowLeft", 2, 1],
    ["Home", 2, 0], ["End", 0, 2],
  ] as const)("%s 从 %i 切换并聚焦 %i", (key, from, to) => {
    const { event, buttons } = keyboard(key);
    const select = vi.fn();
    handleContentTabKeyDown(event, values, from, select);
    expect(select).toHaveBeenCalledWith(values[to]);
    expect(buttons[to].focus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("Tab 可以离开标签组，组合快捷键保持原行为", () => {
    const select = vi.fn();
    for (const key of ["Tab", "Enter", "Escape", "ArrowDown"]) {
      const { event, buttons } = keyboard(key);
      handleContentTabKeyDown(event, values, 0, select);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(buttons.some((button) => button.focus.mock.calls.length)).toBe(false);
    }
    const { event } = keyboard("ArrowRight");
    event.metaKey = true;
    handleContentTabKeyDown(event, values, 0, select);
    expect(select).not.toHaveBeenCalled();
  });

  it("隐藏内容域不参与键盘循环", () => {
    const { event, buttons } = keyboard("ArrowRight");
    const select = vi.fn();
    handleContentTabKeyDown(event, ["notes", "secret"], 0, select);
    expect(select).toHaveBeenCalledWith("secret");
    expect(buttons[1].focus).toHaveBeenCalledOnce();
  });

  it("可见页签有唯一 Tab 入口及面板引用", () => {
    const html = renderToStaticMarkup(<ContentTabs />);
    expect(html).toContain('id="content-tab-notes"');
    expect(html).toContain('aria-controls="content-panel-notes"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });

  it("每个启用页签都有对应面板，仅活动面板挂载内容", () => {
    const html = renderToStaticMarkup(
      <ContentTabPanels active="messages" messagesEnabled secretEnabled>
        <button>消息内容</button>
      </ContentTabPanels>
    );
    for (const value of values) {
      expect(html).toContain(`id="content-panel-${value}"`);
      expect(html).toContain(`aria-labelledby="content-tab-${value}"`);
    }
    expect(html.match(/hidden=""/g)).toHaveLength(2);
    expect(html.match(/消息内容/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });
});
