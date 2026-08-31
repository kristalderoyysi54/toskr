import { emit, emitTo } from "@tauri-apps/api/event";

import {
  resumePendingDataTransaction,
  runDataTransaction,
} from "@/lib/dataTransaction";
import { withDataOperationMutex } from "@/lib/dataOperationMutex";
import {
  advanceDataGeneration,
  hasDataGenerationLeases,
} from "@/lib/dataGeneration";
import {
  buildBackupPayload,
  buildMediaIntegrityPayload,
} from "@/lib/backup";
import { applyRuntimeSettingsStrict } from "@/lib/runtimeSettings";
import {
  api,
  type BackupImportPrepared,
  type BackupInspection,
  type DataOperationPlan,
  type DataOperationResult,
  type MediaIntegrityReport,
} from "@/lib/tauri";
import {
  hasPersistenceConflict,
  clearPersistenceConflict,
  enterPersistenceConflict,
  commitPersistedValueWhilePaused,
  currentPersistenceRevision,
  pausePersistence,
  rehydrateFromActiveDataDir,
  replacePersistedValueWhilePaused,
  resolvePersistenceConflictByReload,
  resumePersistence,
} from "@/store/persistStorage";
import {
  captureNotesStoreSnapshot,
  mergePreEncryptSnapshotWithCurrent,
  serializePersistentState,
  replaceNotesStoreFromPersisted,
  restoreNotesStoreAfterRollback,
  restoreNotesStoreSnapshot,
  STORE_VERSION,
  useNotesStore,
} from "@/store/notesStore";
import { useDataOperationStore, type DataActivity } from "@/store/dataOperationStore";
import { clearTargetProfileOverride } from "@/store/targetStore";

export const DATA_ACTIVITY_EVENT = "toskr://data-activity";
export const DATA_LOCATION_CHANGED_EVENT = "toskr://data-location-changed";
export const DATA_RUNTIME_READY_EVENT = "toskr:data-runtime-ready";
const SETTINGS_STATE_EVENT = "toskr://settings-state";

function updateActivity(activity: Partial<DataActivity>) {
  const wasLocked = useDataOperationStore.getState().locked;
  useDataOperationStore.getState().update(activity);
  const current = useDataOperationStore.getState();
  if (!wasLocked && current.locked) {
    advanceDataGeneration();
    clearTargetProfileOverride();
  }
  if (wasLocked && !current.locked && typeof window !== "undefined") {
    window.dispatchEvent(new Event(DATA_RUNTIME_READY_EVENT));
  }
  void emit(DATA_ACTIVITY_EVENT, {
    locked: current.locked,
    phase: current.phase,
    message: current.message,
  }).catch(() => {});
}

export function reportDataActivity(activity: Partial<DataActivity>) {
  updateActivity(activity);
}

function sharedDependencies<Prepared>(
  begin: () => Promise<Prepared>,
  operationIdOf: (prepared: Prepared) => string,
  replaceMemory: (raw: string) => void | Promise<void> =
    replaceMemoryAndRuntime
) {
  return {
    captureMemory: captureNotesStoreSnapshot,
    restoreMemory: restoreNotesStoreSnapshot,
    pausePersistence,
    resumePersistence,
    hasPersistenceConflict,
    begin,
    operationIdOf,
    rehydrate: rehydrateFromActiveDataDir,
    replaceMemory,
    completeHydration: async () => {
      if (!useNotesStore.persist.hasHydrated()) {
        await useNotesStore.persist.rehydrate();
      }
    },
    restoreRollbackMemory: restoreRollbackMemoryAndRuntime,
    finalize: api.finalizeDataOperation,
    rollback: api.rollbackDataOperation,
    setLocked: (locked: boolean) =>
      updateActivity({
        locked,
        phase: locked ? "prepare" : "idle",
        message: locked ? "正在冻结写入并验证数据…" : "",
      }),
  };
}

async function broadcastRehydratedSettings(): Promise<void> {
  const settings = useNotesStore.getState().settings;
  await applyRuntimeSettingsStrict(settings);
  void emitTo("settings", SETTINGS_STATE_EVENT, settings).catch(() => {});
}

async function replaceMemoryAndRuntime(raw: string): Promise<void> {
  replaceNotesStoreFromPersisted(raw);
  await broadcastRehydratedSettings();
}

async function restoreRollbackMemoryAndRuntime(
  snapshot: ReturnType<typeof captureNotesStoreSnapshot>,
  raw: string
): Promise<void> {
  restoreNotesStoreAfterRollback(snapshot, raw);
  await broadcastRehydratedSettings();
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
}

export async function runDataLocationOperation(
  plan: DataOperationPlan
): Promise<DataOperationResult> {
  return withDataOperationMutex("切换数据目录", async () => {
    if (hasDataGenerationLeases()) {
      throw new Error("发送或 AI 操作仍在进行，请完成后再切换数据目录");
    }
    return runDataTransaction(
      sharedDependencies(() => api.beginDataOperation(plan), (prepared) => prepared.operationId)
    );
  });
}

