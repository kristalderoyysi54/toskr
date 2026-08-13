import { describe, expect, it } from "vitest";

import {
  activeAliasOccurrences,
  aliasOriginalTextIssue,
  allocateAliasPlaceholder,
  applyAliasEntities,
  isAliasCategoryRecordValid,
  isAliasCounterRecordValid,
  isAliasEntityRecordValid,
  restoreAliases,
  scanAliasEntities,
  suggestAliasCategory,
  type AliasEntity,
} from "./aliasEntities";

function entity(
  id: string,
  originalText: string,
  placeholder: string,
  category = "USER"
): AliasEntity {
  return { id, category, originalText, placeholder, createdAtMs: 1, updatedAtMs: 1 };
}

describe("scanAliasEntities", () => {
  it("命中全部非重叠出现，并按起点升序返回", () => {
    const dict = [entity("u1", "张三", "[USER_01]")];
    const hits = scanAliasEntities("张三说张三来了", dict);
    expect(hits.map((hit) => [hit.startUtf16, hit.endUtf16])).toEqual([
      [0, 2],
      [3, 5],
    ]);
    expect(hits.every((hit) => hit.suggestedPlaceholder === "[USER_01]")).toBe(true);
  });

  it("互为子串时长词优先，不产生嵌套替换", () => {
    const dict = [
      entity("u1", "张三", "[USER_01]"),
      entity("u2", "张三丰", "[USER_02]"),
    ];
    const hits = scanAliasEntities("请转告张三丰", dict);
    expect(hits).toHaveLength(1);
    expect(hits[0].originalText).toBe("张三丰");
  });

  it("正文既有占位符是保护区：词典原文落在其中不被匹配", () => {
    const dict = [entity("u1", "USER", "[ROLE_01]")];
    expect(scanAliasEntities("保留 [USER_01] 原样", dict)).toHaveLength(0);
  });

  it("空词典或空文本返回空", () => {
    expect(scanAliasEntities("", [entity("u1", "张三", "[USER_01]")])).toEqual([]);
    expect(scanAliasEntities("张三", [])).toEqual([]);
  });
});

describe("applyAliasEntities", () => {
  it("用条目固定占位符替换并回报映射与计数", () => {
    const dict = [
      entity("u1", "张三", "[USER_01]"),
      entity("m1", "12345", "[MERCHANT_01]", "MERCHANT"),
    ];
    const result = applyAliasEntities("张三在商户 12345 下单", dict);
    expect(result.text).toBe("[USER_01]在商户 [MERCHANT_01] 下单");
    expect(result.replacedCount).toBe(2);
    expect(result.redactionMap).toEqual({
      张三: "[USER_01]",
      "12345": "[MERCHANT_01]",
    });
  });

  it("emoji 前后替换不错位", () => {
    const dict = [entity("u1", "张三", "[USER_01]")];
    const result = applyAliasEntities("🎉🎉张三🎉张三", dict);
    expect(result.text).toBe("🎉🎉[USER_01]🎉[USER_01]");
  });

  it("正文已是占位符时不做任何改动", () => {
    const dict = [entity("u1", "张三", "[USER_01]")];
    const result = applyAliasEntities("[USER_01] 已通知", dict);
    expect(result.text).toBe("[USER_01] 已通知");
    expect(result.replacedCount).toBe(0);
    expect(result.redactionMap).toEqual({});
  });
});

describe("restoreAliases", () => {
  it("已知占位符全部还原，未知占位符原样保留", () => {
    const dict = [entity("u1", "张三", "[USER_01]")];
    const result = restoreAliases("[USER_01] 与 [EMAIL_01] 均已通知 [USER_01]", dict);
    expect(result.text).toBe("张三 与 [EMAIL_01] 均已通知 张三");
    expect(result.restoredCount).toBe(2);
  });

  it("与 applyAliasEntities 构成往返", () => {
    const dict = [
      entity("u1", "张三", "[USER_01]"),
      entity("o1", "SO-2026-001", "[ORDER_01]", "ORDER"),
    ];
    const source = "张三的订单 SO-2026-001 需要加急，抄送张三";
    const applied = applyAliasEntities(source, dict);
    expect(restoreAliases(applied.text, dict).text).toBe(source);
  });

  it("空词典直接原样返回", () => {
    expect(restoreAliases("[USER_01]", []).restoredCount).toBe(0);
  });
});

