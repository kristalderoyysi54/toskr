import { afterAll, describe, expect, it, vi } from "vitest";

import { cachedFx, makeConverter } from "@/lib/currency";

const fx = { fetchedAt: 1, rates: { USD: 1, CNY: 7.2, EUR: 0.9 } };

describe("makeConverter 汇率换算", () => {
  it("US$ → ¥ 主货币的乘数 = CNY 汇率 / USD 汇率", () => {
    const convert = makeConverter("¥", fx)!;
    expect(convert("US$")).toBeCloseTo(7.2);
    expect(convert("€")).toBeCloseTo(7.2 / 0.9);
    // 主货币与缺省币种恒为 1
    expect(convert("¥")).toBe(1);
    expect(convert(undefined)).toBe(1);
    // 未知符号 1:1 近似（自定义符号无从换算）
    expect(convert("₿")).toBe(1);
  });

  it("主货币为 US$ 时 ¥ → US$ 反向换算", () => {
    const convert = makeConverter("US$", fx)!;
    expect(convert("¥")).toBeCloseTo(1 / 7.2);
  });

  it("无汇率缓存或主货币符号未知 → null（调用方回退分列显示）", () => {
    expect(makeConverter("¥", null)).toBeNull();
    expect(makeConverter("₿", fx)).toBeNull();
  });
});

describe("cachedFx", () => {
  // node 测试环境无 localStorage：装一个最小内存 stub
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  afterAll(() => vi.unstubAllGlobals());

  it("坏缓存返回 null，好缓存原样返回", () => {
    localStorage.setItem("toskr-fx-rates", "not json");
    expect(cachedFx()).toBeNull();
    localStorage.setItem("toskr-fx-rates", JSON.stringify({ nope: 1 }));
    expect(cachedFx()).toBeNull();
    localStorage.setItem("toskr-fx-rates", JSON.stringify(fx));
    expect(cachedFx()).toEqual(fx);
    localStorage.removeItem("toskr-fx-rates");
  });
});
