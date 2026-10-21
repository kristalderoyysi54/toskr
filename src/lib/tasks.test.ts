import { describe, expect, it } from "vitest";

import { TASK_INBOX_ID, type Task, type TaskRecurrence } from "@/store/notesStore";
import {
  bucketTasksForDisplay,
  compareTasks,
  dueBadgeLabel,
  dueBadgeShortLabel,
  filterTasks,
  isSmartBandTask,
  presetCfgDue,
  presetCfgLabel,
  reminderHitLabel,
  sortTasks,
  taskRemindersDue,
  todayAgenda,
  todayDefaultDue,
} from "./tasks";
import { nextRecurrence, nextRecurrenceDue, recurrenceLabel } from "./taskRecurrence";

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

describe("taskRemindersDue", () => {
  const ids = (hits: { task: Task }[]) => hits.map((h) => h.task.id);

  it("缺省只有到期档：未完成 + 已到期 + 未提醒 → 命中", () => {
    const hit = task({ dueAt: NOW - 1 });
    expect(taskRemindersDue([hit], NOW)).toEqual([{ task: hit, offsets: [0] }]);
  });

  it("已提醒 / 已完成 / 无到期 / 未来 均不命中", () => {
    const reminded = task({ dueAt: NOW - 1, remindedAt: NOW - 1 });
    const done = task({ status: "done", dueAt: NOW - 1 });
    const noDue = task({});
    const future = task({ dueAt: NOW + 60_000 });
    expect(taskRemindersDue([reminded, done, noDue, future], NOW)).toEqual([]);
  });

  it("提前档：进入提前窗口命中一次，已记录的档位不再命中", () => {
    const soon = task({ dueAt: NOW + 10 * 60_000, reminderOffsets: [0, 15, 60] });
    expect(taskRemindersDue([soon], NOW)[0].offsets).toEqual([15, 60]);
    const marked = { ...soon, earlyRemindedOffsets: [15, 60] as Task["earlyRemindedOffsets"] };
    expect(taskRemindersDue([marked], NOW)).toEqual([]);
  });

  it("已逾期不补发提前档；空数组 = 不提醒", () => {
    const overdue = task({ dueAt: NOW - 1, reminderOffsets: [15] });
    const silent = task({ dueAt: NOW - 1, reminderOffsets: [] });
    expect(ids(taskRemindersDue([overdue, silent], NOW))).toEqual([]);
  });

  it("提前档文案带剩余时间，到期档只用标题", () => {
    const soon = task({ dueAt: NOW + 15 * 60_000 });
    expect(reminderHitLabel({ task: soon, offsets: [15] }, NOW, "开会")).toBe("开会 · 15 分钟后到期");
    expect(reminderHitLabel({ task: soon, offsets: [0] }, NOW, "开会")).toBe("开会");
  });
});

describe("nextRecurrenceDue（NOW = 2026-08-05 周三 12:00）", () => {
  const local = (mo: number, day: number, h: number, y = 2026) =>
    new Date(y, mo, day, h, 0, 0, 0).getTime();
  const due = local(7, 5, 9);

  it("每天：按计划推一天并保留时刻", () => {
    expect(nextRecurrenceDue({ freq: "daily" }, due, NOW)).toBe(local(7, 6, 9));
  });

  it("逾期多日才完成：跳过已过去的期次", () => {
    expect(nextRecurrenceDue({ freq: "daily" }, local(7, 1, 9), NOW)).toBe(local(7, 6, 9));
  });

  it("工作日：周五 → 下周一", () => {
    expect(nextRecurrenceDue({ freq: "weekdays" }, local(7, 7, 9), local(7, 7, 10))).toBe(local(7, 10, 9));
  });

  it("每周指定周几：周三 → 同周周五", () => {
    expect(nextRecurrenceDue({ freq: "weekly", weekdays: [1, 5] }, due, NOW)).toBe(local(7, 7, 9));
  });

  it("每周缺省星期取本期当天", () => {
    expect(nextRecurrenceDue({ freq: "weekly" }, due, NOW)).toBe(local(7, 12, 9));
  });

  it("每月 31 日：小月取月末，下一期回到 31 日", () => {
    const jan31 = local(0, 31, 9);
    const feb = nextRecurrenceDue({ freq: "monthly", monthDay: 31 }, jan31, jan31);
    expect(feb).toBe(local(1, 28, 9));
    expect(nextRecurrenceDue({ freq: "monthly", monthDay: 31 }, feb, feb)).toBe(local(2, 31, 9));
  });

  it("每年：同月同日", () => {
    expect(nextRecurrenceDue({ freq: "yearly" }, due, NOW)).toBe(local(7, 5, 9, 2027));
  });

  it("从完成时起算：以完成日为基准", () => {
    const done = local(7, 9, 15);
    expect(nextRecurrenceDue({ freq: "daily", basis: "completion" }, due, done)).toBe(local(7, 10, 9));
  });

  it("共 N 次：下一期减 1，剩 1 次时不再生成", () => {
    expect(nextRecurrence({ freq: "daily", count: 3 }, due, NOW)).toEqual({
      dueAt: local(7, 6, 9),
      recurrence: { freq: "daily", count: 2 },
    });
    expect(nextRecurrence({ freq: "daily", count: 1 }, due, NOW)).toBeNull();
  });

  it("到某天为止：含结束当天，之后不再生成", () => {
    const rec = { freq: "daily" as const, until: local(7, 6, 0) };
    expect(nextRecurrence(rec, due, NOW)?.dueAt).toBe(local(7, 6, 9));
    expect(nextRecurrence(rec, local(7, 6, 9), local(7, 6, 10))).toBeNull();
  });

  it("标签", () => {
    expect(recurrenceLabel({ freq: "weekly", weekdays: [1, 5] }, due)).toBe("每周一五");
    expect(recurrenceLabel({ freq: "monthly" }, due)).toBe("每月 5 日");
    expect(recurrenceLabel({ freq: "daily", basis: "completion" }, due)).toBe("每天（完成后起算）");
    expect(recurrenceLabel({ freq: "daily", count: 3 }, due)).toBe("每天，剩 3 次");
    expect(recurrenceLabel({ freq: "daily", until: local(11, 31, 0) }, due)).toBe("每天，到 2026/12/31");
  });
});

