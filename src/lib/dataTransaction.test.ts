import { describe, expect, it, vi } from "vitest";

import {
  DataRollbackFailure,
  resumePendingDataTransaction,
  runDataTransaction,
} from "./dataTransaction";

function dependencies() {
  return {
    captureMemory: vi.fn(() => ({ note: "old" })),
    restoreMemory: vi.fn(),
    pausePersistence: vi.fn(async () => {}),
    resumePersistence: vi.fn(),
    hasPersistenceConflict: vi.fn(() => false),
    begin: vi.fn(async () => ({ operationId: "op-1" })),
    operationIdOf: vi.fn((prepared: { operationId: string }) => prepared.operationId),
    rehydrate: vi.fn(async () => "new persisted state" as string | null),
    replaceMemory: vi.fn(async () => {}),
    completeHydration: vi.fn(async () => {}),
    restoreRollbackMemory: vi.fn(async () => {}),
    finalize: vi.fn(async () => ({ status: "completed" })),
    rollback: vi.fn(async () => ({})),
    setLocked: vi.fn(),
  };
}

describe("runDataTransaction", () => {
  it("flushes, freezes, rehydrates, finalizes, then resumes", async () => {
    const deps = dependencies();
    await expect(runDataTransaction(deps)).resolves.toEqual({ status: "completed" });
    expect(deps.replaceMemory).toHaveBeenCalledWith("new persisted state");
    expect(deps.completeHydration).toHaveBeenCalledTimes(1);
    expect(deps.finalize).toHaveBeenCalledWith("op-1");
    expect(deps.rollback).not.toHaveBeenCalled();
    expect(deps.setLocked.mock.calls).toEqual([[true], [false]]);
    expect(deps.resumePersistence).toHaveBeenCalledTimes(1);
  });

  it("awaits migrated memory commit before native finalize", async () => {
    const deps = dependencies();
    let finishReplace!: () => void;
    deps.replaceMemory.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishReplace = resolve))
    );

    const transaction = runDataTransaction(deps);
    await vi.waitFor(() => expect(deps.replaceMemory).toHaveBeenCalled());
    expect(deps.finalize).not.toHaveBeenCalled();
    finishReplace();
    await transaction;
    expect(deps.finalize).toHaveBeenCalledWith("op-1");
  });

  it("keeps the transaction locked until hydration bookkeeping completes", async () => {
    const deps = dependencies();
    let finishHydration!: () => void;
    deps.completeHydration.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishHydration = resolve))
    );

    const transaction = runDataTransaction(deps);
    await vi.waitFor(() => expect(deps.completeHydration).toHaveBeenCalled());

    expect(deps.finalize).not.toHaveBeenCalled();
    expect(deps.resumePersistence).not.toHaveBeenCalled();
    expect(deps.setLocked.mock.calls).toEqual([[true]]);

    finishHydration();
    await transaction;
    expect(deps.finalize).toHaveBeenCalledWith("op-1");
    expect(deps.setLocked.mock.calls.at(-1)).toEqual([false]);
  });

  it("rehydrate failure adopts the restored disk version before resuming", async () => {
    const deps = dependencies();
    deps.rehydrate
      .mockRejectedValueOnce(new Error("migrate failed"))
      .mockResolvedValueOnce("externally updated source");

    await expect(runDataTransaction(deps)).rejects.toThrow("migrate failed");

    expect(deps.rollback).toHaveBeenCalledWith("op-1");
    expect(deps.restoreRollbackMemory).toHaveBeenCalledWith(
      { note: "old" },
      "externally updated source"
    );
    expect(deps.restoreMemory).not.toHaveBeenCalled();
    expect(deps.resumePersistence).toHaveBeenCalledTimes(1);
    expect(deps.setLocked.mock.calls.at(-1)).toEqual([false]);
  });

  it("flush failure prevents pointer commit", async () => {
    const deps = dependencies();
    deps.pausePersistence.mockRejectedValueOnce(new Error("flush failed"));

    await expect(runDataTransaction(deps)).rejects.toThrow("flush failed");

    expect(deps.begin).not.toHaveBeenCalled();
    expect(deps.rollback).not.toHaveBeenCalled();
    expect(deps.restoreMemory).toHaveBeenCalled();
  });

  it("keeps persistence and UI locked when flush fails with an OCC conflict", async () => {
    const deps = dependencies();
    deps.pausePersistence.mockRejectedValueOnce(new Error("flush conflict"));
    deps.hasPersistenceConflict.mockReturnValue(true);

    await expect(runDataTransaction(deps)).rejects.toThrow("flush conflict");

    expect(deps.begin).not.toHaveBeenCalled();
    expect(deps.resumePersistence).not.toHaveBeenCalled();
    expect(deps.setLocked.mock.calls).toEqual([[true]]);
  });

  it("rollback failure restores memory but keeps persistence locked", async () => {
    const deps = dependencies();
    deps.rehydrate.mockRejectedValueOnce(new Error("bad target"));
    deps.rollback.mockRejectedValueOnce(new Error("disk rollback failed"));

    await expect(runDataTransaction(deps)).rejects.toBeInstanceOf(DataRollbackFailure);

    expect(deps.restoreMemory).toHaveBeenCalledWith({ note: "old" });
    expect(deps.resumePersistence).not.toHaveBeenCalled();
    expect(deps.setLocked.mock.calls).toEqual([[true]]);
  });

  it("does not overwrite an external source revision with the pre-transaction snapshot", async () => {
    const deps = dependencies();
    deps.finalize.mockRejectedValueOnce(new Error("target drift"));
    deps.rehydrate
      .mockResolvedValueOnce("authorized target A")
      .mockResolvedValueOnce("external source B");

    await expect(runDataTransaction(deps)).rejects.toThrow("target drift");

    expect(deps.rollback).toHaveBeenCalledWith("op-1");
    expect(deps.replaceMemory).toHaveBeenCalledWith("authorized target A");
    expect(deps.restoreRollbackMemory).toHaveBeenCalledWith(
      { note: "old" },
      "external source B"
    );
    expect(deps.restoreMemory).not.toHaveBeenCalled();
    expect(deps.resumePersistence).toHaveBeenCalledTimes(1);
  });
});

describe("resumePendingDataTransaction", () => {
  it("rehydrates and finalizes a native transaction that survived WebView reload", async () => {
    const deps = dependencies();

    await resumePendingDataTransaction("op-survived", deps);

    expect(deps.begin).not.toHaveBeenCalled();
    expect(deps.replaceMemory).toHaveBeenCalledWith("new persisted state");
    expect(deps.finalize).toHaveBeenCalledWith("op-survived");
    expect(deps.setLocked.mock.calls).toEqual([[true], [false]]);
  });

  it("rolls back and adopts the old active directory when continuation fails", async () => {
    const deps = dependencies();
    deps.rehydrate
      .mockResolvedValueOnce("invalid target")
      .mockResolvedValueOnce("restored source");
    deps.replaceMemory.mockRejectedValueOnce(new Error("decode failed"));

    await expect(
      resumePendingDataTransaction("op-survived", deps)
    ).rejects.toThrow("decode failed");

    expect(deps.rollback).toHaveBeenCalledWith("op-survived");
    expect(deps.replaceMemory).toHaveBeenLastCalledWith("restored source");
    expect(deps.completeHydration).toHaveBeenCalledTimes(1);
    expect(deps.resumePersistence).toHaveBeenCalledTimes(1);
    expect(deps.setLocked.mock.calls.at(-1)).toEqual([false]);
  });
});
