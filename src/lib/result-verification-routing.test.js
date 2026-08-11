import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(srcRoot, "..");
const source = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");

describe("结果核验入口与生命周期", () => {
  it("只挂在结果卡/最近发送浮层，并由 App 在数据失效时关闭", () => {
    const card = source("src/components/NoteCard.tsx");
    const drawer = source("src/components/RecentDeliveryDrawer.tsx");
    const app = source("src/App.tsx");

    expect(card).toContain("requestResultVerification");
    expect(drawer).toContain("requestResultVerification");
    expect(app).toContain("<ResultVerificationDialog />");
    expect(app).toContain("closeResultVerificationDialog()");
    expect(app).not.toContain('setPage("results")');
  });

  it("检查弹窗使用不透底且无位移合成的清晰文字层", () => {
    const dialog = source("src/components/ResultVerificationDialog.tsx");

    expect(dialog).toContain("grid place-items-center");
    expect(dialog).toContain('"bg-surface-raised"');
    expect(dialog).not.toContain("backdrop-blur");
    expect(dialog).not.toContain("-translate-x-1/2");
    expect(dialog).not.toContain("-translate-y-1/2");
    expect(dialog).not.toContain("zoom-in-95");
    expect(dialog).not.toContain("text-micro");
  });
});
