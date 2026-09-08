import { describe, expect, it } from "vitest";
import { customSensitiveFieldIssue, isCustomSensitiveFieldsValid, normalizeCustomSensitiveFields } from "./customSensitiveFields";

describe("自定义敏感字段输入", () => {
  it("接受中文与标点字段，英文大小写去重", () => {
    expect(normalizeCustomSensitiveFields([" 内部口令 ", "partner.secret", "Partner.Secret", "service-key", "", "key=value", "with space"]))
      .toEqual(["内部口令", "partner.secret", "service-key"]);
    expect(customSensitiveFieldIssue("PARTNER_SECRET", ["partner_secret"])).toContain("已经添加");
  });
  it("限制长度和数量，不把值或正则保存为字段名", () => {
    for (const input of ["", "密钥=真实内容", ".*secret", "字段 名", "a".repeat(65), "ékey"]) expect(customSensitiveFieldIssue(input)).not.toBeNull();
    expect(customSensitiveFieldIssue("密".repeat(64))).toBeNull();
    expect(customSensitiveFieldIssue("new", Array.from({length:32}, (_, i) => `key${i}`))).toContain("32");
  });
  it("持久化校验拒绝非标准数据，旧缺省由默认值处理", () => {
    expect(isCustomSensitiveFieldsValid([])).toBe(true);
    expect(isCustomSensitiveFieldsValid(["内部口令", "partner_secret"])).toBe(true);
    for (const input of [null, "key", [1], [" key "], ["key", "KEY"], ["a=b"]]) expect(isCustomSensitiveFieldsValid(input)).toBe(false);
  });
});
