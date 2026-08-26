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
