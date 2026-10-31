import { describe, expect, it } from "vitest";

import { emptyHistory, isMeaningful, nextNumber, pushShape, redo, undo, type Shape } from "./annotate";

const rect = (x2: number): Shape => ({ kind: "rect", x1: 0, y1: 0, x2, y2: 10, color: "#FF3B30", size: 1 });
const num = (n: number): Shape => ({ kind: "number", x: 0, y: 0, n, color: "#FF3B30", size: 1 });

describe("截图标注模型", () => {
  it("误触的短图形与空文字不入历史", () => {
    expect(isMeaningful({ kind: "arrow", x1: 0, y1: 0, x2: 1, y2: 1, color: "#000000", size: 0 })).toBe(false);
    expect(isMeaningful({ kind: "text", x: 0, y: 0, text: "  ", color: "#000000", size: 0 })).toBe(false);
    expect(pushShape(emptyHistory, { kind: "pen", points: [[0, 0]], color: "#000000", size: 0 })).toBe(emptyHistory);
  });

  it("撤销/重做，新图形清空重做栈", () => {
    let h = pushShape(pushShape(emptyHistory, rect(10)), rect(20));
    h = undo(h);
    expect(h.shapes).toHaveLength(1);
    expect(h.redo).toHaveLength(1);
    expect(redo(h).shapes).toHaveLength(2);
    expect(pushShape(h, rect(30)).redo).toHaveLength(0);
    expect(undo(emptyHistory)).toBe(emptyHistory);
  });

  it("序号接续最大值，撤销后回填", () => {
    expect(nextNumber([])).toBe(1);
    expect(nextNumber([num(1), rect(10), num(2)])).toBe(3);
    const h = undo(pushShape(pushShape(emptyHistory, num(1)), num(2)));
    expect(nextNumber(h.shapes)).toBe(2);
  });
});
