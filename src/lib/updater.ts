import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { tip } from "@/lib/tip";

/**
 * 应用更新：GitHub Releases 的 latest.json 为源，minisign 签名校验。
 * check() 失败（离线、无 Release）静默返回 null，不打扰用户。
 */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    return await check();
  } catch {
    return null;
  }
}

/** 下载并安装更新，完成后重启应用。返回是否成功走到重启。 */
export async function downloadAndInstall(
  update: Update,
  onProgress?: (pct: number) => void
): Promise<boolean> {
  try {
    let total = 0;
    let done = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        done += event.data.chunkLength;
        if (total > 0) onProgress?.(Math.round((done / total) * 100));
      } else if (event.event === "Finished") {
        onProgress?.(100);
      }
    });
    await relaunch();
    return true;
  } catch (e) {
    tip("warn", `更新失败：${e}`);
    return false;
  }
}

/** 启动静默检查：发现新版本时右上角气泡提醒（不自动下载）。 */
export async function silentUpdateNotify() {
  const update = await checkForUpdate();
  if (update) {
    tip("info", `发现新版本 v${update.version} · 可在设置中更新`);
  }
}
