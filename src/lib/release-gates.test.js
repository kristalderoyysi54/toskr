import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("发布门禁失败或源码变化时，在写版本号前停止", () => {
  const script = fileURLToPath(new URL("../../script/test-release-gates.py", import.meta.url));
  expect(() => execFileSync("python3", [script], { stdio: "pipe", timeout: 20_000 })).not.toThrow();
}, 25_000);
