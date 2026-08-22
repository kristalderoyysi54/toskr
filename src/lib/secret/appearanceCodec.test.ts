import { describe, expect, it } from "vitest";

import {
  MAX_SECRET_APPEARANCE_CHARS,
  SECRET_CIPHER_STYLE_OPTIONS,
  SECRET_CIPHER_STYLES,
  decodeSecretAppearance,
  encodeSecretAppearance,
  estimateSecretAppearanceLength,
  isSecretAppearanceLengthSupported,
  normalizeSecretCipherStyle,
  type SecretCipherStyle,
} from "./appearanceCodec";
import { decodeToBytes, encodeBytes } from "./chineseCodec";

const envelope = Uint8Array.from([
  0x86, 0x17, 0x01,
  ...Array.from({ length: 16 }, (_, i) => i),
  ...Array.from({ length: 12 }, (_, i) => 0xa0 + i),
  ...Array.from({ length: 16 }, (_, i) => 0xf0 - i),
]);

const bytesOf = (value: Uint8Array | undefined): number[] =>
  Array.from(value ?? []);

function sixBitFixtureBytes(tokens: readonly number[]): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < tokens.length; i += 4) {
    const [a, b, c, d] = tokens.slice(i, i + 4);
    bytes.push((a << 2) | (b >>> 4));
    bytes.push(((b & 0x0f) << 4) | (c >>> 2));
    bytes.push(((c & 0x03) << 6) | d);
  }
  return Uint8Array.from(bytes);
}

