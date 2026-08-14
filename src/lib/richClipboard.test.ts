import { describe, expect, it, vi } from "vitest";

import { parseRichClipboard } from "./richClipboard";

describe("parseRichClipboard", () => {
  it("按 Geelib 图文顺序输出块，并把表格转换为 TSV", () => {
    const result = parseRichClipboard({
      sourceUrl:
        "https://geelib.qihoo.net/geelib/project/requirement/requirementList?demandId=113708",
      plainText: "不应在有有效图片时覆盖 HTML 顺序",
      html: `
        <div>路径：【审批管理-商户注册】查看</div>
        <img src="https://geelib.qihoo.net/files/image_6a424239ba540.png"
             alt="image_6a424239ba540.png">
        <h2>一、商户类型&amp;商户子类型</h2>
        <img src="data:image/png;base64,QUJDRA==" alt="第二张图">
        <table>
          <tr><th>字段</th><th>说明</th></tr>
          <tr><td>商户类型</td><td><strong>企业</strong></td></tr>
        </table>
        <img src="/files/image_tail.jpeg" alt="尾图">
      `,
    });

    expect(result).toEqual({
      text:
        "路径：【审批管理-商户注册】查看\n一、商户类型&商户子类型\n字段\t说明\n商户类型\t企业",
      blocks: [
        { type: "text", text: "路径：【审批管理-商户注册】查看" },
        { type: "imageRef", index: 0, alt: "image_6a424239ba540.png" },
        { type: "text", text: "一、商户类型&商户子类型" },
        { type: "imageRef", index: 1, alt: "第二张图" },
        { type: "text", text: "字段\t说明\n商户类型\t企业" },
        { type: "imageRef", index: 2, alt: "尾图" },
      ],
      imageSources: [
        "https://geelib.qihoo.net/files/image_6a424239ba540.png",
        "data:image/png;base64,QUJDRA==",
        "https://geelib.qihoo.net/files/image_tail.jpeg",
      ],
      omittedImageCount: 0,
      omittedSchemes: [],
    });
  });

  it("忽略可执行或不可见子树，拒绝危险图片源且不发起网络请求", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // file:// 在解析层放行（IM 本地缓存场景），读取策略由 Native 层把守：
    // 网页来源拒绝、缓存根白名单外拒绝——/Users/kai/secret.png 会在那一层挡下。
    const result = parseRichClipboard({
      plainText: "安全正文",
      html: `
        <head><title>不应进入正文</title></head>
        <script>const fake = '<style>'; <img src="https://evil.test/from-script.png"></script>
        <style>.x { background: url(https://evil.test/style.png) }</style>
        <svg><img src="https://evil.test/from-svg.png"></svg>
        <noscript><img src="https://evil.test/from-noscript.png"></noscript>
        <p>安全 <img src="javascript:alert(1)"> 正文</p>
        <img src="file:///Users/kai/secret.png">
        <img src="blob:https://geelib.qihoo.net/id">
        <img src="data:image/svg+xml;base64,PHN2Zz4=">
        <img src="https://safe.test/icon.svg?download=1">
        <img src="https://safe.test/ok.png" onerror="fetch('/leak')" alt=" 可用   图片 ">
      `,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.text).toBe("安全 正文");
    expect(result.imageSources).toEqual([
      "file:///Users/kai/secret.png",
      "https://safe.test/ok.png",
    ]);
    expect(result.blocks).toEqual([
      { type: "text", text: "安全 正文" },
      { type: "imageRef", index: 0 },
      { type: "imageRef", index: 1, alt: "可用 图片" },
    ]);
    expect(result.omittedImageCount).toBe(4);
    expect(result.omittedSchemes).toEqual([
      "javascript",
      "blob",
      "data:image/svg+xml",
      "svg",
    ]);

    vi.unstubAllGlobals();
  });

  it("只在有效 HTTP(S) sourceUrl 下解析相对与协议相对地址", () => {
    const resolved = parseRichClipboard({
      plainText: "图片",
      sourceUrl: "https://example.test/docs/one/page.html",
      html: `
        <img src="../a.png">
        <img src="/root/b.jpeg">
        <img src="//cdn.example.test/c.png">
        <img src=https://static.example.test/d.png>
      `,
    });
    expect(resolved.imageSources).toEqual([
      "https://example.test/docs/a.png",
      "https://example.test/root/b.jpeg",
      "https://cdn.example.test/c.png",
      "https://static.example.test/d.png",
    ]);

    const unresolved = parseRichClipboard({
      plainText: "回退文字",
      sourceUrl: "file:///tmp/page.html",
      html: `<img src="../a.png"><img src="//cdn.example.test/c.png">`,
    });
    expect(unresolved).toEqual({
      text: "回退文字",
      blocks: [{ type: "text", text: "回退文字" }],
      imageSources: [],
      omittedImageCount: 2,
      omittedSchemes: ["relative", "relative"],
    });
  });

  it("放行 IM 本地缓存 file:// 与常见位图 data URL，file 主机与 svg 后缀仍拒绝", () => {
    const result = parseRichClipboard({
      plainText: "文 字",
      html: `
        <p>文</p>
        <img src="file:///Users/kai/Library/Containers/com.im.app/Data/tmp/%E5%9B%BE 1.png">
        <p>字</p>
        <img src="data:image/webp;base64,UklGRg==">
        <img src="data:image/GIF;base64,R0lGOD==">
        <img src="file://nas-host/share/x.png">
        <img src="file:///tmp/vector.svg">
      `,
    });

    expect(result.imageSources).toEqual([
      "file:///Users/kai/Library/Containers/com.im.app/Data/tmp/%E5%9B%BE%201.png",
      "data:image/webp;base64,UklGRg==",
      "data:image/gif;base64,R0lGOD==",
    ]);
    expect(result.blocks).toEqual([
      { type: "text", text: "文" },
      { type: "imageRef", index: 0 },
      { type: "text", text: "字" },
      { type: "imageRef", index: 1 },
      { type: "imageRef", index: 2 },
    ]);
    expect(result.omittedImageCount).toBe(2);
    expect(result.omittedSchemes).toEqual(["file-host", "svg"]);
  });

  it("可复用同一图片源，但保留每一次 DOM 位置与各自 alt", () => {
    const result = parseRichClipboard({
      plainText: "甲 乙",
      html: `
        <p>甲</p>
        <img src="https://img.test/same.png" alt="第一次">
        <p>乙</p>
        <img src="https://img.test/same.png" alt="第二次">
      `,
    });

    expect(result.imageSources).toEqual(["https://img.test/same.png"]);
    expect(result.blocks).toEqual([
      { type: "text", text: "甲" },
      { type: "imageRef", index: 0, alt: "第一次" },
      { type: "text", text: "乙" },
      { type: "imageRef", index: 0, alt: "第二次" },
    ]);
  });

  it("text 始终等于 blocks 的文本投影，行内图片两侧用单换行连接", () => {
    const result = parseRichClipboard({
      plainText: "甲乙",
      html: `<span>甲<img src="https://img.test/inline.png">乙</span>`,
    });

    expect(result.blocks).toEqual([
      { type: "text", text: "甲" },
      { type: "imageRef", index: 0 },
      { type: "text", text: "乙" },
    ]);
    expect(result.text).toBe("甲\n乙");
  });

  it("没有有效图片时使用规范化后的 plainText，而不是 HTML 图片文件名", () => {
    const result = parseRichClipboard({
      plainText: "路径：【审批管理】查看\r\n\r\nimage_a.png\n  一、类型  ",
      html: `<p>HTML 文字</p><img src="blob:https://example.test/id" alt="image_a.png">`,
    });

    expect(result).toEqual({
      text: "路径：【审批管理】查看\n\nimage_a.png\n一、类型",
      blocks: [
        {
          type: "text",
          text: "路径：【审批管理】查看\n\nimage_a.png\n一、类型",
        },
      ],
      imageSources: [],
      omittedImageCount: 1,
      omittedSchemes: ["blob"],
    });
  });

  it("plainText 为空且没有图片时仍保留安全的 HTML 可见文字", () => {
    expect(
      parseRichClipboard({
        plainText: "",
        html: `<div> 第一段 <span>连续</span></div><div>第二段<br>下一行</div>`,
      })
    ).toEqual({
      text: "第一段 连续\n第二段\n下一行",
      blocks: [{ type: "text", text: "第一段 连续\n第二段\n下一行" }],
      imageSources: [],
      omittedImageCount: 0,
      omittedSchemes: [],
    });
  });
});
