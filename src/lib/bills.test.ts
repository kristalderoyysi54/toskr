import { describe, expect, it } from "vitest";

import {
  advanceCycle,
  billDueLabel,
  billFallbackColor,
  billsDueWithinDays,
  compareBills,
  dueBillsToRemind,
  monthlySpendTotal,
  sixMonthTrend,
  startOfBillDay,
} from "@/lib/bills";
import {
  decodePersistedState,
  useNotesStore,
  type Bill,
} from "@/store/notesStore";

const ts = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

function bill(patch: Partial<Bill> = {}): Bill {
  const nextDueAt = patch.nextDueAt ?? ts(2026, 8, 20);
  return {
    id: patch.id ?? "b1",
    kind: "subscription",
    name: "Netflix",
    fallbackColor: "#ef4444",
    amount: 68,
    cycle: "monthly",
    status: "active",
    reminderOffsets: [3, 1],
    remindedFor: { dueAt: nextDueAt, offsets: [] },
    history: [],
    createdAt: ts(2026, 1, 1),
    ...patch,
    nextDueAt,
  };
}

describe("advanceCycle 周期滚动", () => {
  it("月付 1/31 → 2/28（平年钳制月末）", () => {
    expect(advanceCycle(ts(2026, 1, 31), "monthly")).toBe(ts(2026, 2, 28));
  });

  it("月付 1/31 → 2/29（闰年）", () => {
    expect(advanceCycle(ts(2028, 1, 31), "monthly")).toBe(ts(2028, 2, 29));
  });

  it("年付 2/29 → 次年 2/28", () => {
    expect(advanceCycle(ts(2028, 2, 29), "yearly")).toBe(ts(2029, 2, 28));
  });

  it("季付 8/31 → 11/30", () => {
    expect(advanceCycle(ts(2026, 8, 31), "quarterly")).toBe(ts(2026, 11, 30));
  });

  it("半年付 8/31 → 次年 2/28", () => {
    expect(advanceCycle(ts(2026, 8, 31), "semiannual")).toBe(ts(2027, 2, 28));
  });

  it("周付跨月末整数天推进", () => {
    expect(advanceCycle(ts(2026, 8, 28), "weekly")).toBe(ts(2026, 9, 4));
  });

  it("钳到月末后不粘滞：2/28 月付 → 3/28（按原始日回弹靠 UI 层不做，记录即事实）", () => {
    expect(advanceCycle(ts(2026, 2, 28), "monthly")).toBe(ts(2026, 3, 28));
  });
});

describe("dueBillsToRemind 多档去重", () => {
  const due = ts(2026, 8, 20);

  it("提前 3 天档在 3 天前命中，1 天档尚未命中", () => {
    const hits = dueBillsToRemind([bill()], ts(2026, 8, 17, 9));
    expect(hits.map((h) => h.offset)).toEqual([3]);
  });

  it("已提醒过的档不再命中；到期临近后新档命中", () => {
    const b = bill({ remindedFor: { dueAt: due, offsets: [3] } });
    expect(dueBillsToRemind([b], ts(2026, 8, 17, 9))).toEqual([]);
    expect(dueBillsToRemind([b], ts(2026, 8, 19, 9)).map((h) => h.offset)).toEqual([1]);
  });

  it("当天档（0）在到期日 00:00 起命中", () => {
    const b = bill({ reminderOffsets: [0] });
    expect(dueBillsToRemind([b], ts(2026, 8, 19, 23, 59))).toEqual([]);
    expect(dueBillsToRemind([b], ts(2026, 8, 20, 0, 1)).map((h) => h.offset)).toEqual([0]);
  });

  it("remindedFor 账期不一致时防御性视为空（滚动后可再次提醒）", () => {
    const b = bill({ remindedFor: { dueAt: ts(2026, 7, 20), offsets: [3, 1] } });
    expect(dueBillsToRemind([b], ts(2026, 8, 19, 9)).map((h) => h.offset)).toEqual([3, 1]);
  });

  it("暂停/取消/无档账单不提醒", () => {
    expect(dueBillsToRemind([bill({ status: "paused" })], ts(2026, 8, 19))).toEqual([]);
    expect(dueBillsToRemind([bill({ status: "canceled" })], ts(2026, 8, 19))).toEqual([]);
    expect(dueBillsToRemind([bill({ reminderOffsets: [] })], ts(2026, 8, 19))).toEqual([]);
  });
});

