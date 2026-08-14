import { describe, expect, it } from "vitest";

import {
  CODEC_CONSTANTS,
  decodeToBytes,
  encodeBytes,
  looksLikeSecret,
} from "./chineseCodec";

describe("secret/chineseCodec 码本冻结", () => {
  it("恰好 256 个唯一汉字，且全部落在 CJK 基本区", () => {
    // 反解出完整码本：字节 0..255 逐一编码取正文首字
    const chars = Array.from({ length: 256 }, (_, b) => {
      const s = encodeBytes(Uint8Array.of(b));
      // 去掉「」与结尾。，取唯一码本字
      const inner = s.slice(CODEC_CONSTANTS.OPEN.length, -1 - CODEC_CONSTANTS.CLOSE.length);
      return inner;
    });
    expect(chars).toHaveLength(256);
    expect(new Set(chars).size).toBe(256);
    for (const ch of chars) {
      const cp = ch.codePointAt(0)!;
      expect(cp).toBeGreaterThanOrEqual(0x4e00);
      expect(cp).toBeLessThanOrEqual(0x9fff);
    }
  });

  it("固定锚点索引不漂移（防误改码本顺序）", () => {
    const at = (b: number) =>
      encodeBytes(Uint8Array.of(b)).slice(
        CODEC_CONSTANTS.OPEN.length,
        -1 - CODEC_CONSTANTS.CLOSE.length
      );
    expect(at(0)).toBe("的");
    expect(at(23)).toBe("说");
    expect(at(134)).toBe("话");
    expect(at(255)).toBe("入");
  });

  it("全部 256 字节值往返无损", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(decodeToBytes(encodeBytes(all))!)).toEqual(
      Array.from(all)
    );
  });

  it("随机字节往返无损（多种长度）", () => {
    for (const len of [1, 5, 31, 47, 128, 300]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256);
      expect(Array.from(decodeToBytes(encodeBytes(bytes))!)).toEqual(
        Array.from(bytes)
      );
    }
  });

  it("解码容忍 IM 重排版：注入空格/换行/前后聊天文字", () => {
    const bytes = Uint8Array.of(1, 2, 3, 250, 251, 252, 100, 200);
    const cipher = encodeBytes(bytes);
    const polluted = `你看这个 ${cipher.replace(/、/g, " ")}\n （转发）`;
    expect(Array.from(decodeToBytes(polluted)!)).toEqual(Array.from(bytes));
  });

  it("普通中文不含「」→ 不误判为秘文", () => {
    expect(looksLikeSecret("今天天气不错我们去吃饭吧", 47)).toBe(false);
    expect(decodeToBytes("你好世界")).not.toBeNull(); // 含码本字，但无「」
    expect(looksLikeSecret("你好世界", 47)).toBe(false);
  });

  it("含「」但字节数不足 → 不算秘文", () => {
    expect(looksLikeSecret("「的一是」", 47)).toBe(false);
  });

  it("每条密文以「话说」开头（魔数码本渲染的趣味暗记）", () => {
    // 魔数 [0x86,0x17]=[134,23] → 话说；任意信封头两字节恒为魔数
    const cipher = encodeBytes(Uint8Array.of(134, 23, 5, 6, 7));
    expect(cipher.startsWith("「话说")).toBe(true);
  });
});
