import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { tip } from "@/lib/tip";
import { useNotesStore } from "@/store/notesStore";

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

/**
 * 下载并安装更新。`restart` 为 true 时完成后立即重启应用；
 * 否则静默替换（下次启动即新版本）。返回是否安装成功。
 */
export async function downloadAndInstall(
  update: Update,
  onProgress?: (pct: number) => void,
  restart = true
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
    if (restart) await relaunch();
    return true;
  } catch (e) {
    tip("warn", `更新失败：${e}`);
    return false;
  }
}

/**
 * 启动自动更新流程（受设置门控）：
 * - 自动检查关闭 → 什么都不做；
 * - 发现新版：自动安装开启 → 后台下载替换，气泡提示重启生效（不打断使用）；
 *   否则仅气泡提醒去设置页更新。
 */
export async function silentUpdateFlow() {
  const { autoCheckUpdate, autoInstallUpdate } =
    useNotesStore.getState().settings;
  if (!autoCheckUpdate) return;
  const update = await checkForUpdate();
  if (!update) return;
  if (autoInstallUpdate) {
    const ok = await downloadAndInstall(update, undefined, false);
    if (ok) tip("ok", `已更新到 v${update.version} · 重启应用后生效`);
  } else {
    tip("info", `发现新版本 v${update.version} · 可在设置中更新`);
  }
}
