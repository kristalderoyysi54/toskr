import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api } from "@/lib/tauri";
import { registerPrivacySettingsSave } from "./privacySettingsBarrier";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));

describe("隐私设置落盘屏障", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    registerPrivacySettingsSave(Promise.resolve());
  });

  it("文本和图片扫描都等待保存落盘后才调用Rust", async () => {
    let resolve!: () => void;
    registerPrivacySettingsSave(new Promise<void>((done) => { resolve = done; }));
    const text = api.scanSensitiveText("text");
    const image = api.scanImageFirewall("image.png", true);
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    resolve();
    await Promise.all([text, image]);
    expect(invoke).toHaveBeenCalledWith("scan_sensitive_text", { request: { text: "text" } });
    expect(invoke).toHaveBeenCalledWith("scan_image_firewall", { file: "image.png", force: true });
  });

  it("保存失败后不扫描旧配置", async () => {
    registerPrivacySettingsSave(Promise.reject(new Error("save failed")));
    await expect(api.scanSensitiveText("text")).rejects.toThrow("save failed");
    await expect(api.scanImageFirewall("image.png")).rejects.toThrow("save failed");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("等待期间有更新的保存时继续等待最新回执", async () => {
    let first!: () => void;
    let second!: () => void;
    registerPrivacySettingsSave(new Promise<void>((done) => { first = done; }));
    const scan = api.scanSensitiveText("text");
    registerPrivacySettingsSave(new Promise<void>((done) => { second = done; }));
    first();
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    second();
    await scan;
    expect(invoke).toHaveBeenCalledOnce();
  });
});
