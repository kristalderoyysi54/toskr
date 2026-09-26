import { runAutoBackup } from "@/lib/dataOperations";
import { applySettingsPatch } from "@/lib/settingsSync";
import { tip } from "@/lib/tip";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import { useNotesStore, type Settings } from "@/store/notesStore";
import { isPersistencePaused } from "@/store/persistStorage";

/**
 * 定期自动备份（2026-09-25 丢数据事故后新增：本机此前除应用自身外没有任何数据副本）。
 * 每 24 小时一份加密完整备份（含媒体），保留最近 N 份；失败 6 小时后再试，避免反复打扰。
 */
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUTO_BACKUP_RETRY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

type AutoBackupSettings = Pick<Settings, "autoBackupEnabled" | "autoBackupLastAtMs">;

export function autoBackupDue(
  settings: AutoBackupSettings,
  now: number,
  lastFailureAt: number | null
): boolean {
  if (!settings.autoBackupEnabled) return false;
  if (lastFailureAt !== null && now - lastFailureAt < AUTO_BACKUP_RETRY_MS) return false;
  const last = settings.autoBackupLastAtMs;
  return last === null || now - last >= AUTO_BACKUP_INTERVAL_MS || last > now;
}

/** 与 Rust 端 is_auto_backup_name 约定一致：Toskr-自动备份-YYYYMMDD-HHMMSS.toskr-backup（本地时间）。 */
export function autoBackupFileName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `Toskr-自动备份-${day}-${time}.toskr-backup`;
}

let lastFailureAt: number | null = null;
let running = false;

/** manual=true：设置页「立即备份」，无视到期判断并总是给出结果提示。 */
export async function performAutoBackup(manual = false): Promise<void> {
  if (running) return;
  const settings = useNotesStore.getState().settings;
  if (!manual && !autoBackupDue(settings, Date.now(), lastFailureAt)) return;
  running = true;
  try {
    const result = await runAutoBackup(
      settings.autoBackupDir,
      autoBackupFileName(new Date()),
      settings.autoBackupKeep
    );
    lastFailureAt = null;
    applySettingsPatch({ autoBackupLastAtMs: Date.now() });
    if (manual) {
      tip(
        "ok",
        `已备份 ${result.notes} 条笔记、${result.media} 个媒体${result.pruned ? `，清理旧备份 ${result.pruned} 份` : ""}`
      );
    }
  } catch (error) {
    lastFailureAt = Date.now();
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
    tip("warn", `自动备份失败：${message}`);
  } finally {
    running = false;
  }
}

/** 主面板安装：启动 2 分钟后首检，之后每 30 分钟检查是否到期。返回清理函数。 */
export function installAutoBackupScheduler(): () => void {
  const check = () => {
    if (
      !useNotesStore.persist.hasHydrated() ||
      isDataOperationLocked() ||
      isPersistencePaused()
    ) {
      return;
    }
    void performAutoBackup(false);
  };
  const first = window.setTimeout(check, FIRST_CHECK_DELAY_MS);
  const interval = window.setInterval(check, CHECK_INTERVAL_MS);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(interval);
  };
}
