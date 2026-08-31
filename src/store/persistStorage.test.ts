import { describe, expect, it, vi } from "vitest";
import { createJSONStorage, persist } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

import type { DataFileSnapshot } from "@/lib/tauri";
import { createPersistenceController } from "./persistStorage";

function snapshot(content: string | null, revision: string): DataFileSnapshot {
  return { content, revision, size: content?.length ?? 0, modifiedAtMs: 1 };
}

describe("persistence transaction controller", () => {
  it("does not let pre-hydration legacy draft migration overwrite existing disk state", async () => {
    const persisted = JSON.stringify({ state: { notes: ["existing"] }, version: 0 });
    let disk = snapshot(JSON.stringify({ toskr: persisted }), "rev-existing");
    const backend = {
      readDataSnapshot: vi.fn(async () => disk),
      writeDataIfCurrent: vi.fn(async (content: string) => {
        disk = snapshot(content, "rev-overwritten");
        return disk;
      }),
    };
    const controller = createPersistenceController(backend, {
      debounceMs: 60_000,
    });
    type StartupStore = { notes: string[]; draftText: string };
    const store = createStore<StartupStore>()(
      persist<StartupStore>(
        () => ({ notes: [], draftText: "" }),
        {
          name: "toskr",
          storage: createJSONStorage(() => controller.storage),
          skipHydration: true,
        }
      )
    );
    expect(controller.hasLoadedAuthority()).toBe(false);

    // DraftInput 挂载时收编旧 localStorage 草稿；其余持久域仍是未水合默认态。
    store.setState({ draftText: "legacy localStorage draft" });

    // 随后的 rehydrate 必须从磁盘恢复已有记录，不能采纳 pending 空内存镜像。
    await store.persist.rehydrate();
    expect(controller.hasLoadedAuthority()).toBe(true);
    expect.soft(store.getState().notes).toEqual(["existing"]);
    await controller.flushPendingWrites();
    expect
      .soft(JSON.parse(JSON.parse(disk.content!).toskr).state.notes)
      .toEqual(["existing"]);
  });

  it("preserves every existing-user data domain across hydration and changes only the migrated draft", async () => {
    type ExistingData = {
      notes: { id: string; text: string }[];
      tasks: { id: string; title: string }[];
      bills: { id: string; amount: number }[];
      messages: { id: string; status: string }[];
      settings: { theme: string; clipRetentionDays: number | null };
      draftText: string;
    };
    const existing: ExistingData = {
      notes: [
        { id: "note-old", text: "existing note" },
        { id: "note-new", text: "newer existing note" },
      ],
      tasks: [{ id: "task-1", title: "existing task" }],
      bills: [{ id: "bill-1", amount: 88 }],
      messages: [{ id: "message-1", status: "done" }],
      settings: { theme: "dark", clipRetentionDays: 7 },
      draftText: "",
    };
    const persisted = JSON.stringify({ state: existing, version: 23 });
    let disk = snapshot(JSON.stringify({ toskr: persisted }), "rev-existing");
    const backend = {
      readDataSnapshot: vi.fn(async () => disk),
      writeDataIfCurrent: vi.fn(async (content: string) => {
        disk = snapshot(content, "rev-safe-draft-migration");
        return disk;
      }),
    };
    const controller = createPersistenceController(backend, {
      debounceMs: 60_000,
    });
    const store = createStore<ExistingData>()(
      persist<ExistingData>(
        () => ({
          notes: [],
          tasks: [],
          bills: [],
          messages: [],
          settings: { theme: "system", clipRetentionDays: 30 },
          draftText: "",
        }),
        {
          name: "toskr",
          version: 23,
          storage: createJSONStorage(() => controller.storage),
          skipHydration: true,
        }
      )
    );

    // 模拟旧版 localStorage 草稿在权威磁盘读取前尝试写入完整默认 store。
    store.setState({ draftText: "legacy draft" });
    await store.persist.rehydrate();

    expect(store.getState()).toMatchObject(existing);
    expect(backend.writeDataIfCurrent).not.toHaveBeenCalled();
    expect(JSON.parse(disk.content!).toskr).toBe(persisted);

    // 水合完成后再迁入草稿；此时只允许 draftText 改变，其余用户域逐项不变。
    store.setState({ draftText: "legacy draft" });
    await controller.flushPendingWrites();
    const written = JSON.parse(JSON.parse(disk.content!).toskr).state as ExistingData;
    const { draftText: _beforeDraft, ...beforeDomains } = existing;
    const { draftText: afterDraft, ...afterDomains } = written;
    expect(afterDomains).toEqual(beforeDomains);
    expect(afterDraft).toBe("legacy draft");
  });

  it("keeps valid native state readable and writable when legacy housekeeping fails", async () => {
    const housekeepingError = new Error("legacy store is unavailable");
    let disk = snapshot(JSON.stringify({ toskr: "native" }), "rev-a");
    const onConflict = vi.fn();
    const backend = {
      readDataSnapshot: vi.fn(async () => disk),
      writeDataIfCurrent: vi.fn(async (content: string) => {
        disk = snapshot(content, "rev-b");
        return disk;
      }),
    };
    const controller = createPersistenceController(backend, {
      debounceMs: 60_000,
      markInitialized: vi.fn(async () => Promise.reject(housekeepingError)),
      onConflict,
    });

    expect.soft(await controller.storage.getItem("toskr")).toBe("native");
    expect.soft(controller.isPersistencePaused()).toBe(false);
    expect.soft(controller.hasPersistenceConflict()).toBe(false);

    await controller.storage.setItem("toskr", "next");
    await expect(controller.flushPendingWrites()).resolves.toBeUndefined();
    expect.soft(JSON.parse(disk.content!).toskr).toBe("next");
    expect.soft(controller.hasPersistenceConflict()).toBe(false);
    expect.soft(onConflict).not.toHaveBeenCalled();
  });

  it("flushes the debounce queue against the revision memory was based on", async () => {
    let disk = snapshot(JSON.stringify({ toskr: "old" }), "rev-a");
    const backend = {
      readDataSnapshot: vi.fn(async () => disk),
      writeDataIfCurrent: vi.fn(async (content: string, expected: string) => {
        expect(expected).toBe("rev-a");
        disk = snapshot(content, "rev-b");
        return disk;
      }),
    };
    const controller = createPersistenceController(backend, { debounceMs: 60_000 });
    expect(await controller.storage.getItem("toskr")).toBe("old");
    await controller.storage.setItem("toskr", "new");

    await controller.flushPendingWrites();

    expect(backend.writeDataIfCurrent).toHaveBeenCalledTimes(1);
    expect(JSON.parse(disk.content!).toskr).toBe("new");
  });

  it("getItem 读取失败时冻结持久化并上报冲突，不回退 legacy 也不覆盖磁盘", async () => {
    const error = { code: "ioError", message: "读取活动数据失败" };
    const onConflict = vi.fn();
    const legacyGet = vi.fn(async () => "legacy-stale");
    let disk: DataFileSnapshot | null = null;
    const backend = {
      readDataSnapshot: vi.fn(async () => {
        if (!disk) throw error;
        return disk;
      }),
      writeDataIfCurrent: vi.fn(),
    };
    const controller = createPersistenceController(backend, {
      debounceMs: 60_000,
      onConflict,
      legacyGet,
    });

    expect(await controller.storage.getItem("toskr")).toBeNull();

    expect(legacyGet).not.toHaveBeenCalled();
    expect(controller.isPersistencePaused()).toBe(true);
    expect(controller.hasPersistenceConflict()).toBe(true);
    expect(onConflict).toHaveBeenCalledWith(error);
    // 冻结期间的用户写入（此时内存是空默认态）绝不能落盘覆盖好数据
    await controller.storage.setItem("toskr", "default-empty-state");
    await controller.flushPendingWrites();
    expect(backend.writeDataIfCurrent).not.toHaveBeenCalled();

    // 瞬时故障消失后，用户点「重新加载」可完整恢复磁盘数据
    disk = snapshot(JSON.stringify({ toskr: "disk-intact" }), "rev-a");
    expect(await controller.resolveConflictByReload()).toBe("disk-intact");
  });

  it("marks initialized data durably after reading or creating the native store", async () => {
    let disk = snapshot(JSON.stringify({ toskr: "native" }), "rev-a");
    const markInitialized = vi.fn(async () => {});
    const backend = {
      readDataSnapshot: vi.fn(async () => disk),
      writeDataIfCurrent: vi.fn(async (content: string) => {
        disk = snapshot(content, "rev-b");
        return disk;
      }),
    };
    const controller = createPersistenceController(backend, { markInitialized });

    expect(await controller.storage.getItem("toskr")).toBe("native");
    expect(markInitialized).toHaveBeenCalledTimes(1);
    await controller.storage.setItem("toskr", "next");
    await controller.flushPendingWrites();
    expect(markInitialized).toHaveBeenCalledTimes(2);
  });

  it("hydrates a copper-only legacy bag and canonicalizes it on the next safe write", async () => {
    let disk = snapshot(JSON.stringify({ copper: "legacy-native" }), "rev-a");
    const backend = {
      readDataSnapshot: vi.fn(async () => disk),
      writeDataIfCurrent: vi.fn(async (content: string) => {
        disk = snapshot(content, "rev-b");
        return disk;
      }),
    };
    const controller = createPersistenceController(backend, {
      debounceMs: 60_000,
    });

    expect(await controller.storage.getItem("toskr")).toBe("legacy-native");
    await controller.storage.setItem("toskr", "canonical");
    await controller.flushPendingWrites();

    expect(JSON.parse(disk.content!)).toEqual({ toskr: "canonical" });
  });

  it("does not let a stale copper alias mask an invalid canonical toskr value", async () => {
    const onConflict = vi.fn();
    const backend = {
      readDataSnapshot: vi.fn(async () =>
        snapshot(JSON.stringify({ toskr: null, copper: "stale" }), "rev-a")
      ),
      writeDataIfCurrent: vi.fn(),
    };
    const controller = createPersistenceController(backend, { onConflict });

    await expect(controller.storage.getItem("toskr")).resolves.toBeNull();
    expect(controller.hasPersistenceConflict()).toBe(true);
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(backend.writeDataIfCurrent).not.toHaveBeenCalled();
  });

  it("a flush conflict prevents pause and retains the failed value", async () => {
    const conflict = { code: "externalConflict" };
    const onConflict = vi.fn();
    const backend = {
      readDataSnapshot: vi.fn(async () => snapshot("{}", "rev-a")),
      writeDataIfCurrent: vi.fn(async () => Promise.reject(conflict)),
    };
    const controller = createPersistenceController(backend, {
      debounceMs: 60_000,
      onConflict,
    });
    await controller.storage.getItem("toskr");
    await controller.storage.setItem("toskr", "pending");

    await expect(controller.pausePersistence()).rejects.toBe(conflict);

    expect(controller.isPersistencePaused()).toBe(true);
    expect(controller.hasPersistenceConflict()).toBe(true);
    expect(onConflict).toHaveBeenCalledWith(conflict);
    await expect(controller.flushPendingWrites()).rejects.toBe(conflict);
    expect(backend.writeDataIfCurrent).toHaveBeenCalledTimes(2);
  });

  it("paused writes are blocked and rehydrate reads the new active directory", async () => {
    let disk = snapshot(JSON.stringify({ toskr: "old-dir" }), "old-rev");
    const backend = {
      readDataSnapshot: vi.fn(async () => disk),
      writeDataIfCurrent: vi.fn(async (content: string) => {
        disk = snapshot(content, "written");
        return disk;
      }),
    };
    const controller = createPersistenceController(backend, { debounceMs: 60_000 });
    await controller.storage.getItem("toskr");
    await controller.pausePersistence();
    await controller.storage.setItem("toskr", "must-not-cross-directories");
    disk = snapshot(JSON.stringify({ toskr: "new-dir" }), "new-rev");

    expect(await controller.rehydrateFromActiveDataDir()).toBe("new-dir");
    controller.resumePersistence();

    expect(backend.writeDataIfCurrent).not.toHaveBeenCalled();
    expect(controller.isPersistencePaused()).toBe(false);
  });

  it("idle external revision drift blocks pause before any data operation begins", async () => {
    let disk = snapshot(JSON.stringify({ toskr: "memory-a" }), "rev-a");
    const onConflict = vi.fn();
    const backend = {
      readDataSnapshot: vi.fn(async () => disk),
      writeDataIfCurrent: vi.fn(),
    };
    const controller = createPersistenceController(backend, { onConflict });
    await controller.storage.getItem("toskr");
    disk = snapshot(JSON.stringify({ toskr: "external-b" }), "rev-b");

    await expect(controller.pausePersistence()).rejects.toMatchObject({
      code: "externalConflict",
    });

    expect(controller.isPersistencePaused()).toBe(true);
    expect(controller.hasPersistenceConflict()).toBe(true);
    expect(backend.writeDataIfCurrent).not.toHaveBeenCalled();
    expect(onConflict).toHaveBeenCalledTimes(1);
  });

  it("can enter a conflict reported by a native read-only transaction", () => {
    const error = { code: "sourceChanged" };
    const onConflict = vi.fn();
    const controller = createPersistenceController(
      {
        readDataSnapshot: vi.fn(),
        writeDataIfCurrent: vi.fn(),
      },
      { onConflict }
    );

    controller.enterExternalConflict(error);

    expect(controller.isPersistencePaused()).toBe(true);
    expect(controller.hasPersistenceConflict()).toBe(true);
    expect(onConflict).toHaveBeenCalledWith(error);
  });

  it("can atomically commit a prepared value while ordinary persistence stays paused", async () => {
    let disk = snapshot(JSON.stringify({ toskr: "old" }), "rev-a");
    const backend = {
      readDataSnapshot: vi.fn(async () => disk),
      writeDataIfCurrent: vi.fn(async (content: string, expected: string) => {
        expect(expected).toBe("rev-a");
        disk = snapshot(content, "rev-b");
        return disk;
      }),
    };
    const controller = createPersistenceController(backend, { debounceMs: 60_000 });
    await controller.storage.getItem("toskr");
    await controller.pausePersistence();

    await controller.commitValueWhilePaused("toskr", "merged");

    expect(JSON.parse(disk.content!).toskr).toBe("merged");
    expect(controller.isPersistencePaused()).toBe(true);
  });

  it("reload conflict resolution discards stale pending data and adopts disk revision", async () => {
    let disk = snapshot(JSON.stringify({ toskr: "disk-a" }), "rev-a");
    const backend = {
      readDataSnapshot: vi.fn(async () => disk),
      writeDataIfCurrent: vi.fn(async () => Promise.reject({ code: "externalConflict" })),
    };
    const controller = createPersistenceController(backend, { debounceMs: 60_000 });
    await controller.storage.getItem("toskr");
    await controller.storage.setItem("toskr", "stale-memory");
    await expect(controller.flushPendingWrites()).rejects.toEqual({
      code: "externalConflict",
    });
    disk = snapshot(JSON.stringify({ toskr: "external-disk" }), "rev-external");

    expect(await controller.resolveConflictByReload()).toBe("external-disk");
    controller.resumePersistence();

    expect(controller.isPersistencePaused()).toBe(false);
  });

  it("explicit reload can rebuild a missing disk version with an empty validated store", async () => {
    let disk = snapshot(null, "missing-a");
    const backend = {
      readDataSnapshot: vi.fn(async () => disk),
      writeDataIfCurrent: vi.fn(async (content: string, expected: string) => {
        expect(expected).toBe("missing-a");
        disk = snapshot(content, "created-b");
        return disk;
      }),
    };
    const controller = createPersistenceController(backend);
    controller.enterExternalConflict({ code: "externalConflict" });

    expect(await controller.resolveConflictByReload()).toBeNull();
    await controller.replaceValueWhilePaused(
      "toskr",
      JSON.stringify({ state: {}, version: 8 })
    );

    expect(JSON.parse(disk.content!).toskr).toContain('"version":8');
    expect(controller.isPersistencePaused()).toBe(true);
  });
});
