import { load, type Store } from "@tauri-apps/plugin-store";
import type { StateStorage } from "zustand/middleware";

import { api, type DataFileSnapshot } from "@/lib/tauri";

export const PERSISTENCE_CONFLICT_EVENT = "toskr:persistence-conflict";

type PersistenceBackend = Pick<
  typeof api,
  "readDataSnapshot" | "writeDataIfCurrent"
>;

type PersistenceController = {
  storage: StateStorage;
  flushPendingWrites: () => Promise<void>;
  pausePersistence: () => Promise<void>;
  resumePersistence: () => void;
  isPersistencePaused: () => boolean;
  hasPersistenceConflict: () => boolean;
  enterExternalConflict: (error: unknown) => void;
  clearExternalConflict: () => void;
  currentBaseRevision: () => string | null;
  rehydrateFromActiveDataDir: (name?: string) => Promise<string | null>;
  commitValueWhilePaused: (name: string, value: string) => Promise<void>;
  replaceValueWhilePaused: (name: string, value: string) => Promise<void>;
  resolveConflictByReload: (name?: string) => Promise<string | null>;
};

type ControllerOptions = {
  debounceMs?: number;
  legacyGet?: (name: string) => Promise<string | null>;
  markInitialized?: () => Promise<void>;
  onConflict?: (error: unknown) => void;
};

/**
 * 持久化事务控制器。公开 factory 是测试 seam：测试注入纯内存 backend，
 * 生产实例只绑定 revision-aware Tauri commands。
 */
export function createPersistenceController(
  backend: PersistenceBackend,
  options: ControllerOptions = {}
): PersistenceController {
  const debounceMs = options.debounceMs ?? 400;
  let pendingValues: Record<string, string> = {};
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let baseSnapshot: DataFileSnapshot | null = null;
  let paused = false;
  let conflicted = false;
  let flushChain: Promise<void> = Promise.resolve();

  const signalConflict = (error: unknown) => {
    options.onConflict?.(error);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(PERSISTENCE_CONFLICT_EVENT, { detail: error })
      );
    }
  };

  const readBag = (snapshot: DataFileSnapshot): Record<string, string> => {
    if (!snapshot.content) return {};
    const value: unknown = JSON.parse(snapshot.content);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("toskr-data.json 顶层不是对象");
    }
    return value as Record<string, string>;
  };

  const ensureBase = async () => {
    baseSnapshot ??= await backend.readDataSnapshot();
    return baseSnapshot;
  };

  const runFlush = async () => {
    while (Object.keys(pendingValues).length) {
      const values = pendingValues;
      pendingValues = {};
      try {
        const basedOn = await ensureBase();
        const bag = readBag(basedOn);
        Object.assign(bag, values);
        baseSnapshot = await backend.writeDataIfCurrent(
          JSON.stringify(bag),
          basedOn.revision
        );
        await options.markInitialized?.();
      } catch (error) {
        // 后到的值优先；失败批次仍保留，等待用户“重新加载/另存恢复副本”决策。
        pendingValues = { ...values, ...pendingValues };
        paused = true;
        conflicted = true;
        signalConflict(error);
        throw error;
      }
    }
  };

  const flushPendingWrites = () => {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    flushChain = flushChain.catch(() => undefined).then(runFlush);
    return flushChain;
  };

  const scheduleFlush = () => {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void flushPendingWrites().catch(() => {
        // 冲突已通过稳定事件上报；禁止后台无提示覆盖或丢弃 pending。
      });
    }, debounceMs);
  };

  const storage: StateStorage = {
    getItem: async (name) => {
      if (name in pendingValues) return pendingValues[name];
      try {
        const snapshot = await backend.readDataSnapshot();
        baseSnapshot = snapshot;
        if (snapshot.content) {
          await options.markInitialized?.();
          return readBag(snapshot)[name] ?? null;
        }
      } catch (error) {
        // fail-closed：活动数据读取/解析失败时冻结持久化并走冲突恢复，
        // 不回退 legacy（陈旧快照）也不以可写空默认态继续——那样的内存
        // 从未基于磁盘状态，后续 flush 会拿新鲜 revision 把好数据覆盖掉。
        paused = true;
        conflicted = true;
        signalConflict(error);
        return null;
      }
      return options.legacyGet?.(name) ?? null;
    },
    setItem: async (name, value) => {
      if (paused) return;
      pendingValues[name] = value;
      scheduleFlush();
    },
    removeItem: async (name) => {
      if (paused) return;
      await flushPendingWrites();
      const basedOn = await ensureBase();
      const bag = readBag(basedOn);
      delete bag[name];
      try {
        baseSnapshot = await backend.writeDataIfCurrent(
          JSON.stringify(bag),
          basedOn.revision
        );
        await options.markInitialized?.();
      } catch (error) {
        paused = true;
        conflicted = true;
        signalConflict(error);
        throw error;
      }
    },
  };

  return {
    storage,
    flushPendingWrites,
    pausePersistence: async () => {
      await flushPendingWrites();
      const basedOn = await ensureBase();
      const current = await backend.readDataSnapshot();
      if (current.revision !== basedOn.revision) {
        const error = {
          code: "externalConflict",
          message: "活动数据自上次读取后已被外部修改",
        };
        paused = true;
        conflicted = true;
        signalConflict(error);
        throw error;
      }
      paused = true;
    },
    resumePersistence: () => {
      if (!conflicted) paused = false;
    },
    isPersistencePaused: () => paused,
    hasPersistenceConflict: () => conflicted,
    enterExternalConflict: (error) => {
      paused = true;
      conflicted = true;
      signalConflict(error);
    },
    clearExternalConflict: () => {
      conflicted = false;
    },
    currentBaseRevision: () => baseSnapshot?.revision ?? null,
    rehydrateFromActiveDataDir: async (name = "toskr") => {
      if (!paused) {
        throw new Error("重新水合前必须冻结持久化");
      }
      const snapshot = await backend.readDataSnapshot();
      const value = snapshot.content ? readBag(snapshot)[name] ?? null : null;
      baseSnapshot = snapshot;
      pendingValues = {};
      return value;
    },
    commitValueWhilePaused: async (name, value) => {
      if (!paused) throw new Error("原子提交持久化值前必须冻结写入");
      const basedOn = await ensureBase();
      const bag = readBag(basedOn);
      bag[name] = value;
      try {
        baseSnapshot = await backend.writeDataIfCurrent(
          JSON.stringify(bag),
          basedOn.revision
        );
        await options.markInitialized?.();
      } catch (error) {
        conflicted = true;
        signalConflict(error);
        throw error;
      }
    },
    replaceValueWhilePaused: async (name, value) => {
      if (!paused) throw new Error("冲突恢复写入前必须冻结持久化");
      const basedOn = await ensureBase();
      try {
        baseSnapshot = await backend.writeDataIfCurrent(
          JSON.stringify({ [name]: value }),
          basedOn.revision
        );
        pendingValues = {};
        await options.markInitialized?.();
      } catch (error) {
        conflicted = true;
        signalConflict(error);
        throw error;
      }
    },
    resolveConflictByReload: async (name = "toskr") => {
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      pendingValues = {};
      paused = true;
      const snapshot = await backend.readDataSnapshot();
      let value: string | null = null;
      if (snapshot.content) {
        try {
          value = readBag(snapshot)[name] ?? null;
        } catch {
          // 用户明确选择“重新加载”后，损坏/缺失版本可进入受控空 store
          // 重建；实际 CAS 写入由 replaceValueWhilePaused 完成。
        }
      }
      baseSnapshot = snapshot;
      conflicted = false;
      return value;
    },
  };
}

