import {
  TASK_INBOX_ID,
  type DuePresetCfg,
  type Task,
  type TaskPriority,
  type TaskReminderOffset,
  type TaskSection,
} from "@/store/notesStore";

/**
 * 任务页展示分桶：
 * 已到期(跨组横切) → ⚡灵感(跨组) → 各分组(组内按状态/优先级/到期排序) → 已完成(跨组折叠)。
 */
export interface TaskBuckets {
  overdue: Task[];
  sparks: Task[];
  groups: { section: TaskSection; tasks: Task[] }[];
  done: Task[];
}

const PRIORITY_RANK: Record<TaskPriority, number> = {
  high: 3,
  mid: 2,
  low: 1,
  none: 0,
};
const STATUS_RANK = { doing: 0, todo: 1, done: 2 } as const;

/** 排序：状态(doing>todo) > 优先级(高在前) > 到期(早在前,无到期最后) > 创建时间。 */
export function compareTasks(a: Task, b: Task): number {
  if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
    return STATUS_RANK[a.status] - STATUS_RANK[b.status];
  }
  if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
    return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
  }
  const aDue = a.dueAt ?? Infinity;
  const bDue = b.dueAt ?? Infinity;
  if (aDue !== bDue) return aDue - bDue;
  return a.createdAt - b.createdAt;
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(compareTasks);
}

/**
 * 任务是否落在智能区（已到期 / 灵感 / 已完成）——这些是横切计算出的视图，
 * 不是可投放的分组容器；拖拽跨分组时用它判断"当前悬停目标是否代表一个真实分组"。
 */
export function isSmartBandTask(t: Task, now: number): boolean {
  if (t.status === "done") return true;
  if (t.dueAt !== null && t.dueAt <= now) return true;
  if (t.kind === "spark") return true;
  return false;
}

/**
 * 分桶：逾期未完成的任务无论原状态/类型一律进 overdue（不重复出现在其他区）；
 * 闪念（spark）进灵感区；其余按所属分组归位（孤儿分组兜底收集箱）。
 *
 * 分组内展示顺序 = tasks 数组顺序（拖拽排序即数组顺序，手动排序优先于
 * 优先级/到期的自动排序——与笔记分组的 reorderNotes 同一套心智）。
 */
export function bucketTasksForDisplay(
  tasks: Task[],
  sections: TaskSection[],
  now: number
): TaskBuckets {
  const overdue: Task[] = [];
  const sparks: Task[] = [];
  const done: Task[] = [];
  const byGroup = new Map<string, Task[]>(sections.map((s) => [s.id, []]));
  for (const t of tasks) {
    if (t.status === "done") {
      done.push(t);
      continue;
    }
    if (t.dueAt !== null && t.dueAt <= now) {
      overdue.push(t);
      continue;
    }
    if (t.kind === "spark") {
      sparks.push(t);
      continue;
    }
    const key = t.sectionId && byGroup.has(t.sectionId) ? t.sectionId : TASK_INBOX_ID;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(t);
  }
  // 已到期：按到期时间升序（最紧迫的排最前）
  overdue.sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  // 灵感是流水：新想法在最上面
  sparks.sort((a, b) => b.createdAt - a.createdAt);
  // 已完成按完成时刻倒序；字段补入前完成的旧任务缺 completedAt，退回创建时间
  done.sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));
  const groups = sections.map((section) => ({
    section,
    tasks: byGroup.get(section.id) ?? [],
  }));
  return { overdue, sparks, groups, done };
}

/** 一次提醒命中：该任务本轮触发的档位（可能多档同时补发，如休眠唤醒后）。 */
export interface TaskReminderHit {
  task: Task;
  offsets: TaskReminderOffset[];
}

/**
 * 需要弹提醒的任务：未完成、有到期时间，且按 reminderOffsets（缺省 [0]）有档位
 * 已到点而未提醒过。到期档用 remindedAt 记录；提前档只在到期前有效——
 * 已经逾期的任务不再补发「还有 15 分钟」这种过时提醒，只留到期档。
 */