describe("每年重复：闰日与从完成时起算", () => {
  const at = (y: number, mo: number, day: number, h = 9, min = 0) =>
    new Date(y, mo, day, h, min, 0, 0).getTime();
  /** 连续完成 n 期（每期到期即完成），返回各期到期日。 */
  const chain = (rec: TaskRecurrence, dueAt: number, n: number) => {
    const out = [dueAt];
    let cur: { dueAt: number; recurrence: TaskRecurrence } | null = { dueAt, recurrence: rec };
    for (let i = 0; i < n && cur; i++) {
      cur = nextRecurrence(cur.recurrence, cur.dueAt, cur.dueAt);
      if (cur) out.push(cur.dueAt);
    }
    return out;
  };

  it("按计划：2/29 平年取 2/28，下个闰年回到 2/29", () => {
    expect(chain({ freq: "yearly" }, at(2024, 1, 29, 8, 30), 4)).toEqual([
      at(2024, 1, 29, 8, 30),
      at(2025, 1, 28, 8, 30),
      at(2026, 1, 28, 8, 30),
      at(2027, 1, 28, 8, 30),
      at(2028, 1, 29, 8, 30),
    ]);
  });

  it("按计划：首期补齐锚点并带进下一期规则", () => {
    expect(nextRecurrence({ freq: "yearly" }, at(2024, 1, 29), at(2024, 1, 29))?.recurrence).toEqual({
      freq: "yearly",
      yearlyAnchor: { month: 1, day: 29 },
    });
  });

  it("按计划：2100 年非闰年仍取 2/28，2104 年回到 2/29", () => {
    const rec = { freq: "yearly" as const, yearlyAnchor: { month: 1, day: 29 } };
    expect(nextRecurrenceDue(rec, at(2096, 1, 29), at(2096, 1, 29))).toBe(at(2097, 1, 28));
    expect(nextRecurrenceDue(rec, at(2099, 1, 28), at(2099, 1, 28))).toBe(at(2100, 1, 28));
    expect(nextRecurrenceDue(rec, at(2103, 1, 28), at(2103, 1, 28))).toBe(at(2104, 1, 29));
  });

  it("按计划：逾期多年才完成，跳过已过去的期次且保留原始月日", () => {
    const rec = { freq: "yearly" as const, yearlyAnchor: { month: 1, day: 29 } };
    expect(nextRecurrenceDue(rec, at(2025, 1, 28), at(2027, 5, 1))).toBe(at(2028, 1, 29));
  });

  it("按计划：本期改过日期，规则仍按锚点", () => {
    const rec = { freq: "yearly" as const, yearlyAnchor: { month: 1, day: 29 } };
    expect(nextRecurrenceDue(rec, at(2027, 2, 3), at(2027, 2, 3))).toBe(at(2028, 1, 29));
  });

  it("按计划：次数与结束日照常生效，锚点随规则带下去", () => {
    expect(nextRecurrence({ freq: "yearly", count: 3 }, at(2024, 1, 29), at(2024, 1, 29))).toEqual({
      dueAt: at(2025, 1, 28),
      recurrence: { freq: "yearly", count: 2, yearlyAnchor: { month: 1, day: 29 } },
    });
    const until = { freq: "yearly" as const, until: at(2027, 11, 31, 0) };
    expect(chain(until, at(2024, 1, 29), 10)).toEqual([
      at(2024, 1, 29),
      at(2025, 1, 28),
      at(2026, 1, 28),
      at(2027, 1, 28),
    ]);
  });

  it("从完成时：完成日加一个日历年，保留本期时刻", () => {
    const rec = { freq: "yearly" as const, basis: "completion" as const };
    expect(nextRecurrenceDue(rec, at(2024, 1, 29, 8, 30), at(2024, 2, 10, 15))).toBe(at(2025, 2, 10, 8, 30));
  });

  it("从完成时：逾期跨年完成不再空出近两年", () => {
    const rec = { freq: "yearly" as const, basis: "completion" as const };
    expect(nextRecurrenceDue(rec, at(2024, 11, 31), at(2025, 0, 5, 10))).toBe(at(2026, 0, 5));
  });

  it("从完成时：2/29 完成，次年取 2/28；不写锚点，之后按实际完成日", () => {
    const rec = { freq: "yearly" as const, basis: "completion" as const, yearlyAnchor: { month: 1, day: 29 } };
    const first = nextRecurrence(rec, at(2024, 1, 29), at(2024, 1, 29, 10));
    expect(first).toEqual({ dueAt: at(2025, 1, 28), recurrence: { freq: "yearly", basis: "completion" } });
    expect(chain(first!.recurrence, first!.dueAt, 3).slice(1)).toEqual([
      at(2026, 1, 28),
      at(2027, 1, 28),
      at(2028, 1, 28),
    ]);
  });

  it("标签：按计划显示原始月日，从完成时不显示固定日期", () => {
    expect(recurrenceLabel({ freq: "yearly", yearlyAnchor: { month: 1, day: 29 } }, at(2025, 1, 28))).toBe(
      "每年 2/29"
    );
    expect(recurrenceLabel({ freq: "yearly" }, at(2025, 4, 3))).toBe("每年 5/3");
    expect(recurrenceLabel({ freq: "yearly", basis: "completion" }, at(2025, 4, 3))).toBe("每年（完成后起算）");
  });
});

