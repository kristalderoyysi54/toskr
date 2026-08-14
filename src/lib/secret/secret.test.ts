import { describe, expect, it } from "vitest";

import {
  estimateCipherLength,
  isSecretEnvelope,
  openFromChinese,
  sealToChinese,
  type SecretKey,
} from "./secret";

const key = (id: string, passphrase: string, label = id): SecretKey => ({
  id,
  label,
  passphrase,
  createdAtMs: 0,
  updatedAtMs: 0,
});

describe("secret 高层管线", () => {
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

  it("isSecretEnvelope：合法信封真、普通中文假、仅「」空壳假", async () => {
    expect(isSecretEnvelope(await sealToChinese("x", "k"))).toBe(true);
    expect(isSecretEnvelope("普通聊天内容而已")).toBe(false);
    expect(isSecretEnvelope("「随便写点什么」")).toBe(false);
  });
});
