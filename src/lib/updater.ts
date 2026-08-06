import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { tip } from "@/lib/tip";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

/** 最近一次发现的更新对象（Update 实例不可入 store，模块级缓存）。 */
let pendingUpdate: Update | null = null;

/** 面板更新对话框「立即下载」：安装最近发现的更新，完成后自动重启。 */
export async function installPendingUpdate(
  onProgress?: (pct: number) => void
): Promise<boolean> {
  if (!pendingUpdate) return false;
  return downloadAndInstall(pendingUpdate, onProgress, true);
}

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
    const msg = String(e);
    // App Translocation：浏览器下载的包未经 Finder 移动就运行时，系统把它
    // 挂到只读路径，更新器无法替换自身 bundle（os error 30）。给可行动的指引。
    if (msg.includes("Read-only file system") || msg.includes("os error 30")) {
      tip(
        "warn",
        "更新失败：应用被系统隔离为只读——请退出后把 Toskr 拖入「应用程序」文件夹再重新打开，即可正常更新"
      );
    } else {
      tip("warn", `更新失败：${msg}`);
    }
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
    // 头部「更新」按钮亮起 + 气泡点击唤起面板内更新对话框
    pendingUpdate = update;
    useUIStore.getState().setUpdateAvail({
      version: update.version,
      current: update.currentVersion,
      notes: update.body ?? "",
    });
    tip("info", `发现新版本 v${update.version} · 点击查看`, false, "update");
  }
}