describe("filterTasks", () => {
  it("关键词匹配标题/备注/检查项，默认排除已完成", () => {
    const a = task({ text: "发布 v1" });
    const b = task({ text: "写文档", note: "发布说明" });
    const c = task({ text: "杂事", checklist: [{ id: "c", text: "发布前检查", done: false }] });
    const d = task({ text: "发布 v0", status: "done" });
    const hit = filterTasks([a, b, c, d], { query: "发布", chips: [] }, NOW).map((t) => t.id);
    expect(hit.sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it("chip 取交集：本周 + 高优先级；已完成 chip 只看已完成", () => {
    const a = task({ priority: "high", dueAt: NOW + 86_400_000 });
    const b = task({ priority: "high", dueAt: NOW + 10 * 86_400_000 });
    const c = task({ priority: "low", dueAt: NOW + 86_400_000 });
    const d = task({ status: "done" });
    expect(filterTasks([a, b, c, d], { query: "", chips: ["week", "high"] }, NOW)).toEqual([a]);
    expect(filterTasks([a, b, c, d], { query: "", chips: ["done"] }, NOW)).toEqual([d]);
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

describe("todayAgenda（NOW = 2026-08-05 12:00）", () => {
  const at = (day: number, h: number) => new Date(2026, 7, day, h, 0, 0, 0).getTime();

  it("今天到期进时间轴（含已完成、按时刻），往日未完成进 earlier，其余忽略", () => {
    const morning = task({ dueAt: at(5, 9), status: "done", completedAt: at(5, 10) });
    const evening = task({ dueAt: at(5, 20) });
    const noon = task({ dueAt: at(5, 11) });
    const old = task({ dueAt: at(3, 9) });
    const oldDone = task({ dueAt: at(3, 9), status: "done" });
    const tomorrow = task({ dueAt: at(6, 9) });
    const noDue = task({});
    const r = todayAgenda([evening, morning, old, oldDone, tomorrow, noDue, noon], NOW);
    expect(r.timeline.map((t) => t.id)).toEqual([morning.id, noon.id, evening.id]);
    expect(r.earlier.map((t) => t.id)).toEqual([old.id]);
    expect(r.doneToday).toBe(1);
    expect(r.overdue).toBe(2);
  });
});

describe("todayDefaultDue", () => {
  const at = (h: number, m = 0) => new Date(2026, 7, 5, h, m, 0, 0).getTime();
  it("20:00 前取 20:00；之后取下一个整点；不跨过今天", () => {
    expect(todayDefaultDue(at(12))).toBe(at(20));
    expect(todayDefaultDue(at(20, 15))).toBe(at(21));
    expect(todayDefaultDue(at(23, 30))).toBe(at(23, 59));
  });
});
