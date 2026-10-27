import { useEffect } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";

import { t } from "@/lib/i18n";
import {
  APPLE_CALENDAR_CHANGED_EVENT,
  api,
  type AppleReminderConflict,
  type AppleReminderDesired,
} from "@/lib/tauri";
import { clockLabel, monthDayLabel } from "@/lib/taskRecurrence";
import { setPendingUndo, tip } from "@/lib/tip";
import {
  appleDueFromKey,
  appleDueKey,
  dueAtFromAppleParts,
  useNotesStore,
  type Task,
  type TaskPriority,
} from "@/store/notesStore";

const PRIORITY: Record<TaskPriority, number> = { high: 1, mid: 5, low: 9, none: 0 };
/** 到期键 → 展示文案：「10月28日 09:30」/ 只有日期 /「无到期」。 */
export function dueKeyLabel(key: string): string {
  const due = appleDueFromKey(key);
  const at = dueAtFromAppleParts(due);
  if (!due || at === null) return t("无到期");
  const d = new Date(at);
  return due.h < 0 ? monthDayLabel(d) : `${monthDayLabel(d)} ${clockLabel(d.getHours(), d.getMinutes())}`;
}

/** 冲突提示：单处写出被覆盖的对端内容，多处给数量；都提示可「撤销」改用对端版本。 */
export function conflictTipText(conflicts: AppleReminderConflict[]): string {
  if (conflicts.length > 1) {
    return t("提醒事项里有 {n} 处修改与 Toskr 冲突，已以 Toskr 为准（撤销可改用提醒事项版本）", {
      n: conflicts.length,
    });
  }
  const [c] = conflicts;
  if (c.field === "title") return t("提醒事项里改的标题已被 Toskr 覆盖：「{text}」（撤销可改用）", { text: c.theirs });
  if (c.field === "notes") return t("提醒事项里改的备注已被 Toskr 覆盖：「{text}」（撤销可改用）", { text: c.theirs });
  return t("提醒事项里改的到期已被 Toskr 覆盖：{text}（撤销可改用）", { text: dueKeyLabel(c.theirs) });
}

/** 设置窗 → 主窗口：立即跑一轮同步。 */
export const APPLE_REMINDERS_SYNC_NOW = "toskr://apple-reminders-sync-now";
/** 设置窗请求任务分组列表（设置窗不持有任务数据），主窗口回 APPLE_REMINDERS_SECTIONS。 */
export const APPLE_REMINDERS_SECTIONS_REQUEST = "toskr://apple-reminders-sections-request";
export const APPLE_REMINDERS_SECTIONS = "toskr://apple-reminders-sections";
export interface AppleRemindersSectionOption {
  id: string;
  name: string;
}
/** 自动同步的「上次同步」最多每 30s 写一次设置，免得每轮同步都落盘。 */
const LAST_SYNC_WRITE_MS = 30_000;

/**
 * 要下发的任务：闪念不同步；对端删过的不再同步；已完成的只同步「之前推过的」
 * （开启同步时不把历史完成任务灌进提醒事项）。recreate 里的是本会话里被删了
 * 对端提醒的任务——撤销删除后它们要重建，而不是被判成「对端删除」。
 */
export function desiredReminders(
  tasks: Task[],
  recreate: ReadonlySet<string>,
  alarm = false
): AppleReminderDesired[] {
  const out: AppleReminderDesired[] = [];
  for (const task of tasks) {
    if (task.kind === "spark" || task.appleSyncOff) continue;
    const synced = task.appleSyncedId === task.id && !recreate.has(task.id);
    if (task.status === "done" && !synced) continue;
    const due = task.dueAt === null ? null : new Date(task.dueAt);
    out.push({
      taskId: task.id,
      title: task.text.trim() || t("未命名任务"),
      notes: task.note?.trim() || null,
      due: due && {
        y: due.getFullYear(),
        m: due.getMonth() + 1,
        d: due.getDate(),
        h: due.getHours(),
        mi: due.getMinutes(),
      },
      priority: PRIORITY[task.priority],
      completed: task.status === "done",
      synced,
      reopened: synced && task.status !== "done" && task.appleDone === true,
      // 与 Toskr 自己的提醒档同口径：到期前 N 分钟（缺省 [0] = 到期时）
      alarms:
        alarm && task.dueAt !== null
          ? [...new Set(task.reminderOffsets ?? [0])].map((m) => (m ? -m * 60 : 0)).sort((a, b) => a - b)
          : [],
      adoptItemId: task.appleImportItemId ?? null,
      baseTitle: synced ? (task.appleTitle ?? null) : null,
      baseNotes: synced ? (task.appleNotes ?? null) : null,
      baseDue: synced ? (task.appleDue ?? null) : null,
    });
  }
  return out;
}

/**
 * 主窗口常驻：开启后在数据水合完成后对账一次（含导入列表里新建的提醒），此后任务变化（1.5s 防抖）与
 * 系统提醒库变化（0.8s 防抖）各触发一轮。同一时刻只跑一轮，期间的触发合并为
 * 跑完后再补一轮。
 */