describe("消费聚合", () => {
  it("monthlySpendTotal = 本月记账 + active 本月剩余投影；暂停/取消不投影但历史仍计", () => {
    const now = ts(2026, 8, 16);
    const bills: Bill[] = [
      // 本月已滚过一期（history），下期 9 月：只计历史 68
      bill({
        id: "a",
        nextDueAt: ts(2026, 9, 10),
        history: [
          { id: "e1", periodDueAt: ts(2026, 8, 10), amount: 68, paidAt: ts(2026, 8, 10), method: "auto" },
        ],
      }),
      // 本月 20 号到期的 active：投影 25
      bill({ id: "b", amount: 25, nextDueAt: ts(2026, 8, 20) }),
      // 已暂停：本月历史 10 仍计，nextDueAt 不投影
      bill({
        id: "c",
        status: "paused",
        amount: 99,
        nextDueAt: ts(2026, 8, 25),
        history: [
          { id: "e2", periodDueAt: ts(2026, 8, 5), amount: 10, paidAt: ts(2026, 8, 5), method: "manual" },
        ],
      }),
      // 上月记账不计
      bill({
        id: "d",
        nextDueAt: ts(2026, 9, 1),
        history: [
          { id: "e3", periodDueAt: ts(2026, 7, 1), amount: 999, paidAt: ts(2026, 7, 1), method: "auto" },
        ],
      }),
    ];
    expect(monthlySpendTotal(bills, now)).toBe(68 + 25 + 10);
  });

  it("周付在本月内的多期全部投影", () => {
    const now = ts(2026, 8, 1);
    const b = bill({ amount: 10, nextDueAt: ts(2026, 8, 4), cycle: "weekly" });
    // 8/4、8/11、8/18、8/25 共 4 期
    expect(monthlySpendTotal([b], now)).toBe(40);
  });

  it("sixMonthTrend 按记账月份分桶、空月补 0（跨年）", () => {
    const now = ts(2026, 2, 15);
    const b = bill({
      history: [
        { id: "e1", periodDueAt: ts(2025, 9, 1), amount: 30, paidAt: ts(2025, 9, 1), method: "auto" },
        { id: "e2", periodDueAt: ts(2025, 12, 1), amount: 40, paidAt: ts(2025, 12, 1), method: "auto" },
        { id: "e3", periodDueAt: ts(2026, 2, 1), amount: 50, paidAt: ts(2026, 2, 1), method: "auto" },
        // 窗口外（6 个月前）不计
        { id: "e4", periodDueAt: ts(2025, 8, 1), amount: 999, paidAt: ts(2025, 8, 1), method: "auto" },
      ],
    });
    const trend = sixMonthTrend([b], now);
    expect(trend.map((m) => m.label)).toEqual(["9月", "10月", "11月", "12月", "1月", "2月"]);
    expect(trend.map((m) => m.total)).toEqual([30, 0, 0, 40, 0, 50]);
  });

  it("billsDueWithinDays 只含未来 7 天 active（含今天，逾期与暂停排除）", () => {
    const now = ts(2026, 8, 16, 10);
    const list = billsDueWithinDays(
      [
        bill({ id: "today", nextDueAt: ts(2026, 8, 16) }),
        bill({ id: "in6", nextDueAt: ts(2026, 8, 22) }),
        bill({ id: "in7", nextDueAt: ts(2026, 8, 23) }),
        bill({ id: "overdue", nextDueAt: ts(2026, 8, 15) }),
        bill({ id: "paused", status: "paused", nextDueAt: ts(2026, 8, 17) }),
      ],
      now
    );
    expect(list.map((b) => b.id)).toEqual(["today", "in6"]);
  });
});

