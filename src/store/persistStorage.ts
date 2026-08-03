import { load, type Store } from "@tauri-apps/plugin-store";
import type { StateStorage } from "zustand/middleware";

import { api } from "@/lib/tauri";

/**
 * 持久化后端：数据写入 `<数据文件夹>/toskr-data.json`（文件夹可在设置里更改）。
 * 首次读取若新文件不存在，回落到旧的 tauri-plugin-store 做一次性无损迁移。
 */
let legacyStore: Promise<Store> | null = null;

function getLegacyStore(): Promise<Store> {
  legacyStore ??= load("toskr-store.json", { autoSave: false });
  return legacyStore;
}

// 防抖合并写：zustand persist 在每次 state 变更后 setItem，剪贴板高频入库时
// 若每次都全量读写文件会成为卡顿源。合并 400ms 窗口内的写为一次落盘。
// 权衡：进程被杀的极端情况最多丢最后 400ms 的变更（个人工具可接受）。
let pendingValues: Record<string, string> = {};
let writeTimer = 0;

async function flushPending() {
  const values = pendingValues;
  pendingValues = {};
  if (!Object.keys(values).length) return;
  let bag: Record<string, string> = {};
  try {
    const raw = await api.readDataFile();
    if (raw) bag = JSON.parse(raw) as Record<string, string>;
  } catch {
    /* 首次写入 */
  }
  Object.assign(bag, values);
  await api.writeDataFile(JSON.stringify(bag));
}

export const tauriStateStorage: StateStorage = {
  getItem: async (name) => {
    // 防抖窗口内的最新值优先（避免读到落盘前的旧快照）
    if (name in pendingValues) return pendingValues[name];
    try {
      const raw = await api.readDataFile();
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, string>;
        return parsed[name] ?? null;
      }
    } catch {
      /* 读失败则尝试旧存储 */
    }
    try {
      const store = await getLegacyStore();
      return (await store.get<string>(name)) ?? null;
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    pendingValues[name] = value;
    window.clearTimeout(writeTimer);
    writeTimer = window.setTimeout(() => void flushPending(), 400);
  },
  removeItem: async (name) => {
    try {
      const raw = await api.readDataFile();
      if (!raw) return;
      const bag = JSON.parse(raw) as Record<string, string>;
      delete bag[name];
      await api.writeDataFile(JSON.stringify(bag));
    } catch {
      /* ignore */
    }
  },
};