export async function runRecoveryDataLocationOperation(
  plan: DataOperationPlan
): Promise<DataOperationResult> {
  return withDataOperationMutex("恢复数据目录", async () => {
    if (plan.action !== "loadExistingTarget") {
      throw new Error("恢复模式只允许加载已有有效数据目录");
    }
    const dependencies = sharedDependencies(
      () => api.beginRecoveryDataOperation(plan),
      (prepared) => prepared.operationId
    );
    const result = await runDataTransaction({
      ...dependencies,
      onCommitted: clearPersistenceConflict,
    });
    await api.clearDataConflict();
    return result;
  });
}

export async function resumePendingDataOperation(
  operationId: string
): Promise<DataOperationResult> {
  return withDataOperationMutex("恢复待完成数据事务", () =>
    resumePendingDataTransaction(operationId, {
      pausePersistence,
      resumePersistence,
      hasPersistenceConflict,
      rehydrate: rehydrateFromActiveDataDir,
      replaceMemory: replaceMemoryAndRuntime,
      completeHydration: async () => {
        if (!useNotesStore.persist.hasHydrated()) {
          await useNotesStore.persist.rehydrate();
        }
      },
      finalize: api.finalizeDataOperation,
      rollback: api.rollbackDataOperation,
      setLocked: (locked) =>
        updateActivity({
          locked,
          phase: locked ? "rehydrate" : "idle",
          message: locked ? "正在恢复待完成的数据事务…" : "",
        }),
    })
  );
}

export async function runCompleteBackupImport(
  path: string,
  operationId: string,
  expectedRevision: string
): Promise<{ prepared: BackupImportPrepared; result: DataOperationResult }> {
  return withDataOperationMutex("恢复完整备份", async () => {
    if (hasDataGenerationLeases()) {
      throw new Error("发送或 AI 操作仍在进行，请完成后再恢复备份");
    }
    let prepared: BackupImportPrepared | null = null;
    try {
      const result = await runDataTransaction(
        sharedDependencies(
          async () => {
            const activeRevision = currentPersistenceRevision();
            if (!activeRevision) throw new Error("持久化基线尚未建立");
            prepared = await api.beginCompleteBackupImport(
              path,
              operationId,
              expectedRevision,
              activeRevision
            );
            return prepared;
          },
          (value) => value.operation.operationId
        )
      );
      return { prepared: prepared!, result };
    } catch (error) {
      if (errorCode(error) === "sourceChanged") {
        enterPersistenceConflict(error);
        updateActivity({
          locked: true,
          phase: "conflict",
          message: "完整恢复期间检测到活动数据外部变化；持久化保持冻结",
        });
      }
      throw error;
    }
  });
}

export async function runCompleteBackupExport(
  path: string
): Promise<BackupInspection> {
  return withDataOperationMutex("导出完整备份", async () => {
    if (hasDataGenerationLeases()) {
      throw new Error("发送或 AI 操作仍在进行，请完成后再导出备份");
    }
    updateActivity({ locked: true, phase: "prepare", message: "正在冻结并校验完整备份…" });
    try {
      await pausePersistence();
      const activeRevision = currentPersistenceRevision();
      if (!activeRevision) throw new Error("持久化基线尚未建立");
      const inspection = await api.exportCompleteBackup(
        path,
        JSON.stringify(buildBackupPayload(useNotesStore.getState())),
        activeRevision
      );
      resumePersistence();
      updateActivity({ locked: false, phase: "complete", message: "完整备份已验证" });
      return inspection;
    } catch (error) {
      if (errorCode(error) === "sourceChanged") {
        enterPersistenceConflict(error);
      }
      if (hasPersistenceConflict()) {
        updateActivity({
          locked: true,
          phase: "conflict",
          message: "导出期间检测到活动数据外部变化；持久化保持冻结",
        });
      } else {
        resumePersistence();
        updateActivity({ locked: false, phase: "idle", message: "" });
      }
      throw error;
    }
  });
}

export async function runLegacyJsonImport(
  path: string,
  operationId: string,
  expectedRevision: string
): Promise<{
  added: { notes: number; tasks: number; bills: number; skippedDuplicates: number };
  recoveryPath: string;
}> {
  return withDataOperationMutex("导入旧 JSON", async () => {
  const memory = captureNotesStoreSnapshot();
  updateActivity({
    locked: true,
    phase: "prepare",
    message: "正在创建当前数据恢复点…",
  });
  try {
    await pausePersistence();
    const activeRevision = currentPersistenceRevision();
    if (!activeRevision) throw new Error("持久化基线尚未建立");
    const recoveryPath = await api.createDataRecoveryBackup(
      JSON.stringify(buildBackupPayload(useNotesStore.getState())),
      operationId,
      activeRevision
    );
    const raw = await api.readLegacyBackup(path, expectedRevision);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("旧 JSON 顶层必须是对象");
    }
    const added = useNotesStore.getState().importMerge(parsed);
    await commitPersistedValueWhilePaused(
      "toskr",
      serializePersistentState(useNotesStore.getState())
    );
    resumePersistence();
    updateActivity({ locked: false, phase: "idle", message: "" });
    return { added, recoveryPath };
  } catch (error) {
    restoreNotesStoreSnapshot(memory);
    if (errorCode(error) === "sourceChanged") {
      enterPersistenceConflict(error);
    }
    if (hasPersistenceConflict()) {
      updateActivity({
        locked: true,
        phase: "rollback",
        message: "检测到外部数据冲突；持久化保持冻结",
      });
      throw error;
    }
    resumePersistence();
    updateActivity({ locked: false, phase: "idle", message: "" });
    throw error;
  }
  });
}

