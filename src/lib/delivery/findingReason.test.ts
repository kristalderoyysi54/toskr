import privacySource from "../../../src-tauri/src/privacy.rs?raw";
import { describe, expect, it } from "vitest";
import { findingReason } from "./findingReason";

describe("findingReason", () => {
  it("现有后端规则均有具体说明，新增规则时提醒补齐用户文案", () => {
    const source = privacySource.split("#[cfg(test)]")[0];
    const ruleIds = [...source.matchAll(/"((?:credential|auth|token|contact|identity|financial|network|session)\.[a-z_]+)"/g)]
      .map((match) => match[1]);
    expect(ruleIds.length).toBeGreaterThan(30);
    for (const ruleId of ruleIds) {
      const reason = findingReason({ ruleId, category: "apiKey" });
      expect(reason).not.toBe("内容符合密钥或凭据识别规则");
      expect(reason).not.toContain(ruleId);
    }
  });

  it("依据只解释规则，不读取原始值或掩码预览", () => {
    const finding = {
      ruleId: "token.custom_sensitive_field",
      category: "apiKey" as const,
      rawValue: "private-value-123",
      maskedPreview: "pr•••23",
    };
    expect(findingReason(finding)).toBe("匹配你添加的敏感字段");
    expect(findingReason(finding)).not.toContain(finding.rawValue);
    expect(findingReason(finding)).not.toContain(finding.maskedPreview);
  });

  it("未知规则按类别降级，不泄漏内部标识，原型属性不能成为说明", () => {
    for (const ruleId of ["future.rule-with-sensitive-value", "toString", "__proto__"]) {
      expect(findingReason({ ruleId, category: "email" })).toBe("内容符合邮箱识别规则");
    }
  });
});