describe("secret/appearanceCodec 独立文本协议", () => {
  it("固定向量冻结 code / log / quote 协议，避免模板或英文码本漂移", () => {
    expect(encodeSecretAppearance(envelope, "code")).toBe(
      'const cacheSnapshot = "861701000102030405060708090a0b0c0d0e0fa0a1a2a3a4a5a6a7a8a9aaabf0efeeedecebeae9e8e7e6e5e4e3e2e1";\n' +
      "export default cacheSnapshot;"
    );
    expect(encodeSecretAppearance(envelope, "log")).toBe(
      "2026-02-19T12:48:07.000Z INFO cache.restore trace=00010203 chunk=1/2 payload=861701000102030405060708090a0b0c0d0e0fa0a1a2a3a4a5a6a7a8a9aaabf0\n" +
      "2026-02-19T12:48:07.000Z INFO cache.restore trace=00010203 chunk=2/2 payload=efeeedecebeae9e8e7e6e5e4e3e2e1"
    );
    expect(encodeSecretAppearance(envelope, "quote")).toBe(
      '> "into into from again after after among air after river close and,\n' +
      "> again home from before air close north blue along after soft calm,\n" +
      "> along time air into north old calm long now first first night,\n" +
      "> old beyond near old old wind along quiet tree past sun only,\n" +
      "> time west once now time calm high near through here deep light,\n" +
      "> there past among.\"\n>\n> — Field Notes"
    );
  });

  it("冻结引用协议完整 64-word 码本顺序", () => {
    expect(
      encodeSecretAppearance(
        sixBitFixtureBytes(Array.from({ length: 64 }, (_, index) => index)),
        "quote"
      )
    ).toBe(
      '> "after again air along among and away back before below beyond blue,\n' +
      "> bright but calm clear close dark day deep down each east even,\n" +
      "> far field first for from green here high home into last light,\n" +
      "> long low near night north now old once only over past quiet,\n" +
      "> river road sea sky soft still stone sun there through time tree,\n" +
      "> under water west wind.\"\n>\n> — Field Notes"
    );
  });
  it("公开四种稳定风格及区分清晰的用户文案", () => {
    expect(SECRET_CIPHER_STYLES).toEqual([
      "classic",
      "code",
      "log",
      "quote",
    ]);
    expect(SECRET_CIPHER_STYLE_OPTIONS).toEqual([
      { value: "classic", label: "中文文本", shortLabel: "中文" },
      { value: "code", label: "代码（随机语言）", shortLabel: "代码" },
      { value: "log", label: "日志记录", shortLabel: "日志" },
      { value: "quote", label: "英文引用", shortLabel: "引用" },
    ]);
  });

  it.each(SECRET_CIPHER_STYLES)(
    "%s 独立编码后自动识别，同一 envelope bytes 往返不变",
    (style) => {
      const rendered = encodeSecretAppearance(envelope, style);
      const decoded = decodeSecretAppearance(rendered);

      expect(decoded?.style).toBe(style);
      expect(bytesOf(decoded?.bytes)).toEqual(bytesOf(envelope));
    }
  );

  it("code 按 envelope 随机盐稳定覆盖 JS / Python / Go / Rust 四种纯代码", () => {
    const languagePatterns = [
      /^const cacheSnapshot = "[0-9a-f]+";\nexport default cacheSnapshot;$/,
      /^CACHE_SNAPSHOT = bytes\.fromhex\(\n    "[0-9a-f]+"\n\)$/,
      /^package cache\n\nimport "encoding\/hex"\n\nvar cacheSnapshot, _ = hex\.DecodeString\("[0-9a-f]+"\)$/,
      /^pub const CACHE_SNAPSHOT: &str =\n    "[0-9a-f]+";$/,
    ];

    for (let saltByte = 0; saltByte < languagePatterns.length; saltByte++) {
      const varied = envelope.slice();
      varied[3] = saltByte;
      const rendered = encodeSecretAppearance(varied, "code");

      expect(rendered).toMatch(languagePatterns[saltByte]);
      expect(rendered).not.toMatch(/[「」\u3400-\u9fff]/u);
      expect(bytesOf(decodeSecretAppearance(rendered)?.bytes)).toEqual(
        bytesOf(varied)
      );
      expect(encodeSecretAppearance(varied, "code")).toBe(rendered);
    }
  });

  it.each(["code", "log", "quote"] as const)(
    "%s 不再夹带旧中文码本，旧 decoder 不会误读",
    (style) => {
      const rendered = encodeSecretAppearance(envelope, style);
      expect(rendered).not.toMatch(/[「」\u3400-\u9fff]/u);
      expect(decodeToBytes(rendered)).toBeNull();
    }
  );

  it("log 只输出结构化英文日志并严格按顺序拼接分块", () => {
    const rendered = encodeSecretAppearance(envelope, "log");
    const lines = rendered.split("\n");

    expect(lines.length).toBeGreaterThan(1);
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i]).toMatch(
        new RegExp(
          `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z INFO cache\\.restore trace=[0-9a-f]{8} chunk=${i + 1}/${lines.length} payload=[0-9a-f]+$`
        )
      );
    }
    expect(rendered).not.toMatch(/[「」\u3400-\u9fff]/u);
    expect(rendered).toContain("trace=00010203");
    expect(encodeSecretAppearance(envelope, "log")).toBe(rendered);
  });

  it("quote 接受 macOS / IM 常见的成对智能引号规范化", () => {
    const rendered = encodeSecretAppearance(envelope, "quote");
    const smartQuotes = rendered
      .replace(/^> "/, "> “")
      .replace(/\."(?=\n>\n> — Field Notes$)/, ".”");

    expect(bytesOf(decodeSecretAppearance(smartQuotes)?.bytes)).toEqual(
      bytesOf(envelope)
    );
    expect(decodeSecretAppearance(smartQuotes.replace(".”", '."'))).toBeNull();
  });

  it("quote 覆盖 6-bit 三种字节余数，并拒绝非零补位", () => {
    for (const extra of [0, 1, 2]) {
      const varied = Uint8Array.from([...envelope, ...new Uint8Array(extra)]);
      expect(bytesOf(decodeSecretAppearance(
        encodeSecretAppearance(varied, "quote")
      )?.bytes)).toEqual(bytesOf(varied));
    }

    const invalidPadding = encodeSecretAppearance(envelope, "quote").replace(
      "among.\"",
      "and.\""
    );
    expect(decodeSecretAppearance(invalidPadding)).toBeNull();
  });

  it("quote 用冻结英文词码本输出 Markdown 引用，不暴露中文、hex 或 Base64 长串", () => {
    const rendered = encodeSecretAppearance(envelope, "quote");

    expect(rendered).toMatch(/^> "[a-z ]+[,."]/);
    expect(rendered.endsWith(">\n> — Field Notes")).toBe(true);
    expect(rendered).not.toMatch(/[「」\u3400-\u9fff]/u);
    expect(rendered).not.toMatch(/[0-9a-f]{16}/);
    expect(rendered).not.toMatch(/[A-Za-z0-9+/=_-]{32}/);
  });

  it("继续读取旧 classic 以及上一版包中文的 code / log / quote", () => {
    const classic = encodeBytes(envelope);
    const legacy = [
      { style: "classic", text: classic },
      {
        style: "code",
        text: `const cacheSnapshot = "${classic.replace(/\n/g, "\\n")}";`,
      },
      {
        style: "log",
        text: `[debug] cache.snapshot=${classic.replace(/\n/g, " ")}`,
      },
      {
        style: "quote",
        text: `> ${classic.replace(/\n/g, "\n> ")}`,
      },
    ] as const;

    for (const fixture of legacy) {
      const decoded = decodeSecretAppearance(fixture.text);
      expect(decoded?.style).toBe(fixture.style);
      expect(bytesOf(decoded?.bytes)).toEqual(bytesOf(envelope));
    }
  });

  it("CRLF、首尾空白及匹配语言的 Markdown fence 不影响自动识别", () => {
    for (const style of SECRET_CIPHER_STYLES) {
      const rendered = encodeSecretAppearance(envelope, style);
      const transported = ` \n${rendered.replace(/\n/g, "\r\n")}\n `;
      expect(bytesOf(decodeSecretAppearance(transported)?.bytes)).toEqual(
        bytesOf(envelope)
      );
    }

    const code = encodeSecretAppearance(envelope, "code");
    expect(code.startsWith("const ")).toBe(true);
    expect(bytesOf(decodeSecretAppearance(`\`\`\`js\n${code}\n\`\`\``)?.bytes)).toEqual(
      bytesOf(envelope)
    );
    expect(decodeSecretAppearance(`\`\`\`python\n${code}\n\`\`\``)).toBeNull();
  });

  it("普通文本、格式漂移、结构截断、错误 magic 与超大输入全部 fail-closed", () => {
    const validCode = encodeSecretAppearance(envelope, "code");
    const validLog = encodeSecretAppearance(envelope, "log");
    const validQuote = encodeSecretAppearance(envelope, "quote");
    const wrongMagic = envelope.slice();
    wrongMagic[0] = 0;

    for (const text of [
      'const cacheSnapshot = "hello";',
      'const cacheSnapshot = "8617";\nexport default cacheSnapshot;',
      validCode.slice(0, -1),
      `${validCode}\n// trailing text`,
      validLog.replace("chunk=1/2", "chunk=2/2"),
      validLog.replace("INFO", "WARN"),
      validLog.slice(0, -1),
      validQuote.replace("Field Notes", "Release Notes"),
      validQuote.replace(/^> "[a-z]+/, '> "unknown'),
      validQuote.slice(0, -1),
      encodeSecretAppearance(wrongMagic, "code"),
      encodeSecretAppearance(wrongMagic, "log"),
      encodeSecretAppearance(wrongMagic, "quote"),
      "> \"ordinary English quote.\"\n>\n> — Field Notes",
      "普通备忘：明天开会",
      "x".repeat(1_000_001),
      "",
    ]) {
      expect(decodeSecretAppearance(text)).toBeNull();
    }
  });

  it("长度估算覆盖四种协议，code 取随机模板上界", () => {
    for (const style of SECRET_CIPHER_STYLES) {
      const actual = encodeSecretAppearance(envelope, style).length;
      const estimated = estimateSecretAppearanceLength(envelope.length, style);
      if (style === "code") {
        expect(estimated).toBeGreaterThanOrEqual(actual);
        expect(estimated - actual).toBeLessThan(64);
      } else {
        expect(Math.abs(estimated - actual) / actual).toBeLessThan(0.12);
      }
    }
  });

  it("编码与解码共享 100 万字符硬上限，超限在发送端 fail-fast", () => {
    expect(MAX_SECRET_APPEARANCE_CHARS).toBe(1_000_000);
    for (const style of SECRET_CIPHER_STYLES) {
      expect(isSecretAppearanceLengthSupported(envelope.length, style)).toBe(true);
      expect(isSecretAppearanceLengthSupported(1_000_000, style)).toBe(false);
    }
    expect(() =>
      encodeSecretAppearance(new Uint8Array(600_000), "code")
    ).toThrow("秘文内容过长");
  });

  it("未知风格运行时拒绝，不静默回落到 classic", () => {
    expect(() =>
      encodeSecretAppearance(envelope, "unknown" as SecretCipherStyle)
    ).toThrow("不支持的秘文格式");
    expect(() =>
      estimateSecretAppearanceLength(100, "unknown" as SecretCipherStyle)
    ).toThrow("不支持的秘文格式");
    expect(() =>
      isSecretAppearanceLengthSupported(100, "unknown" as SecretCipherStyle)
    ).toThrow("不支持的秘文格式");
  });

  it("持久化风格值只接受权威枚举，未知值和缺省值回落 classic", () => {
    for (const style of SECRET_CIPHER_STYLES) {
      expect(normalizeSecretCipherStyle(style)).toBe(style);
    }
    expect(normalizeSecretCipherStyle("memo")).toBe("classic");
    expect(normalizeSecretCipherStyle(undefined)).toBe("classic");
    expect(normalizeSecretCipherStyle(null)).toBe("classic");
  });
});