export function taskRemindersDue(tasks: Task[], now: number): TaskReminderHit[] {
  const hits: TaskReminderHit[] = [];
  for (const t of tasks) {
    if (t.status === "done" || t.dueAt === null) continue;
    const offsets: TaskReminderOffset[] = [];
    for (const offset of t.reminderOffsets ?? [0]) {
      if (offset === 0) {
        if (t.dueAt <= now && t.remindedAt === null) offsets.push(0);
      } else if (
        t.dueAt > now &&
        t.dueAt - offset * 60_000 <= now &&
        !(t.earlyRemindedOffsets ?? []).includes(offset)
      ) {
        offsets.push(offset);
      }
    }
    if (offsets.length) hits.push({ task: t, offsets });
  }
  return hits;
}

/** 提醒气泡文案：到期档用标题本身，提前档补「还有多久」。 */
export function reminderHitLabel(hit: TaskReminderHit, now: number, preview: string): string {
  if (hit.offsets.includes(0) || hit.task.dueAt === null) return preview;
  const mins = Math.max(1, Math.round((hit.task.dueAt - now) / 60_000));
  const left =
    mins < 60 ? `${mins} 分钟` : mins < 1440 ? `${Math.round(mins / 60)} 小时` : `${Math.round(mins / 1440)} 天`;
  return `${preview} · ${left}后到期`;
}

export const REMINDER_OFFSET_LABEL: Record<TaskReminderOffset, string> = {
  0: "到期时",
  15: "提前 15 分钟",
  60: "提前 1 小时",
  1440: "提前 1 天",
  4320: "提前 3 天",
};

// ===== 「今天」时间轴 =====

export interface TodayAgenda {
  /** 往日到期仍未完成（今天之前），按到期升序。 */
  earlier: Task[];
  /** 今天到期的全部任务（含已完成），按到期时刻排列。 */
  timeline: Task[];
  /** 今天完成的任务数（按 completedAt，不限是否今天到期）。 */
  doneToday: number;
  /** 已过到期时刻仍未完成（往日 + 今天已过点）。 */
  overdue: number;
}

export function todayAgenda(tasks: Task[], now: number): TodayAgenda {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const earlier: Task[] = [];
  const timeline: Task[] = [];
  let doneToday = 0;
  for (const t of tasks) {
    if (t.completedAt !== undefined && t.completedAt >= start && t.completedAt < end) doneToday++;
    if (t.dueAt === null) continue;
    if (t.dueAt >= start && t.dueAt < end) timeline.push(t);
    else if (t.dueAt < start && t.status !== "done") earlier.push(t);
  }
  earlier.sort((a, b) => a.dueAt! - b.dueAt!);
  timeline.sort((a, b) => a.dueAt! - b.dueAt! || a.createdAt - b.createdAt);
  const overdue =
    earlier.length + timeline.filter((t) => t.status !== "done" && t.dueAt! <= now).length;
  return { earlier, timeline, doneToday, overdue };
}

/** 今天新建任务的默认到期：20:00 前取 20:00，之后取下一个整点（不跨过今天）。 */
export function todayDefaultDue(now: number): number {
  const d = new Date(now);
  const eight = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 20, 0).getTime();
  if (now < eight) return eight;
  const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0).getTime();
  const lastMinute = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59).getTime();
  return Math.min(nextHour, lastMinute);
}

// ===== 搜索与快捷筛选 =====

export type TaskFilterChip = "week" | "high" | "checklist" | "message" | "recurring" | "done";

export interface TaskFilter {
  query: string;
  chips: TaskFilterChip[];
}

export function taskFilterActive(filter: TaskFilter): boolean {
  return filter.query.trim() !== "" || filter.chips.length > 0;
}

/**
 * 筛选（打平分组）：关键词匹配标题/备注/检查项（不区分大小写），chip 之间取交集。
 * 已完成默认排除，勾选「已完成」chip 后只看已完成。结果按 compareTasks 排序。
 */
