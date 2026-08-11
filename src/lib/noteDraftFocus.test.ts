import { afterEach, describe, expect, it, vi } from "vitest";

import { focusNoteDraftInput } from "@/lib/noteDraftFocus";

describe("noteDraftFocus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("等待分组目标刷新后聚焦现有笔记输入框", () => {
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("document", { querySelector });
    vi.stubGlobal("window", { requestAnimationFrame });

    focusNoteDraftInput();

    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(querySelector).toHaveBeenCalledWith(
      "[data-note-draft-input] textarea"
    );
    expect(focus).toHaveBeenCalledOnce();
  });
});
