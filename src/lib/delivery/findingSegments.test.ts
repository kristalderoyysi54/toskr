import { describe, expect, it } from "vitest";

import { sliceFindingSegments, slicePlaceholderSegments } from "./findingSegments";

const finding = (id: string, start: number, end: number) =>
  ({ id, category: "credential", severity: "warn", startUtf16: start, endUtf16: end, maskedPreview: "", suggestedPlaceholder: "[KEY_01]", ruleId: "r" }) as never;

describe("命中切片", () => {
  it("按范围切成普通/命中片段，越界与重叠命中跳过", () => {
    const segs = sliceFindingSegments("ab secret cd", [finding("b", 9, 30), finding("a", 3, 9), finding("c", 4, 6)]);
    expect(segs.map((s) => [s.text, s.finding?.id ?? null])).toEqual([["ab ", null], ["secret", "a"], [" cd", null]]);
  });
  it("占位符按字面高亮，长占位符优先", () => {
    const segs = slicePlaceholderSegments("Bearer [KEY_01] and [KEY_010]", ["[KEY_01]", "[KEY_010]"]);
    expect(segs.filter((s) => s.placeholder).map((s) => s.text)).toEqual(["[KEY_01]", "[KEY_010]"]);
    expect(slicePlaceholderSegments("", ["[X]"])).toEqual([]);
  });
});