export async function runPreEncryptSnapshotImport(
  path: string,
  operationId: string,
  expectedRevision: string
): Promise<{
  counts: { notes: number; tasks: number; bills: number; messages: number };
  recoveryPath: string;
  health: MediaIntegrityReport;
  warning: string | null;
}> {
  return withDataOperationMutex("恢复迁移保险档", async () => {
    if (hasDataGenerationLeases()) {
      throw new Error("发送或 AI 操作仍在进行，请完成后再恢复数据");
    }
    const memory = captureNotesStoreSnapshot();
    let committed = false;
    updateActivity({
      locked: true,
      phase: "prepare",
      message: "正在备份当前索引并验证迁移保险档…",
    });
    try {
      await pausePersistence();
      const activeRevision = currentPersistenceRevision();
      if (!activeRevision) throw new Error("持久化基线尚未建立");
      const recoveryPath = await api.createDataRecoveryBackup(
        JSON.stringify(buildBackupPayload(useNotesStore.getState())),
        operationId,
        activeRevision
      );
      const recoveredRaw = await api.readPreEncryptSnapshot(
        path,
        expectedRevision
      );
      const merged = mergePreEncryptSnapshotWithCurrent(recoveredRaw, memory);
      const mediaStateJson = JSON.stringify(
        buildMediaIntegrityPayload({ ...merged, undoStack: [] })
      );
      const preflightHealth = await api.inspectMediaIntegrity(mediaStateJson);
      if (preflightHealth.missing.length) {
        throw new Error(
          `迁移保险档引用的 ${preflightHealth.missing.length} 个媒体文件不在当前数据目录；已停止恢复。请加载原数据目录或改用包含媒体的完整备份`
        );
      }
      useNotesStore.setState({
        ...merged,
        checkedIds: [],
        undoStack: [],
      });
      await commitPersistedValueWhilePaused(
        "toskr",
        serializePersistentState(useNotesStore.getState())
      );
      committed = true;
      resumePersistence();
      const warnings: string[] = [];
      try {
        await broadcastRehydratedSettings();
      } catch (error) {
        warnings.push(`Native 设置刷新失败：${errorMessage(error)}；重启后会重新应用`);
      }
      let health = preflightHealth;
      try {
        health = await api.inspectMediaIntegrity(mediaStateJson);
        if (health.missing.length) {
          warnings.push(`提交后检测到 ${health.missing.length} 个媒体文件缺失`);
        }
      } catch (error) {
        warnings.push(`提交后媒体复检失败：${errorMessage(error)}`);
      }
      const warning = warnings.length ? warnings.join("；") : null;
      updateActivity({
        locked: false,
        phase: "complete",
        message: warning
          ? `迁移保险档已恢复；${warning}`
          : "迁移保险档已恢复，当前新增记录已按 ID 保留",
      });
      return {
        counts: {
          notes: merged.notes.length,
          tasks: merged.tasks.length,
          bills: merged.bills.length,
          messages: merged.messages.length,
        },
        recoveryPath,
        health,
        warning,
      };
    } catch (error) {
      if (!committed) restoreNotesStoreSnapshot(memory);
      if (errorCode(error) === "sourceChanged") {
        enterPersistenceConflict(error);
      }
      if (hasPersistenceConflict()) {
        updateActivity({
          locked: true,
          phase: "rollback",
          message: "恢复期间检测到外部数据变化；持久化保持冻结",
        });
      } else {
        resumePersistence();
        updateActivity({ locked: false, phase: "idle", message: "" });
      }
      throw error;
    }
  });
}

export async function reloadAfterPersistenceConflict(): Promise<void> {
  return withDataOperationMutex("重新加载冲突版本", async () => {
  updateActivity({
    locked: true,
    phase: "rehydrate",
    message: "正在从磁盘重新加载外部新版本…",
  });
  try {
    const raw = await resolvePersistenceConflictByReload();
    // 外部明确删除数据文件也是一个可采用的磁盘版本；用户点击“重新加载”
    // 即授权加载经过 decoder 验证的空 store，而不是永久困在冲突遮罩。
    const adopted = raw ?? JSON.stringify({ state: {}, version: STORE_VERSION });
    if (!raw) {
      await replacePersistedValueWhilePaused("toskr", adopted);
    }
    await replaceMemoryAndRuntime(adopted);
    await api.clearDataConflict();
    resumePersistence();
    updateActivity({ locked: false, phase: "complete", message: "已加载磁盘新版本" });
  } catch (error) {
    // resolveConflictByReload 会冻结持久化；失败时保持只读，避免再次覆盖。
    updateActivity({
      locked: true,
      phase: "rollback",
      message: `重新加载失败：${String(error)}`,
    });
    throw error;
  }
  });
}
