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

export const tauriStateStorage: StateStorage = {
  getItem: async (name) => {
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
    let bag: Record<string, string> = {};
    try {
      const raw = await api.readDataFile();
      if (raw) bag = JSON.parse(raw) as Record<string, string>;
    } catch {
      /* 首次写入 */
    }
    bag[name] = value;
    await api.writeDataFile(JSON.stringify(bag));
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
