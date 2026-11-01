import { describe, expect, it } from "vitest";

import { commitShapes, emptyHistory, pushShape, redo, undo, type Shape } from "./annotate";
import { editShape, handleAt, shapeAt, shapeBounds, type Editable } from "./shapeEdit";

const rect: Shape = { kind: "rect", x1: 0, y1: 0, x2: 200, y2: 100, color: "#FF3B30", size: 1 };
const arrow: Shape = { kind: "arrow", x1: 50, y1: 50, x2: 150, y2: 50, color: "#FF3B30", size: 1 };
const text: Shape = { kind: "text", x: 300, y: 300, text: "Hi 你好", color: "#FF3B30", size: 1 };
const mosaic: Shape = { kind: "mosaic", x1: 60, y1: 40, x2: 20, y2: 10, color: "#000000", size: 1 };

describe("已画标注的选中与调整", () => {
  it("描边优先：框里的箭头不被外框抢走，框内空白退回选中外框", () => {
    const shapes = [arrow, rect];
    expect(shapeAt(shapes, 100, 51)).toBe(0);
    expect(shapeAt(shapes, 100, 80)).toBe(1);
    expect(shapeAt(shapes, 400, 400)).toBeNull();
    expect(shapeAt(shapes, 100, 51, 4, (s) => s.kind === "rect")).toBe(1);
    expect(shapeAt([text], 310, 305)).toBe(0);
  });

  it("框类拖手柄缩放、整体移动贴边停住", () => {
    const m = mosaic as Editable;
    expect(handleAt(m, 60, 40, 4)).toBe("se");
    expect(shapeBounds(editShape(m, "se", 20, 10, 500, 500))).toEqual({ x: 20, y: 10, w: 60, h: 40 });
    expect(shapeBounds(editShape(m, null, -100, 0, 500, 500))).toEqual({ x: 0, y: 10, w: 40, h: 30 });
  });

  it("箭头拖端点，文字整体移动", () => {
    const a = arrow as Editable;
    expect(handleAt(a, 150, 50, 4)).toBe("end");
    expect(editShape(a, "end", 10, 20, 500, 500)).toMatchObject({ x1: 50, y1: 50, x2: 160, y2: 70 });
    expect(editShape(text as Editable, null, -10, 5, 500, 500)).toMatchObject({ x: 290, y: 305 });
  });

  it("改图形是一步历史，可撤销重做", () => {
    const h = pushShape(emptyHistory, rect);
    const moved = editShape(rect as Editable, null, 10, 10, 500, 500);
    const edited = commitShapes(h, [moved]);
    expect(undo(edited).shapes[0]).toBe(rect);
    expect(redo(undo(edited)).shapes[0]).toBe(moved);
  });
});
