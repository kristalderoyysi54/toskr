import { describe, expect, it } from "vitest";

import { messageSelectAllIds } from "./messageSelection";

describe("消息监听卡片全选", () => {
  const shortcut = {
    key: "a",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };

  it("⌘A 只返回当前筛选和搜索后仍可见的消息 id", () => {
    expect(
      messageSelectAllIds(shortcut, ["visible-1", "visible-2"], {
        active: true,
        editable: false,
      })
    ).toEqual(["visible-1", "visible-2"]);
  });

  it("不在消息页或正在编辑文字时不接管 ⌘A", () => {
    expect(
      messageSelectAllIds(shortcut, ["hidden-message"], {
        active: false,
        editable: false,
      })
    ).toBeNull();
    expect(
      messageSelectAllIds(shortcut, ["visible-message"], {
        active: true,
        editable: true,
      })
    ).toBeNull();
  });

  it("不把带额外修饰键或普通 A 误判为全选", () => {
    expect(
      messageSelectAllIds({ ...shortcut, shiftKey: true }, ["one"], {
        active: true,
        editable: false,
      })
    ).toBeNull();
    expect(
      messageSelectAllIds({ ...shortcut, metaKey: false }, ["one"], {
        active: true,
        editable: false,
      })
    ).toBeNull();
  });
});
