import { describe, expect, it } from "vitest";

import tauriConfig from "../src-tauri/tauri.conf.json";

type WindowConfig = {
  label?: string;
  focus?: boolean;
  acceptFirstMouse?: boolean;
};

describe("HUD window interaction", () => {
  it("accepts the first click without taking focus", () => {
    const config = tauriConfig as { app?: { windows?: WindowConfig[] } };
    const hud = config.app?.windows?.find((window) => window.label === "hud");

    expect(hud).toMatchObject({
      focus: false,
      acceptFirstMouse: true,
    });
  });
});