export function filterTasks(tasks: Task[], filter: TaskFilter, now: number): Task[] {
  const q = filter.query.trim().toLowerCase();
  const chips = new Set(filter.chips);
  const today = new Date(now);
  const weekEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7).getTime();
  return sortTasks(
    tasks.filter((t) => {
      if (chips.has("done") ? t.status !== "done" : t.status === "done") return false;
      if (chips.has("week") && (t.dueAt === null || t.dueAt >= weekEnd)) return false;
      if (chips.has("high") && t.priority !== "high") return false;
      if (chips.has("checklist") && !t.checklist?.length) return false;
      if (chips.has("message") && !t.sourceRef) return false;
      if (chips.has("recurring") && !t.recurrence) return false;
      if (!q) return true;
      return [t.text, t.note ?? "", ...(t.checklist ?? []).map((c) => c.text)].some((s) =>
        s.toLowerCase().includes(q)
      );
    })
  );
}

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 档位 → 具体时间。语义固定（"今天 20:00"即使已过也不隐式跳明天；
 *  周几档「下个」语义排除当天）。 */
export function presetCfgDue(cfg: DuePresetCfg, now: number): number {
  const d = new Date(now);
  const at = (addDays: number, hour: number, minute: number) =>
    new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() + addDays,
      hour,
      minute,
      0,
      0
    ).getTime();
  switch (cfg.kind) {
    case "relative":
      return now + cfg.minutes * 60_000;
    case "today":
      return at(0, cfg.hour, cfg.minute);
    case "tomorrow":
      return at(1, cfg.hour, cfg.minute);
    case "weekday": {
      const add = (cfg.weekday - d.getDay() + 7) % 7 || 7;
      return at(add, cfg.hour, cfg.minute);
    }
  }
}

/** 档位展示名（弹层与设置页共用）。 */
export function presetCfgLabel(cfg: DuePresetCfg): string {
  const hm = (h: number, m: number) => `${h}:${String(m).padStart(2, "0")}`;
  switch (cfg.kind) {
    case "relative":
      return cfg.minutes % 60 === 0 && cfg.minutes >= 60
        ? `${cfg.minutes / 60} 小时后`
        : `${cfg.minutes} 分钟后`;
    case "today":
      return `今天 ${hm(cfg.hour, cfg.minute)}`;
    case "tomorrow":
      return `明天 ${hm(cfg.hour, cfg.minute)}`;
    case "weekday":
      return `下个${WEEKDAY_NAMES[cfg.weekday] ?? "周一"} ${hm(cfg.hour, cfg.minute)}`;
  }
}

/** 到期徽标紧迫度：决定红/琥珀/灰配色。 */
export function dueTone(dueAt: number, now: number): "overdue" | "today" | "later" {
  if (dueAt <= now) return "overdue";
  return new Date(dueAt).toDateString() === new Date(now).toDateString()
    ? "today"
    : "later";
}

/** 到期徽标文案。 */
export function dueBadgeLabel(dueAt: number, now: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date(dueAt);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (dueAt <= now) {
    const mins = Math.floor((now - dueAt) / 60_000);
    if (mins < 60) return `${Math.max(1, mins)} 分钟前到期`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前到期`;
    return `${Math.floor(hours / 24)} 天前到期`;
  }
  const startOfDay = (t: number) => {
    const x = new Date(t);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  };
  const dayDiff = Math.round((startOfDay(dueAt) - startOfDay(now)) / 86_400_000);
  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `明天 ${hm}`;
  if (dayDiff < 7) return `周${"日一二三四五六"[d.getDay()]} ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 到期徽标短文案（竖栏行内用）：已到期区头已声明「到期」，去掉行内重复后缀。 */
export function dueBadgeShortLabel(dueAt: number, now: number): string {
  return dueBadgeLabel(dueAt, now).replace(/到期$/, "");
}

/** 优先级展示表。 */
export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  none: "无优先级",
  low: "低",
  mid: "中",
  high: "高",
};
/** 优先级色条（2px 竖条）。 */
export const PRIORITY_BAR: Record<TaskPriority, string> = {
  none: "bg-black/10 dark:bg-white/10",
  low: "bg-teal-500",
  mid: "bg-amber-500",
  high: "bg-destructive",
};
