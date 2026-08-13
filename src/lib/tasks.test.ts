import { describe, expect, it } from "vitest";

import { TASK_INBOX_ID, type Task } from "@/store/notesStore";
import {
  bucketTasksForDisplay,
  compareTasks,
  dueBadgeLabel,
  dueBadgeShortLabel,
  dueTasksToRemind,
  isSmartBandTask,
  presetCfgDue,
  presetCfgLabel,
  sortTasks,
} from "./tasks";

let seq = 0;
function task(patch: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    text: `任务${seq}`,
    status: "todo",
    priority: "none",
    dueAt: null,
    createdAt: seq,
    remindedAt: null,
    ...patch,
  };
}

// 固定基准：2026-08-05（周三）12:00 本地时间
const NOW = new Date(2026, 7, 5, 12, 0, 0, 0).getTime();

describe("compareTasks / sortTasks", () => {
  it("状态优先：doing 在 todo 前", () => {
    const a = task({ status: "todo" });
    const b = task({ status: "doing" });
    expect(sortTasks([a, b]).map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it("同状态按优先级 high > mid > low > none", () => {
    const n = task({ priority: "none" });
    const h = task({ priority: "high" });
    const l = task({ priority: "low" });
    const m = task({ priority: "mid" });
    expect(sortTasks([n, h, l, m]).map((t) => t.priority)).toEqual([
      "high",
      "mid",
      "low",
      "none",
    ]);
  });

  it("同状态同优先级按 dueAt 早在前，null 最后", () => {
    const none = task({});
    const late = task({ dueAt: NOW + 2000 });
    const soon = task({ dueAt: NOW + 1000 });
    expect(sortTasks([none, late, soon]).map((t) => t.id)).toEqual([
      soon.id,
      late.id,
      none.id,
    ]);
  });

  it("完全同级按 createdAt 稳定排序", () => {
    const a = task({});
    const b = task({});
    expect(compareTasks(a, b)).toBeLessThan(0);
  });
});

const SECTIONS = [{ id: TASK_INBOX_ID, name: "收集箱" }];

describe("bucketTasksForDisplay", () => {
  it("逾期未完成横切状态/类型一律进 overdue，不重复出现", () => {
    const overTodo = task({ status: "todo", dueAt: NOW - 1 });
    const overSpark = task({ kind: "spark", dueAt: NOW - 1 });
    const doing = task({ status: "doing" });
    const b = bucketTasksForDisplay([overTodo, overSpark, doing], SECTIONS, NOW);
    expect(b.overdue.map((t) => t.id).sort()).toEqual(
      [overTodo.id, overSpark.id].sort()
    );
    expect(b.groups[0].tasks.map((t) => t.id)).toEqual([doing.id]);
    expect(b.sparks).toEqual([]);
  });

  it("闪念进灵感区（新在前），不与分组混排", () => {
    const s1 = task({ kind: "spark" });
    const s2 = task({ kind: "spark" });
    const t1 = task({});
    const b = bucketTasksForDisplay([s1, s2, t1], SECTIONS, NOW);
    expect(b.sparks.map((t) => t.id)).toEqual([s2.id, s1.id]);
    expect(b.groups[0].tasks.map((t) => t.id)).toEqual([t1.id]);
  });

  it("按分组归位；孤儿分组兜底收集箱；组内保持数组顺序（手动排序，不再按状态/优先级自动排）", () => {
    const secs = [...SECTIONS, { id: "g1", name: "工作" }];
    const inG1 = task({ sectionId: "g1" });
    const orphan = task({ sectionId: "ghost" });
    // doingG1 状态优先级更高，但手动排序下顺位仍由数组位置决定（排在 inG1 之后）
    const doingG1 = task({ sectionId: "g1", status: "doing" });
    const b = bucketTasksForDisplay([inG1, orphan, doingG1], secs, NOW);
    expect(b.groups.map((g) => g.section.id)).toEqual([TASK_INBOX_ID, "g1"]);
    expect(b.groups[0].tasks.map((t) => t.id)).toEqual([orphan.id]);
    expect(b.groups[1].tasks.map((t) => t.id)).toEqual([inG1.id, doingG1.id]);
  });

  it("已到期按到期时间升序排列（不再走状态/优先级复合排序）", () => {
    const soon = task({ dueAt: NOW - 1000, priority: "low" });
    // later 优先级更高但更晚到期：手动/优先级排序均不再影响已到期区顺序
    const later = task({ dueAt: NOW - 500, priority: "high" });
    const earliest = task({ dueAt: NOW - 5000, priority: "none" });
    const b = bucketTasksForDisplay([soon, later, earliest], SECTIONS, NOW);
    expect(b.overdue.map((t) => t.id)).toEqual([earliest.id, soon.id, later.id]);
  });

  it("done 即便逾期/闪念也只进 done 桶，按创建时间倒序", () => {
    const d1 = task({ status: "done", dueAt: NOW - 1 });
    const d2 = task({ status: "done", kind: "spark" });
    const b = bucketTasksForDisplay([d1, d2], SECTIONS, NOW);
    expect(b.overdue).toEqual([]);
    expect(b.sparks).toEqual([]);
    expect(b.done.map((t) => t.id)).toEqual([d2.id, d1.id]);
  });

  it("空输入：智能区皆空，分组保留为空组", () => {
    const b = bucketTasksForDisplay([], SECTIONS, NOW);
    expect(b.overdue).toEqual([]);
    expect(b.sparks).toEqual([]);
    expect(b.done).toEqual([]);
    expect(b.groups).toHaveLength(1);
    expect(b.groups[0].tasks).toEqual([]);
  });
});

describe("isSmartBandTask", () => {
  it("已完成 / 已到期 / 闪念 → true；普通未到期任务 → false", () => {
    expect(isSmartBandTask(task({ status: "done" }), NOW)).toBe(true);
    expect(isSmartBandTask(task({ dueAt: NOW - 1 }), NOW)).toBe(true);
    expect(isSmartBandTask(task({ kind: "spark" }), NOW)).toBe(true);
    expect(isSmartBandTask(task({}), NOW)).toBe(false);
    expect(isSmartBandTask(task({ dueAt: NOW + 60_000 }), NOW)).toBe(false);
  });
});

describe("dueTasksToRemind", () => {
  it("未完成 + 已到期 + 未提醒 → 命中", () => {
    const hit = task({ dueAt: NOW - 1 });
    expect(dueTasksToRemind([hit], NOW).map((t) => t.id)).toEqual([hit.id]);
  });

  it("已提醒 / 已完成 / 无到期 / 未来 均不命中", () => {
    const reminded = task({ dueAt: NOW - 1, remindedAt: NOW - 1 });
    const done = task({ status: "done", dueAt: NOW - 1 });
    const noDue = task({});
    const future = task({ dueAt: NOW + 60_000 });
    expect(dueTasksToRemind([reminded, done, noDue, future], NOW)).toEqual([]);
  });
});

describe("presetCfgDue（NOW = 2026-08-05 周三 12:00）", () => {
  const local = (y: number, mo: number, day: number, h: number, min = 0) =>
    new Date(y, mo, day, h, min, 0, 0).getTime();

  it("相对档：30 分钟 / 1 / 3 / 6 小时后", () => {
    expect(presetCfgDue({ id: "a", kind: "relative", minutes: 30 }, NOW)).toBe(
      NOW + 30 * 60_000
    );
    expect(presetCfgDue({ id: "b", kind: "relative", minutes: 60 }, NOW)).toBe(
      NOW + 3_600_000
    );
    expect(presetCfgDue({ id: "c", kind: "relative", minutes: 180 }, NOW)).toBe(
      NOW + 3 * 3_600_000
    );
    expect(presetCfgDue({ id: "d", kind: "relative", minutes: 360 }, NOW)).toBe(
      NOW + 6 * 3_600_000
    );
  });

  it("今天定点：已过也不隐式跳明天", () => {
    const cfg = { id: "t", kind: "today", hour: 20, minute: 0 } as const;
    expect(presetCfgDue(cfg, NOW)).toBe(local(2026, 7, 5, 20));
    const lateNow = new Date(2026, 7, 5, 22, 0).getTime();
    expect(presetCfgDue(cfg, lateNow)).toBe(local(2026, 7, 5, 20));
  });

  it("明天定点带分钟", () => {
    expect(
      presetCfgDue({ id: "m", kind: "tomorrow", hour: 9, minute: 30 }, NOW)
    ).toBe(local(2026, 7, 6, 9, 30));
  });

  it("周几档「下个」语义排除当天：周一时是 7 天后", () => {
    const cfg = { id: "w", kind: "weekday", weekday: 1, hour: 9, minute: 0 } as const;
    expect(presetCfgDue(cfg, NOW)).toBe(local(2026, 7, 10, 9)); // 周三→下周一
    const mon = new Date(2026, 7, 10, 8, 0).getTime();
    expect(presetCfgDue(cfg, mon)).toBe(local(2026, 7, 17, 9));
  });

  it("presetCfgLabel：分钟/整小时/定点/周几", () => {
    expect(presetCfgLabel({ id: "a", kind: "relative", minutes: 45 })).toBe("45 分钟后");
    expect(presetCfgLabel({ id: "b", kind: "relative", minutes: 360 })).toBe("6 小时后");
    expect(presetCfgLabel({ id: "c", kind: "today", hour: 20, minute: 0 })).toBe(
      "今天 20:00"
    );
    expect(
      presetCfgLabel({ id: "d", kind: "weekday", weekday: 6, hour: 9, minute: 30 })
    ).toBe("下个周六 9:30");
  });
});

describe("dueBadgeLabel", () => {
  it("逾期分钟/小时/天", () => {
    expect(dueBadgeLabel(NOW - 30 * 60_000, NOW)).toBe("30 分钟前到期");
    expect(dueBadgeLabel(NOW - 3 * 3_600_000, NOW)).toBe("3 小时前到期");
    expect(dueBadgeLabel(NOW - 50 * 3_600_000, NOW)).toBe("2 天前到期");
  });

  it("未来：今天/明天/一周内周几/更远日期", () => {
    const at = (d: number, h: number) => new Date(2026, 7, d, h, 0).getTime();
    expect(dueBadgeLabel(at(5, 20), NOW)).toBe("今天 20:00");
    expect(dueBadgeLabel(at(6, 9), NOW)).toBe("明天 09:00");
    expect(dueBadgeLabel(at(8, 9), NOW)).toBe("周六 09:00");
    expect(dueBadgeLabel(at(20, 9), NOW)).toBe("8月20日 09:00");
  });

  it("短文案：仅剥逾期「到期」后缀，未来文案原样", () => {
    expect(dueBadgeShortLabel(NOW - 3 * 3_600_000, NOW)).toBe("3 小时前");
    const at = (d: number, h: number) => new Date(2026, 7, d, h, 0).getTime();
    expect(dueBadgeShortLabel(at(5, 20), NOW)).toBe("今天 20:00");
  });
});
