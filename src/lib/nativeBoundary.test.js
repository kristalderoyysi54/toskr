import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
const native = new URL("../../src-tauri/", import.meta.url);
const read = (path) => readFileSync(new URL(path, native), "utf8");
const capabilities = readdirSync(new URL("capabilities/", native))
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(read(`capabilities/${file}`)));
const permissions = (window) => capabilities.filter((cap) => cap.windows.some((pattern) => pattern.endsWith("*") ? window.startsWith(pattern.slice(0, -1)) : window === pattern)).flatMap((cap) => cap.permissions);
describe("原生权限边界", () => {
    it("所有注册命令必须有显式 manifest 权限", () => {
        const handlers = read("src/lib.rs").split(".invoke_handler(tauri::generate_handler![")[1].split("])")[0];
        const manifest = read("build.rs");
        for (const [, command] of handlers.matchAll(/\w+::(\w+),/g)) {
            expect(manifest).toContain(`"${command}"`);
        }
    });
    it.each(["hud", "sourceoverlay", "locatehl", "imgpreview", "textpreview", "textpreview-17"])("%s 无更新、密钥写入、IM启停或备份恢复权限", (window) => {
        const allowed = permissions(window);
        for (const forbidden of ["updater:default", "process:allow-restart", "autostart:default",
            "allow-restart-app", "allow-set-ai-api-key", "allow-delete-ai-api-key",
            "allow-set-message-watch-auto", "allow-set-message-watch", "allow-begin-data-operation",
            "allow-begin-complete-backup-import", "allow-run-media-gc"]) {
            expect(allowed).not.toContain(forbidden);
        }
    });
    it("HUD不能发任意事件绕过主窗口委托", () => {
        expect(permissions("hud")).toEqual(expect.arrayContaining(["allow-hud-action", "allow-hide-hud"]));
        for (const window of ["hud", "sourceoverlay", "locatehl"]) {
            expect(permissions(window)).not.toContain("core:event:default");
            expect(permissions(window)).not.toContain("core:event:allow-emit-to");
            expect(permissions(window)).not.toContain("core:default");
            expect(permissions(window)).not.toContain("allow-send-delivery");
        }
    });
    it("编辑详情保留发送和受控AI，设置管理能力只授予需要的窗口", () => {
        expect(permissions("textpreview-17")).toEqual(expect.arrayContaining([
            "allow-send-delivery", "allow-authorize-ai-request", "allow-begin-ai-request", "allow-cancel-ai-request",
        ]));
        expect(permissions("settings")).toContain("allow-set-message-watch-auto");
        expect(permissions("main")).toContain("allow-begin-data-operation");
        expect(permissions("unrecognized")).toEqual([]);
    });
    it("图片预览允许实际使用的图片读取与目标状态查询", () => {
        expect(permissions("imgpreview")).toEqual(expect.arrayContaining([
            "allow-delivery-image-data-url", "allow-get-target-snapshot",
        ]));
        expect(permissions("imgpreview")).not.toContain("allow-send-delivery");
        expect(permissions("imgpreview")).not.toContain("allow-write-data-if-current");
    });
    it("生产CSP禁止外部脚本和网络连接，开发HMR仅在devCsp", () => {
        const security = JSON.parse(read("tauri.conf.json")).app.security;
        expect(security.csp).toContain("script-src 'self'");
        expect(security.csp).not.toContain("unsafe-eval");
        expect(security.csp).toContain("connect-src ipc: http://ipc.localhost;");
        expect(security.csp).toContain("object-src 'none'");
        expect(security.csp).not.toContain("ws://localhost");
        expect(security.devCsp).toContain("ws://localhost:1420");
    });
});
