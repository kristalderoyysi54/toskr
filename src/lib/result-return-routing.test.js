import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(srcRoot, "..");
const source = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");

describe("结果关联跨窗口门禁", () => {
  it("清空台账会广播到主窗口并关闭旧关联会话、失效候选缓存", () => {
    const events = source("src-tauri/src/events.rs");
    const commands = source("src-tauri/src/commands.rs");
    const app = source("src/App.tsx");
    const dialog = source("src/components/ResultLinkDialog.tsx");

    expect(events).toContain("DELIVERY_ACTIVITY_CLEARED_EVENT");
    expect(commands).toContain("crate::events::DELIVERY_ACTIVITY_CLEARED_EVENT");
    expect(app).toContain("listen(DELIVERY_ACTIVITY_CLEARED_EVENT");
    expect(app).toContain("invalidateDeliveryActivityCache()");
    expect(app).toContain("closeResultReturnDialog()");
    expect(dialog).toContain("sequence.current !== request.requestId");
  });
});
