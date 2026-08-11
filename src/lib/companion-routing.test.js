import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relative) => readFileSync(path.join(srcRoot, relative), "utf8");

describe("伴随磁吸运行态门禁", () => {
  it("配置恢复为开启时立即刷新已显示面板，不等待下一次焦点事件", () => {
    const commands = source("src-tauri/src/commands.rs");
    const window = source("src-tauri/src/window.rs");

    expect(commands).toContain("crate::window::refresh_companion_takeover(&app)");
    expect(window).toContain("pub fn refresh_companion_takeover(app: &AppHandle)");
    expect(window).toContain("start_companion_tracker(app, -1, monitors);");
  });

  it("生产源码不保留多屏诊断后门", () => {
    const rust = ["src-tauri/src/lib.rs", "src-tauri/src/window.rs"]
      .map(source)
      .join("\n");

    expect(rust).not.toContain("DEBUG-ms-companion");
    expect(rust).not.toContain("debug-ms-companion");
  });
});
