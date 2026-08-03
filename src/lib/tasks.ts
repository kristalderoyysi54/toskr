import {
  TASK_INBOX_ID,
  type Task,
  type TaskPriority,
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
 * 分桶：逾期未完成的任务无论原状态/类型一律进 overdue（不重复出现在其他区）；
 * 闪念（spark）进灵感区；其余按所属分组归位（孤儿分组兜底收集箱）。
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
  overdue.sort(compareTasks);
  // 灵感是流水：新想法在最上面
  sparks.sort((a, b) => b.createdAt - a.createdAt);
  // 已完成不再关心优先级/到期，按完成先后的近似（创建时间）倒序
  done.sort((a, b) => b.createdAt - a.createdAt);
  const groups = sections.map((section) => ({
    section,
    tasks: (byGroup.get(section.id) ?? []).sort(compareTasks),
  }));
  return { overdue, sparks, groups, done };
}

/** 需要弹到期提醒的任务：未完成、已到期、且尚未对该到期时间提醒过。 */
export function dueTasksToRemind(tasks: Task[], now: number): Task[] {
  return tasks.filter(
    (t) =>
      t.status !== "done" &&
      t.dueAt !== null &&
      t.dueAt <= now &&
      t.remindedAt === null
  );
}

export type DuePreset =
  | "tonight"
  | "tomorrowMorning"
  | "tomorrowEvening"
  | "weekend"
  | "nextMonday";

export const DUE_PRESETS: { key: DuePreset; label: string }[] = [
  { key: "tonight", label: "今晚 20:00" },
  { key: "tomorrowMorning", label: "明早 9:00" },
  { key: "tomorrowEvening", label: "明晚 20:00" },
  { key: "weekend", label: "周六 9:00" },
  { key: "nextMonday", label: "下周一 9:00" },
];

/** 预设 → 具体时间。语义固定（"今晚"即使已过 20:00 也不隐式跳到明天）。 */
export function presetDue(preset: DuePreset, now: number): number {
  const d = new Date(now);
  const at = (addDays: number, hour: number) =>
    new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() + addDays,
      hour,
      0,
      0,
      0
    ).getTime();
  switch (preset) {
    case "tonight":
      return at(0, 20);
    case "tomorrowMorning":
      return at(1, 9);
    case "tomorrowEvening":
      return at(1, 20);
    case "weekend": {
      // 最近的周六（今天是周六 → 今天；周日 → 下周六）
      const dow = d.getDay();
      return at(dow === 6 ? 0 : (6 - dow + 7) % 7, 9);
    }
    case "nextMonday": {
      // 「下」字明确排除当天：周一时跳到 7 天后
      const dow = d.getDay();
      return at(dow === 1 ? 7 : (1 - dow + 7) % 7 || 7, 9);
    }
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
  low: "bg-sky-500",
  mid: "bg-amber-500",
  high: "bg-red-500",
};
