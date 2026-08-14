import { describe, expect, it } from "vitest";

import {
  CRYPTO_CONSTANTS,
  decryptFromBytes,
  encryptToBytes,
  hasWebCrypto,
} from "./crypto";

describe("secret/crypto", () => {
  it("运行环境具备 Web Crypto", () => {
    expect(hasWebCrypto()).toBe(true);
  });

  it("加解密往返：空串 / 中文 / 长文本+emoji 代理对 / 中英混排", async () => {
    for (const text of [
      "",
      "今天老板又画饼了",
      "长文本" + "。测试很长很长的内容".repeat(50) + "🎉🙈码点",
      "mixed 中英 123 !@# 测试",
    ]) {
      const bytes = await encryptToBytes(text, "共享暗号");
      expect(await decryptFromBytes(bytes, "共享暗号")).toBe(text);
    }
  });

  it("信封结构：magic + version 正确，长度 = 头部 + 明文2倍 + tag", async () => {
    const bytes = await encryptToBytes("四个字啊", "k"); // 4 字 → 8 明文字节
    const { MAGIC, VERSION, HEADER_LEN } = CRYPTO_CONSTANTS;
    expect(bytes[0]).toBe(MAGIC[0]);
    expect(bytes[1]).toBe(MAGIC[1]);
    expect(bytes[MAGIC.length]).toBe(VERSION);
    expect(bytes.length).toBe(HEADER_LEN + 8 + 16);
  });

  it("同明文两次密文不同（随机 salt/iv）", async () => {
    const a = await encryptToBytes("重复", "k");
    const b = await encryptToBytes("重复", "k");
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("错误密钥解不开（GCM 认证失败抛错）", async () => {
    const bytes = await encryptToBytes("机密", "对的密钥");
    await expect(decryptFromBytes(bytes, "错的密钥")).rejects.toThrow();
  });

  it("篡改密文尾部（tag 区）解不开", async () => {
    const bytes = await encryptToBytes("机密", "k");
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptFromBytes(tampered, "k")).rejects.toThrow();
  });

  it("头部损坏：过短 / 魔数错 / 版本不支持 分别报对应错", async () => {
    const bytes = await encryptToBytes("x", "k");
    await expect(decryptFromBytes(bytes.slice(0, 5), "k")).rejects.toThrow(
      "密文过短"
    );
    const badMagic = new Uint8Array(bytes);
    badMagic[0] ^= 0xff;
    await expect(decryptFromBytes(badMagic, "k")).rejects.toThrow("非秘文信封");
    const badVersion = new Uint8Array(bytes);
    badVersion[CRYPTO_CONSTANTS.MAGIC.length] = 9;
    await expect(decryptFromBytes(badVersion, "k")).rejects.toThrow(
      "秘文版本不支持"
    );
  });
});
