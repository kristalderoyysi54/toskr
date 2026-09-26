import { describe, expect, it } from "vitest";

import {
  AUTO_BACKUP_INTERVAL_MS,
  AUTO_BACKUP_RETRY_MS,
  autoBackupDue,
  autoBackupFileName,
} from "./autoBackup";

describe("自动备份调度", () => {
  const now = 1_790_000_000_000;

  it("从未备份或已满 24 小时才到期，关闭时永不到期", () => {
    expect(autoBackupDue({ autoBackupEnabled: true, autoBackupLastAtMs: null }, now, null)).toBe(true);
    expect(autoBackupDue({ autoBackupEnabled: true, autoBackupLastAtMs: now - AUTO_BACKUP_INTERVAL_MS }, now, null)).toBe(true);
    expect(autoBackupDue({ autoBackupEnabled: true, autoBackupLastAtMs: now - 1_000 }, now, null)).toBe(false);
    expect(autoBackupDue({ autoBackupEnabled: false, autoBackupLastAtMs: null }, now, null)).toBe(false);
  });

  it("失败后 6 小时内不重试，避免反复打扰", () => {
    const settings = { autoBackupEnabled: true, autoBackupLastAtMs: null };
    expect(autoBackupDue(settings, now, now - 1_000)).toBe(false);
    expect(autoBackupDue(settings, now, now - AUTO_BACKUP_RETRY_MS)).toBe(true);
  });

  it("系统时钟回拨（上次时间在未来）视为到期，不会永远卡住", () => {
    expect(autoBackupDue({ autoBackupEnabled: true, autoBackupLastAtMs: now + 60_000 }, now, null)).toBe(true);
  });

  it("文件名与 Rust 端约定一致：本地时间定宽，可按名称排序", () => {
    expect(autoBackupFileName(new Date(2026, 8, 5, 7, 3, 9))).toBe("Toskr-自动备份-20260905-070309.toskr-backup");
  });
});