export function useAppleRemindersSync() {
  const enabled = useNotesStore((s) => s.settings.appleRemindersEnabled);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 手动同步：本轮（或排队的下一轮）结束后提示结果、立即写「上次同步」
    let forced = false;
    const recreate = new Set<string>();

    const run = async () => {
      if (!alive || !useNotesStore.persist.hasHydrated()) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      const manual = forced;
      forced = false;
      const store = useNotesStore.getState();
      try {
        const desired = desiredReminders(
          store.tasks,
          recreate,
          store.settings.appleRemindersAlarm
        );
        const result = await api.appleRemindersSync(store.settings.appleRemindersListId, desired);
        if (!alive) return;
        for (const id of result.deletedTasks) recreate.add(id);
        for (const id of result.created) recreate.delete(id);
        // 本轮成功写下的完成态即对端现状（对端刚完成的那批要等 Toskr 标完成后下一轮再记）
        const backflow = new Set(result.completedRemote);
        const missing = new Set(result.missing);
        const renamed = new Map(result.titleRemote);
        const renoted = new Map(result.notesRemote);
        const redued = new Map(result.dueRemote);
        const next = useNotesStore.getState();
        next.markAppleReminderSync({
          created: result.created,
          missing: result.missing,
          done: desired.filter((d) => d.completed).map((d) => d.taskId),
          open: desired.filter((d) => !d.completed && !backflow.has(d.taskId)).map((d) => d.taskId),
          adopted: result.adopted,
          titles: desired
            .filter((d) => !missing.has(d.taskId))
            .map((d) => [d.taskId, renamed.get(d.taskId) ?? d.title]),
          renamed: result.titleRemote,
          notes: desired
            .filter((d) => !missing.has(d.taskId))
            .map((d) => [d.taskId, renoted.get(d.taskId) ?? d.notes ?? ""]),
          renoted: result.notesRemote,
          dues: desired
            .filter((d) => !missing.has(d.taskId))
            .map((d) => [d.taskId, appleDueKey(redued.has(d.taskId) ? (redued.get(d.taskId) ?? null) : d.due)]),
          redued: result.dueRemote,
        });
        const imported = useNotesStore.getState().importAppleReminders(result.imported);
        if (imported) {
          tip("added", t("从提醒事项导入了 {n} 个任务", { n: imported }));
        }
        const closed = result.completedRemote.filter(
          (id) => next.tasks.find((task) => task.id === id)?.status !== "done"
        );
        for (const id of closed) useNotesStore.getState().setTaskStatus(id, "done");
        if (closed.length) {
          tip("ok", t("在提醒事项中完成了 {n} 个任务", { n: closed.length }));
        }
        // 冲突气泡放在最后：HUD 与「撤销」都是单槽，后发的导入 / 完成提示会顶掉它
        if (result.conflicts.length) {
          tip("info", conflictTipText(result.conflicts), true);
          const conflicts = result.conflicts;
          setPendingUndo(() => {
            useNotesStore.getState().applyAppleReminderTheirs(conflicts);
            tip("undone", t("已改用提醒事项里的版本"));
          });
        }
        const settings = useNotesStore.getState().settings;
        const now = Date.now();
        const stale =
          manual ||
          settings.appleRemindersLastSyncAt === null ||
          now - settings.appleRemindersLastSyncAt >= LAST_SYNC_WRITE_MS;
        if (
          stale ||
          settings.appleRemindersListId !== result.listId ||
          settings.appleRemindersLastError !== null
        ) {
          useNotesStore.getState().setSettings({
            appleRemindersListId: result.listId,
            appleRemindersLastError: null,
            ...(stale ? { appleRemindersLastSyncAt: now } : {}),
          });
        }
        if (manual) tip("ok", t("提醒事项已同步"));
      } catch (error) {
        const message = String(error);
        if (alive && useNotesStore.getState().settings.appleRemindersLastError !== message) {
          useNotesStore.getState().setSettings({ appleRemindersLastError: message });
        }
        if (alive && manual) tip("warn", t("提醒事项同步失败：{error}", { error: message }));
      } finally {
        running = false;
        if (again && alive) {
          again = false;
          void run();
        }
      }
    };
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), ms);
    };

    void run();
    const unhydrate = useNotesStore.persist.onFinishHydration(() => void run());
    const unsubscribe = useNotesStore.subscribe((state, prev) => {
      if (
        state.tasks !== prev.tasks ||
        state.settings.appleRemindersAlarm !== prev.settings.appleRemindersAlarm
      ) {
        schedule(1500);
      }
    });
    const unlisten = listen(APPLE_CALENDAR_CHANGED_EVENT, () => schedule(800));
    const unSyncNow = listen(APPLE_REMINDERS_SYNC_NOW, () => {
      forced = true;
      clearTimeout(timer);
      void run();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      unhydrate();
      unsubscribe();
      void unlisten.then((stop) => stop());
      void unSyncNow.then((stop) => stop());
    };
  }, [enabled]);

  // 设置窗选「导入到哪个分组」要分组列表；与是否开启同步无关，常驻应答
  useEffect(() => {
    const unlisten = listen(APPLE_REMINDERS_SECTIONS_REQUEST, () => {
      const sections: AppleRemindersSectionOption[] = useNotesStore
        .getState()
        .taskSections.map((s) => ({ id: s.id, name: s.name }));
      void emitTo("settings", APPLE_REMINDERS_SECTIONS, sections).catch(() => {});
    });
    return () => void unlisten.then((stop) => stop());
  }, []);
}
