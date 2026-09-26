import type {
  DataLocationInspection,
  DataOperationAction,
} from "./tauri";

export function needsBlockingDataOverlay(activity: {
  locked: boolean;
  phase: string;
}): boolean {
  return (
    activity.locked &&
    activity.phase !== "conflict" &&
    activity.phase !== "storageRecovery"
  );
}

/** 目录预检结果到用户可执行动作的唯一决策表；永远不产生自动 merge。 */
export function availableDataActions(
  inspection: DataLocationInspection
): DataOperationAction[] {
  if (inspection.sameAsActive || !inspection.writable) return ["cancel"];
  if (inspection.kind === "missing" || inspection.kind === "empty") {
    return ["migrateCurrentToTarget", "cancel"];
  }
  if (inspection.kind === "valid") {
    return ["loadExistingTarget", "replaceTargetWithCurrent", "cancel"];
  }
  // corrupt / unsupported / nonToskr / encrypted（外机加密数据本机解不开，
  // 正路是「导入完整备份」而非切目录）都只能取消
  return ["cancel"];
}

/** 最后写入时间差在此阈值内视为同期（切换前的刷写会让两边相差几秒）。 */
export const DATA_FRESHNESS_TOLERANCE_MS = 60_000;

export type DataFreshness = "older" | "newer" | "similar" | "unknown";

/**
 * 目标数据集相对当前数据集的新旧：加载更旧的目标 / 用当前数据替换更新的目标
 * 都会让用户看到或留下陈旧数据（2026-09-25 误载默认目录旧数据的事故）。
 */
export function targetDataFreshness(inspection: DataLocationInspection): DataFreshness {
  const target = inspection.dataModifiedAtMs;
  const current = inspection.current?.dataModifiedAtMs;
  if (inspection.kind !== "valid" || target == null || current == null) return "unknown";
  if (target < current - DATA_FRESHNESS_TOLERANCE_MS) return "older";
  if (target > current + DATA_FRESHNESS_TOLERANCE_MS) return "newer";
  return "similar";
}
