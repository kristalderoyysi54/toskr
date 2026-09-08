import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SimpleMenu } from "./SimpleMenu";
import { handleSimpleMenuEscape, handleSimpleMenuKeyDown } from "@/lib/menuKeyboard";

describe("SimpleMenu", () => {
  it("marks selection-dependent menus so outside pointer handling keeps the selection", () => {
    const html = renderToStaticMarkup(
      <SimpleMenu
        preserveTextSelection
        trigger={({ toggle }) => <button onClick={toggle}>处理</button>}
      >
        {() => null}
      </SimpleMenu>
    );

    expect(html).toContain('data-preserve-text-selection="true"');
  });

  it("菜单隔离激活和卡片快捷键，但保留按钮的原生默认动作", () => {
    for (const key of ["Enter", " ", "ArrowLeft", "ArrowRight", "x", "d", "p", "Backspace"]) {
      const event = {
        key,
        stopPropagation: vi.fn(),
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLDivElement>;
      handleSimpleMenuKeyDown(event);

      expect(event.stopPropagation).toHaveBeenCalledOnce();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("方向键只移动菜单项焦点，不传给列表导航", () => {
    const items = [0, 1, 2].map(() => ({ focus: vi.fn() }));
    for (const [key, active, expected] of [
      ["ArrowDown", 0, 1], ["ArrowUp", 0, 2], ["Home", 2, 0], ["End", 0, 2],
    ] as const) {
      items.forEach((item) => item.focus.mockClear());
      const event = {
        key,
        currentTarget: {
          querySelectorAll: () => items,
          ownerDocument: { activeElement: items[active] },
        },
        stopPropagation: vi.fn(),
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLDivElement>;
      handleSimpleMenuKeyDown(event);

      expect(items[expected].focus).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it("Escape 在捕获阶段关闭并恢复触发按钮，其他键不关闭菜单", () => {
    const closeAndRestoreFocus = vi.fn();
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    handleSimpleMenuEscape(event, closeAndRestoreFocus);

    expect(closeAndRestoreFocus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    handleSimpleMenuEscape({ key: "Enter" } as KeyboardEvent, closeAndRestoreFocus);
    expect(closeAndRestoreFocus).toHaveBeenCalledOnce();
  });
});

it("announces toggle and exclusive choices with their actual checked state", async () => {
  const { SimpleMenuItem } = await import("./SimpleMenu");
  const toggle = renderToStaticMarkup(<SimpleMenuItem checked onClick={() => {}}>保持展开</SimpleMenuItem>);
  const radio = renderToStaticMarkup(<SimpleMenuItem checked={false} radio onClick={() => {}}>屏幕右侧</SimpleMenuItem>);
  expect(toggle).toContain('role="menuitemcheckbox"');
  expect(toggle).toContain('aria-checked="true"');
  expect(radio).toContain('role="menuitemradio"');
  expect(radio).toContain('aria-checked="false"');
});
