export class DataRollbackFailure extends Error {
  readonly operationError: unknown;
  readonly rollbackError: unknown;

  constructor(
    operationError: unknown,
    rollbackError: unknown
  ) {
    super("数据事务失败且自动回滚未完成；持久化保持冻结");
    this.name = "DataRollbackFailure";
    this.operationError = operationError;
    this.rollbackError = rollbackError;
  }
}

export type DataTransactionDependencies<Snapshot, Prepared, Result> = {
  captureMemory: () => Snapshot;
  restoreMemory: (snapshot: Snapshot) => void;
  pausePersistence: () => Promise<void>;
  resumePersistence: () => void;
  hasPersistenceConflict: () => boolean;
  begin: () => Promise<Prepared>;
  operationIdOf: (prepared: Prepared) => string;
  rehydrate: () => Promise<string | null>;
  replaceMemory: (raw: string) => void | Promise<void>;
  completeHydration: () => Promise<void>;
  restoreRollbackMemory: (snapshot: Snapshot, raw: string) => void | Promise<void>;
  finalize: (operationId: string) => Promise<Result>;
  onCommitted?: () => void;
  rollback: (operationId: string) => Promise<unknown>;
  setLocked: (locked: boolean) => void;
};

/** 两阶段数据事务：native pointer commit 后，前端 rehydrate 验证成功才 finalize。 */
export async function runDataTransaction<Snapshot, Prepared, Result>(
  dependencies: DataTransactionDependencies<Snapshot, Prepared, Result>
): Promise<Result> {
  const memory = dependencies.captureMemory();
  let operationId: string | null = null;
  dependencies.setLocked(true);
  try {
    await dependencies.pausePersistence();
    const prepared = await dependencies.begin();
    operationId = dependencies.operationIdOf(prepared);
    const raw = await dependencies.rehydrate();
    if (!raw) throw new Error("目标目录没有可重新水合的 Toskr 状态");
    await dependencies.replaceMemory(raw);
    await dependencies.completeHydration();
    const result = await dependencies.finalize(operationId);
    dependencies.onCommitted?.();
    dependencies.resumePersistence();
    dependencies.setLocked(false);
    return result;
  } catch (operationError) {
    if (operationId) {
      try {
        await dependencies.rollback(operationId);
        // rehydrate 已把 CAS 基线切到失败目标；native 回滚后仍保持 paused，
        // 必须重新读取旧活动目录，下一次正常写入才不会产生伪冲突。
        const restoredRaw = await dependencies.rehydrate();
        if (!restoredRaw) throw new Error("回滚后的活动目录没有可重新水合状态");
        // recovery 捕获的是 native begin 时的真实源版本，可能已由外部同步从
        // 事务前内存 A 更新为 B。必须采用回滚后的磁盘 B，不能再把 A 写回。
        await dependencies.restoreRollbackMemory(memory, restoredRaw);
        await dependencies.completeHydration();
      } catch (rollbackError) {
        dependencies.restoreMemory(memory);
        throw new DataRollbackFailure(operationError, rollbackError);
      }
    } else {
      // native 尚未开始时磁盘/指针均未变化，恢复事务前内存即可。
      dependencies.restoreMemory(memory);
    }
    if (dependencies.hasPersistenceConflict()) {
      // flush/OCC 已进入 durable conflict 状态；保持 paused + UI locked，
      // 只能由“重新加载/另存恢复副本”显式解除。
      throw operationError;
    }
    dependencies.resumePersistence();
    dependencies.setLocked(false);
    throw operationError;
  }
}

export type PendingDataTransactionDependencies<Result> = Pick<
  DataTransactionDependencies<unknown, unknown, Result>,
  | "pausePersistence"
  | "resumePersistence"
  | "hasPersistenceConflict"
  | "rehydrate"
  | "replaceMemory"
  | "completeHydration"
  | "finalize"
  | "rollback"
  | "setLocked"
>;

/** WebView 重载后续接 Native 已提交、仍 awaitingRehydrate 的两阶段事务。 */
export async function resumePendingDataTransaction<Result>(
  operationId: string,
  dependencies: PendingDataTransactionDependencies<Result>
): Promise<Result> {
  dependencies.setLocked(true);
  try {
    await dependencies.pausePersistence();
    const raw = await dependencies.rehydrate();
    if (!raw) throw new Error("待完成目标没有可重新水合的 Toskr 状态");
    await dependencies.replaceMemory(raw);
    await dependencies.completeHydration();
    const result = await dependencies.finalize(operationId);
    dependencies.resumePersistence();
    dependencies.setLocked(false);
    return result;
  } catch (operationError) {
    try {
      await dependencies.rollback(operationId);
      const restoredRaw = await dependencies.rehydrate();
      if (!restoredRaw) throw new Error("回滚后的活动目录没有可重新水合状态");
      await dependencies.replaceMemory(restoredRaw);
      await dependencies.completeHydration();
    } catch (rollbackError) {
      throw new DataRollbackFailure(operationError, rollbackError);
    }
    if (dependencies.hasPersistenceConflict()) throw operationError;
    dependencies.resumePersistence();
    dependencies.setLocked(false);
    throw operationError;
  }
}