let legacyStore: Promise<Store> | null = null;
/** legacy 明文抹除每会话只查一次，避免每次防抖落盘都多一轮 store IO。 */
let legacyScrubbed = false;

function getLegacyStore(): Promise<Store> {
  legacyStore ??= load("toskr-store.json", { autoSave: false });
  return legacyStore;
}

const controller = createPersistenceController(api, {
  legacyGet: async (name) => {
    try {
      const store = await getLegacyStore();
      if (await store.get<boolean>("toskr-data-initialized")) return null;
      return (await store.get<string>(name)) ?? null;
    } catch {
      return null;
    }
  },
  markInitialized: async () => {
    const store = await getLegacyStore();
    let dirty = false;
    if (!(await store.get<boolean>("toskr-data-initialized"))) {
      await store.set("toskr-data-initialized", true);
      dirty = true;
    }
    // 旧版曾把整份状态明文留在 toskr-store.json（含项目改名前的 "copper"
    // 包，代码已零引用）；主存储加密落地后一次性抹掉旧明文包，只保留初始化
    // 标记。本回调只在成功写盘后触发，失败路径仍保有 legacy 兜底。
    if (!legacyScrubbed) {
      legacyScrubbed = true;
      for (const legacyKey of ["toskr", "copper"]) {
        if ((await store.get<string>(legacyKey)) != null) {
          await store.delete(legacyKey);
          dirty = true;
        }
      }
    }
    if (dirty) await store.save();
  },
});

export const tauriStateStorage = controller.storage;
export const flushPendingWrites = controller.flushPendingWrites;
export const pausePersistence = controller.pausePersistence;
export const resumePersistence = controller.resumePersistence;
export const isPersistencePaused = controller.isPersistencePaused;
export const hasPersistenceConflict = controller.hasPersistenceConflict;
export const enterPersistenceConflict = controller.enterExternalConflict;
export const clearPersistenceConflict = controller.clearExternalConflict;
export const currentPersistenceRevision = controller.currentBaseRevision;
export const rehydrateFromActiveDataDir = controller.rehydrateFromActiveDataDir;
export const commitPersistedValueWhilePaused = controller.commitValueWhilePaused;
export const replacePersistedValueWhilePaused = controller.replaceValueWhilePaused;
export const resolvePersistenceConflictByReload = controller.resolveConflictByReload;
