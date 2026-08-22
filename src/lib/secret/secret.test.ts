import { describe, expect, it } from "vitest";

import {
  SECRET_CIPHER_STYLES,
  estimateCipherLength,
  isCipherLengthSupported,
  isSecretEnvelope,
  openSecret,
  openFromChinese,
  secretEnvelopeFingerprint,
  sealSecret,
  sealToChinese,
  type SecretKey,
} from "./secret";
import { encodeSecretAppearance } from "./appearanceCodec";
import { decodeToBytes } from "./chineseCodec";

const key = (id: string, passphrase: string, label = id): SecretKey => ({
  id,
  label,
  passphrase,
  createdAtMs: 0,
  updatedAtMs: 0,
});

describe("secret 高层管线", () => {
  it("固定旧版 classic 密文无需重编码即可自动识别并解密", async () => {
    // 独立 Web Crypto 固定向量：salt=00..0f、iv=a0..ab、PBKDF2 参数同 v1。
    const legacy =
      "「话说一的，一是了我不人，在他有这个上，们来到将月十\n" +
      "实向声车全信，重三机都点把白加；高母向乐年自、对其会结没\n" +
      "分西信就高关、当在全少重，但。」";

    expect(isSecretEnvelope(legacy)).toBe(true);
    expect(secretEnvelopeFingerprint(legacy)).toBe(
      "861701000102030405060708090a0b0c0d0e0fa0a1a2a3a4a5a6a7a8a9aaab3a9245ddc380efa4e61a26318328e5406d9da81c80f83f07a7cea958"
    );
    expect(await openFromChinese(legacy, [key("legacy", "固定旧钥", "旧钥")])).toEqual({
      status: "plaintext",
      plaintext: "旧版秘文可解",
      keyId: "legacy",
      keyLabel: "旧钥",
    });
  });

  it.each(SECRET_CIPHER_STYLES)(
    "%s：发送方选择外观，接收方不传风格也能自动识别解密",
    async (style) => {
      const cipher = await sealSecret("风格不进入解密语义", "共享暗号", style);

      expect(isSecretEnvelope(cipher)).toBe(true);
      expect(await openSecret(cipher, [key("shared", "共享暗号")])).toMatchObject({
        status: "plaintext",
        plaintext: "风格不进入解密语义",
        keyId: "shared",
      });
    }
  );

  it("超长内容在加密前拒绝，不会生成接收端无法识别的文本", async () => {
    expect(isCipherLengthSupported("普通长度", "quote")).toBe(true);
    const oversized = "x".repeat(600_000);
    expect(isCipherLengthSupported(oversized, "quote")).toBe(false);
    await expect(sealSecret(oversized, "k", "quote")).rejects.toThrow(
      "秘文内容过长"
    );
  });

  it("sealToChinese 保持 classic 兼容导出", async () => {
    const cipher = await sealToChinese("旧调用方", "k");
    expect(cipher).toMatch(/^「话说/);
    expect(await openFromChinese(cipher, [key("k", "k")])).toMatchObject({
      status: "plaintext",
      plaintext: "旧调用方",
    });
  });

  it("端到端：加密 → 识别 → 逐密钥试解命中（错钥在前不干扰）", async () => {
    const cipher = await sealToChinese("下午茶谁去买", "八卦频道");
    expect(isSecretEnvelope(cipher)).toBe(true);
    const res = await openFromChinese(cipher, [
      key("wrong", "别的暗号"),
      key("right", "八卦频道", "同事群"),
    ]);
    expect(res).toEqual({
      status: "plaintext",
      plaintext: "下午茶谁去买",
      keyId: "right",
      keyLabel: "同事群",
    });
  });

  it("密文像自然中文：以「话说」开头、有句读、无保密符号", async () => {
    const cipher = await sealToChinese("公司要裁员的传闻", "内部消息");
    expect(cipher.startsWith("「话说")).toBe(true);
    expect(cipher.endsWith("。」")).toBe(true);
    expect(cipher).not.toContain("㊙");
    expect(cipher).toMatch(/[，、；。]/); // 含中文标点
  });

  it("是秘文但无匹配密钥 → locked", async () => {
    const cipher = await sealToChinese("秘密", "钥A");
    expect(await openFromChinese(cipher, [key("b", "钥B")])).toEqual({
      status: "locked",
    });
    expect(await openFromChinese(cipher, [])).toEqual({ status: "locked" });
  });

  it("普通文本 → not-secret", async () => {
    expect(await openFromChinese("今晚一起吃火锅吗", [key("a", "k")])).toEqual({
      status: "not-secret",
    });
  });

  it("换新 id 但相同密钥文本仍可试解成功（锁定卡自愈的基础）", async () => {
    const cipher = await sealToChinese("重要暗号", "共享密钥文本");
    const rebuilt = key("new-uuid", "共享密钥文本", "重建的密钥");
    const res = await openFromChinese(cipher, [rebuilt]);
    expect(res.status).toBe("plaintext");
    if (res.status === "plaintext") {
      expect(res.plaintext).toBe("重要暗号");
      expect(res.keyId).toBe("new-uuid");
    }
  });

  it("estimateCipherLength 与实测密文字数偏差在 5% 以内", async () => {
    for (const text of ["短", "下午茶谁去买单", "这是一条比较长的消息内容大概三十个字左右用来验证估算精度啊"]) {
      const actual = [...(await sealToChinese(text, "k"))].length;
      const estimated = estimateCipherLength(text);
      expect(Math.abs(estimated - actual) / actual).toBeLessThan(0.05);
    }
  });

  it.each(SECRET_CIPHER_STYLES)(
    "estimateCipherLength 会计入 %s 格式开销且保持近似",
    async (style) => {
      const text = "这是一条用于估算不同秘文外观长度的内容";
      const actual = [...(await sealSecret(text, "k", style))].length;
      const estimated = estimateCipherLength(text, style);
      if (style === "code") {
        expect(estimated).toBeGreaterThanOrEqual(actual);
        expect(estimated - actual).toBeLessThan(64);
      } else {
        expect(Math.abs(estimated - actual) / actual).toBeLessThan(0.12);
      }
    }
  );

  it("isSecretEnvelope：合法信封真、普通中文假、仅「」空壳假", async () => {
    expect(isSecretEnvelope(await sealToChinese("x", "k"))).toBe(true);
    expect(isSecretEnvelope("普通聊天内容而已")).toBe(false);
    expect(isSecretEnvelope("「随便写点什么」")).toBe(false);
  });

  it("外观匹配但载荷损坏或被截断，不误报为可解秘文", async () => {
    for (const text of [
      'const cacheSnapshot = "「话说」";',
      "[debug] cache.snapshot=「话说一」",
      "> 「普通摘录」",
      'const cacheSnapshot = "普通文本";',
    ]) {
      expect(isSecretEnvelope(text)).toBe(false);
      expect(await openFromChinese(text, [key("k", "k")])).toEqual({
        status: "not-secret",
      });
    }
  });

  it("同一 envelope 的不同 wrapper 指纹相等，普通文本无指纹", async () => {
    const classic = await sealSecret("避免包装规范化后重复", "k", "classic");
    const bytes = decodeToBytes(classic)!;
    const fingerprints = SECRET_CIPHER_STYLES.map((style) =>
      secretEnvelopeFingerprint(encodeSecretAppearance(bytes, style))
    );

    expect(new Set(fingerprints).size).toBe(1);
    expect(fingerprints[0]).toMatch(/^[0-9a-f]+$/);
    expect(secretEnvelopeFingerprint("普通文本")).toBeNull();
  });
});
