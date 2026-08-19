import { describe, expect, it } from "vitest";

import { resolveExternalLink } from "./externalLinks";

describe("resolveExternalLink", () => {
  it("http/https 链接原样外开", () => {
    expect(resolveExternalLink("https://example.com/x?a=1")).toBe(
      "https://example.com/x?a=1"
    );
    expect(resolveExternalLink("http://example.com")).toBe(
      "http://example.com"
    );
    expect(resolveExternalLink("  https://example.com  ")).toBe(
      "https://example.com"
    );
  });

  it("相对路径与锚点吞掉（防 SPA 被导航走）", () => {
    expect(resolveExternalLink("foo/bar")).toBeNull();
    expect(resolveExternalLink("./doc.md")).toBeNull();
    expect(resolveExternalLink("#section")).toBeNull();
    expect(resolveExternalLink("")).toBeNull();
  });

  it("非 http 协议吞掉（与 Rust open_url 只放行 http/https 同口径）", () => {
    expect(resolveExternalLink("mailto:a@b.com")).toBeNull();
    expect(resolveExternalLink("javascript:alert(1)")).toBeNull();
    expect(resolveExternalLink("file:///etc/passwd")).toBeNull();
    expect(resolveExternalLink("httpsx://evil")).toBeNull();
  });
});
