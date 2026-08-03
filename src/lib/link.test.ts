import { describe, expect, it } from "vitest";

import { detectLink, linkParts } from "./link";

describe("detectLink：带 scheme", () => {
  it("完整 https URL 原样返回", () => {
    expect(detectLink("https://a.com/x?q=1")).toBe("https://a.com/x?q=1");
    expect(detectLink("  http://a.com  ")).toBe("http://a.com");
  });

  it("含空格/多行不识别", () => {
    expect(detectLink("看看 https://a.com 这个")).toBeUndefined();
    expect(detectLink("https://a.com\nhttps://b.com")).toBeUndefined();
  });
});

describe("detectLink：无 scheme 裸域名（浏览器地址栏复制形态）", () => {
  it("常见 TLD 补全 https", () => {
    expect(
      detectLink("developer.open-douyin.com/webapp/awfszfyo2naqkshx/setting/app-info")
    ).toBe(
      "https://developer.open-douyin.com/webapp/awfszfyo2naqkshx/setting/app-info"
    );
    expect(detectLink("github.com/kristalderoyysi54/toskr")).toBe(
      "https://github.com/kristalderoyysi54/toskr"
    );
    expect(detectLink("example.com")).toBe("https://example.com");
    expect(detectLink("a.example.com.cn/path")).toBe("https://a.example.com.cn/path");
    expect(detectLink("example.com:8080/x")).toBe("https://example.com:8080/x");
  });

  it("文件名不误判（.md/.json/.rs 不在 TLD 白名单）", () => {
    expect(detectLink("README.md")).toBeUndefined();
    expect(detectLink("package.json")).toBeUndefined();
    expect(detectLink("main.rs")).toBeUndefined();
    expect(detectLink("index.html")).toBeUndefined();
  });

  it("bundle id 不误判（TLD 位置是应用名）", () => {
    expect(detectLink("com.apple.Terminal")).toBeUndefined();
    expect(detectLink("com.googlecode.iterm2")).toBeUndefined();
  });

  it("无点主机/版本号/普通文本不识别", () => {
    expect(detectLink("localhost:3000")).toBeUndefined();
    expect(detectLink("1.2.3")).toBeUndefined();
    expect(detectLink("这是一句话")).toBeUndefined();
  });
});

describe("linkParts", () => {
  it("去协议与 www，空路径归一为 /", () => {
    expect(linkParts("https://www.a.com")).toEqual({ host: "a.com", path: "/" });
    expect(linkParts("https://a.com/x?q=1")).toEqual({ host: "a.com", path: "/x?q=1" });
  });
});
