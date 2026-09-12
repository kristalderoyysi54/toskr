import { describe, expect, it } from "vitest";

import { hudActionable } from "@/lib/hudForm";

describe("HUD 形态判定（H1）", () => {
  it("可撤销 / 跳转 / 到期 / 粘性走头像气泡，其余走药丸", () => {
    const base = { text: "", count: 1 } as const;
    expect(hudActionable({ ...base, kind: "added", undoable: true })).toBe(true);
    expect(hudActionable({ ...base, kind: "due", targetId: "t1" })).toBe(true);
    expect(hudActionable({ ...base, kind: "info", sticky: true })).toBe(true);
    expect(hudActionable({ ...base, kind: "sent" })).toBe(false);
    expect(hudActionable({ ...base, kind: "warn" })).toBe(false);
    expect(hudActionable({ ...base, kind: "undone" })).toBe(false);
  });
});
