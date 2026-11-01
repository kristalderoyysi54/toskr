import { describe, expect, it } from "vitest";
import { dragEnd, type Shape } from "./annotate";
import { editHandles, shapeAt } from "./shapeEdit";

describe("直线", () => {
  it("按住 ⇧ 吸附到水平 / 垂直 / 45°，其余图形不受影响", () => {
    const d = { kind: "line", x1: 0, y1: 0 };
    expect(dragEnd(d, 100, 8, true)).toEqual({ x2: 100, y2: 0 });
    expect(dragEnd(d, 5, -100, true)).toEqual({ x2: 0, y2: -100 });
    expect(dragEnd(d, 70, 72, true).x2).toBe(dragEnd(d, 70, 72, true).y2);
    expect(dragEnd(d, 100, 8, false)).toEqual({ x2: 100, y2: 8 });
    expect(dragEnd({ kind: "rect", x1: 0, y1: 0 }, 100, 8, true)).toEqual({ x2: 100, y2: 8 });
  });

  it("沿线命中，两端各一个手柄", () => {
    const line: Shape = { kind: "line", x1: 0, y1: 0, x2: 100, y2: 0, color: "#FF3B30", size: 1 };
    expect(shapeAt([line], 50, 2)).toBe(0);
    expect(shapeAt([line], 50, 30)).toBeNull();
    expect(editHandles(line).map((h) => h.id)).toEqual(["start", "end"]);
  });
});
