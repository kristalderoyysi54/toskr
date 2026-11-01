import { describe, expect, it } from "vitest";
import { calloutNumbers, calloutPrompt, commitNote, emptyHistory, pushShape, type CalloutShape, type Shape } from "./annotate";

const callout = (x: number, note: string): CalloutShape => ({
  kind: "callout", x1: x, y1: 0, x2: x + 50, y2: 40, note, color: "#FF3B30", size: 1,
});
const rect: Shape = { kind: "rect", x1: 0, y1: 0, x2: 30, y2: 30, color: "#FF3B30", size: 1 };

describe("批注", () => {
  it("编号按批注先后，其他图形不占号；删掉一条后面的补齐", () => {
    const a = callout(0, "改标题"), b = callout(100, "删掉这行");
    expect([...calloutNumbers([a, rect, b]).values()]).toEqual([1, 2]);
    expect(calloutNumbers([rect, b]).get(b)).toBe(1);
  });

  it("编号说明只列填写过的，编号与图上一致；都没填为空", () => {
    const shapes = [callout(0, ""), callout(100, " 删掉这行 ")];
    expect(calloutPrompt(shapes, "图中编号说明：")).toBe("图中编号说明：\n2. 删掉这行");
    expect(calloutPrompt([callout(0, "")], "x")).toBe("");
  });

  it("新框连同说明一步入历史，改已有说明原地替换", () => {
    const h1 = commitNote(emptyHistory, { shape: callout(0, ""), text: "改颜色" });
    expect(h1.undo).toHaveLength(1);
    const orig = h1.shapes[0] as CalloutShape;
    expect(orig.note).toBe("改颜色");
    const h2 = commitNote(pushShape(h1, rect), { shape: orig, text: "改字号", orig });
    expect((h2.shapes[0] as CalloutShape).note).toBe("改字号");
    expect(h2.shapes).toHaveLength(2);
  });
});
