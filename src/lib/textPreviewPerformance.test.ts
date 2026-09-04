import { describe, expect, it } from "vitest";

import {
  LARGE_TEXT_PREVIEW_CHARS,
  planTextPreviewRender,
} from "./textPreviewPerformance";

describe("planTextPreviewRender", () => {
  it("defers the full DOM for a 3000+ line clipboard item", () => {
    const text = Array.from(
      { length: 3500 },
      (_, index) => `line-${index + 1} ${"x".repeat(80)}`
    ).join("\n");

    const plan = planTextPreviewRender(text);

    expect(plan.deferred).toBe(true);
    expect(plan.warmupText.length).toBeLessThan(text.length);
    expect(plan.warmupText.length).toBeLessThanOrEqual(
      LARGE_TEXT_PREVIEW_CHARS + 1
    );
  });

  it("keeps normal notes on the immediate render path", () => {
    const text = "普通短笔记";
    expect(planTextPreviewRender(text)).toEqual({
      deferred: false,
      warmupText: text,
    });
  });
});