describe("activeAliasOccurrences", () => {
  it("逐处列出词典占位符并带类别标签", () => {
    const dict = [entity("u1", "张三", "[USER_01]")];
    const occurrences = activeAliasOccurrences("[USER_01] 找 [USER_01]", dict);
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]).toMatchObject({
      startUtf16: 0,
      endUtf16: 9,
      originalText: "张三",
      categoryLabel: "用户",
    });
  });

  it("自定义类别用自定义标签，未知类别退回类别码", () => {
    const dict = [entity("v1", "供应商甲", "[VENDOR_01]", "VENDOR")];
    expect(
      activeAliasOccurrences("[VENDOR_01]", dict, [{ code: "VENDOR", label: "供应商" }])[0]
        .categoryLabel
    ).toBe("供应商");
    expect(activeAliasOccurrences("[VENDOR_01]", dict)[0].categoryLabel).toBe("VENDOR");
  });

  it("非词典占位符不出现在结果里", () => {
    expect(activeAliasOccurrences("[EMAIL_01]", [entity("u1", "张三", "[USER_01]")]))
      .toHaveLength(0);
  });
});

describe("allocateAliasPlaceholder", () => {
  it("从 01 起号、只增不减、跨类别独立", () => {
    const first = allocateAliasPlaceholder("USER", {});
    expect(first.placeholder).toBe("[USER_01]");
    const second = allocateAliasPlaceholder("USER", first.nextCounters);
    expect(second.placeholder).toBe("[USER_02]");
    expect(allocateAliasPlaceholder("ORDER", second.nextCounters).placeholder).toBe(
      "[ORDER_01]"
    );
    // 删除条目不回收：计数器保持在 3，新建仍是 03
    expect(allocateAliasPlaceholder("USER", second.nextCounters).placeholder).toBe(
      "[USER_03]"
    );
  });
});

describe("aliasOriginalTextIssue", () => {
  const dict = [entity("u1", "张三", "[USER_01]")];

  it("拒绝空、首尾空白、占位符形态与重复原文", () => {
    expect(aliasOriginalTextIssue("", dict)).not.toBeNull();
    expect(aliasOriginalTextIssue(" 张三 ", dict)).not.toBeNull();
    expect(aliasOriginalTextIssue("含 [USER_99] 的词", dict)).not.toBeNull();
    expect(aliasOriginalTextIssue("张三", dict)).not.toBeNull();
  });

  it("编辑自身时允许保持原文不变，新原文合法", () => {
    expect(aliasOriginalTextIssue("张三", dict, "u1")).toBeNull();
    expect(aliasOriginalTextIssue("李四", dict)).toBeNull();
  });
});

describe("持久化形状校验", () => {
  it("isAliasEntityRecordValid 拒绝缺字段与非法占位符", () => {
    const valid = entity("u1", "张三", "[USER_01]");
    expect(isAliasEntityRecordValid(valid)).toBe(true);
    expect(isAliasEntityRecordValid({ ...valid, placeholder: "[USER_1]" })).toBe(false);
    expect(isAliasEntityRecordValid({ ...valid, originalText: "" })).toBe(false);
    expect(isAliasEntityRecordValid({ ...valid, category: "user" })).toBe(false);
    expect(isAliasEntityRecordValid(null)).toBe(false);
  });

  it("isAliasCategoryRecordValid 拒绝保留字与预置码", () => {
    expect(isAliasCategoryRecordValid({ code: "VENDOR", label: "供应商" })).toBe(true);
    expect(isAliasCategoryRecordValid({ code: "EMAIL", label: "邮箱" })).toBe(false);
    expect(isAliasCategoryRecordValid({ code: "USER", label: "用户" })).toBe(false);
    expect(isAliasCategoryRecordValid({ code: "VENDOR", label: "" })).toBe(false);
  });

  it("isAliasCounterRecordValid 拒绝零值/浮点/非法类别码", () => {
    expect(isAliasCounterRecordValid({ USER: 3 })).toBe(true);
    expect(isAliasCounterRecordValid({ USER: 0 })).toBe(false);
    expect(isAliasCounterRecordValid({ USER: 1.5 })).toBe(false);
    expect(isAliasCounterRecordValid({ user: 1 })).toBe(false);
  });
});

describe("suggestAliasCategory", () => {
  it("邮箱/电话推断联系方式，编号推断订单，默认用户", () => {
    expect(suggestAliasCategory("alice@example.com")).toBe("CONTACT");
    expect(suggestAliasCategory("+86 138-0000-0000")).toBe("CONTACT");
    expect(suggestAliasCategory("SO-2026-001")).toBe("ORDER");
    expect(suggestAliasCategory("张三")).toBe("USER");
    expect(suggestAliasCategory("某某科技有限公司")).toBe("USER");
  });
});