describe("文案与排序", () => {
  it("billDueLabel 单笔货币优先于全局符号", () => {
    const now = ts(2026, 8, 17, 9);
    expect(
      billDueLabel(bill({ currency: "US$", amount: 15.99, nextDueAt: ts(2026, 8, 20) }), now, "¥")
    ).toBe("Netflix 3 天后续费 US$15.99");
  });

  it("billDueLabel 覆盖 今天/明天/N天后/逾期 与信用卡动词", () => {
    const now = ts(2026, 8, 17, 9);
    expect(billDueLabel(bill({ nextDueAt: ts(2026, 8, 20) }), now, "¥")).toBe(
      "Netflix 3 天后续费 ¥68"
    );
    expect(billDueLabel(bill({ nextDueAt: ts(2026, 8, 17) }), now, "¥")).toBe(
      "Netflix 今天续费 ¥68"
    );
    const card = bill({
      kind: "creditCard",
      name: "招商银行信用卡",
      amount: null,
      nextDueAt: ts(2026, 8, 15),
    });
    expect(billDueLabel(card, now, "¥")).toBe("招商银行信用卡 还款已逾期 2 天");
  });

  it("compareBills：active 按到期升序在前，暂停/取消垫底", () => {
    const sorted = [
      bill({ id: "p", status: "paused" }),
      bill({ id: "late", nextDueAt: ts(2026, 9, 1) }),
      bill({ id: "soon", nextDueAt: ts(2026, 8, 18) }),
    ].sort(compareBills);
    expect(sorted.map((b) => b.id)).toEqual(["soon", "late", "p"]);
  });

  it("billFallbackColor 对同名稳定", () => {
    expect(billFallbackColor("Netflix")).toBe(billFallbackColor("Netflix"));
    expect(billFallbackColor("Netflix")).toMatch(/^#/);
  });

  it("startOfBillDay 归到本地 00:00", () => {
    expect(startOfBillDay(ts(2026, 8, 16, 23, 59))).toBe(ts(2026, 8, 16));
  });
});

describe("store 账单 actions", () => {
  const reset = () =>
    useNotesStore.setState({ bills: [], undoStack: [], checkedIds: [] });

  it("addBill 缺省提醒档取设置默认；updateBill 改到期日重置当期已提醒", () => {
    reset();
    const id = useNotesStore.getState().addBill({
      kind: "subscription",
      name: "Claude Pro",
      amount: 140,
      cycle: "monthly",
      nextDueAt: ts(2026, 9, 1),
      fallbackColor: "#ef4444",
    });
    const created = useNotesStore.getState().bills.find((b) => b.id === id)!;
    expect(created.reminderOffsets).toEqual(
      useNotesStore.getState().settings.billDefaultReminderOffsets
    );
    useNotesStore.getState().markBillsReminded([{ billId: id, offset: 3 }]);
    useNotesStore.getState().updateBill(id, { nextDueAt: ts(2026, 10, 1) });
    const updated = useNotesStore.getState().bills.find((b) => b.id === id)!;
    expect(updated.remindedFor).toEqual({ dueAt: ts(2026, 10, 1), offsets: [] });
  });

  it("rollBillsIfDue 跨多期补记 auto 记账并重置提醒；信用卡不滚", () => {
    reset();
    const now = ts(2026, 8, 16);
    useNotesStore.setState({
      bills: [
        bill({ id: "sub", amount: 10, cycle: "weekly", nextDueAt: ts(2026, 8, 2) }),
        bill({ id: "card", kind: "creditCard", nextDueAt: ts(2026, 8, 10) }),
      ],
    });
    useNotesStore.getState().rollBillsIfDue(now);
    const sub = useNotesStore.getState().bills.find((b) => b.id === "sub")!;
    // 8/2、8/9、8/16 三期滚过，下期 8/23
    expect(sub.nextDueAt).toBe(ts(2026, 8, 23));
    expect(sub.history.map((e) => e.periodDueAt)).toEqual([
      ts(2026, 8, 2),
      ts(2026, 8, 9),
      ts(2026, 8, 16),
    ]);
    expect(sub.history.every((e) => e.method === "auto" && e.amount === 10)).toBe(true);
    expect(sub.remindedFor).toEqual({ dueAt: ts(2026, 8, 23), offsets: [] });
    const card = useNotesStore.getState().bills.find((b) => b.id === "card")!;
    expect(card.nextDueAt).toBe(ts(2026, 8, 10));
    expect(card.history).toEqual([]);
  });

  it("markBillPaid 落 manual 记账、金额回写、滚到下期", () => {
    reset();
    useNotesStore.setState({
      bills: [
        bill({ id: "card", kind: "creditCard", amount: null, nextDueAt: ts(2026, 8, 20) }),
      ],
    });
    useNotesStore.getState().markBillPaid("card", 1234.5);
    const card = useNotesStore.getState().bills.find((b) => b.id === "card")!;
    expect(card.amount).toBe(1234.5);
    expect(card.nextDueAt).toBe(ts(2026, 9, 20));
    expect(card.history).toHaveLength(1);
    expect(card.history[0]).toMatchObject({
      periodDueAt: ts(2026, 8, 20),
      amount: 1234.5,
      method: "manual",
    });
  });

  it("deleteBill 可撤销", () => {
    reset();
    useNotesStore.setState({ bills: [bill({ id: "x", name: "Spotify" })] });
    useNotesStore.getState().deleteBill("x");
    expect(useNotesStore.getState().bills).toHaveLength(0);
    const label = useNotesStore.getState().undo();
    expect(label).toBe("删除「Spotify」");
    expect(useNotesStore.getState().bills.map((b) => b.id)).toEqual(["x"]);
  });
});

describe("持久化归一化", () => {
  it("坏枚举拒绝解码", () => {
    const envelope = (billPatch: Record<string, unknown>) =>
      JSON.stringify({
        version: 19,
        state: {
          sections: [],
          notes: [],
          tasks: [],
          taskSections: [],
          bills: [{ ...bill(), ...billPatch }],
        },
      });
    expect(() => decodePersistedState(envelope({ kind: "loan" }))).toThrow(/bill\.kind/);
    expect(() => decodePersistedState(envelope({ cycle: "daily" }))).toThrow(/bill\.cycle/);
    expect(() => decodePersistedState(envelope({ status: "gone" }))).toThrow(/bill\.status/);
  });

  it("currency/category/payMethod 非字符串或空值归一为 undefined", () => {
    const decoded = decodePersistedState(
      JSON.stringify({
        version: 19,
        state: {
          sections: [],
          notes: [],
          tasks: [],
          taskSections: [],
          bills: [{ ...bill(), currency: 5, category: "", payMethod: "支付宝" }],
        },
      })
    );
    const b = decoded.bills[0];
    expect(b.currency).toBeUndefined();
    expect(b.category).toBeUndefined();
    expect(b.payMethod).toBe("支付宝");
  });

  it("非法提醒档过滤、remindedFor 账期不一致重置、history 裁剪保序", () => {
    const decoded = decodePersistedState(
      JSON.stringify({
        version: 19,
        state: {
          sections: [],
          notes: [],
          tasks: [],
          taskSections: [],
          bills: [
            {
              ...bill({ nextDueAt: ts(2026, 8, 20) }),
              reminderOffsets: [7, 5, 3, 3, "x"],
              remindedFor: { dueAt: ts(2026, 7, 20), offsets: [3] },
            },
          ],
        },
      })
    );
    const b = decoded.bills[0];
    expect(b.reminderOffsets).toEqual([7, 3]);
    expect(b.remindedFor).toEqual({ dueAt: ts(2026, 8, 20), offsets: [] });
  });
});
