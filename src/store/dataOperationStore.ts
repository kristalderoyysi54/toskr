import { create } from "zustand";

import type { DataOperationPhase } from "@/lib/tauri";

export type DataActivity = {
  locked: boolean;
  phase: DataOperationPhase | "idle" | "conflict" | "storageRecovery";
  message: string;
};

type DataOperationState = DataActivity & {
  update: (activity: Partial<DataActivity>) => void;
};

export const useDataOperationStore = create<DataOperationState>()((set) => ({
  // main WebView 必须先查询 Native pending journal/status，确认没有待续事务后
  // 才开放写入；否则 WebView reload 会短暂穿透 awaitingRehydrate。
  locked: true,
  phase: "prepare",
  message: "正在核验数据事务状态…",
  update: (activity) => set(activity),
}));

export function isDataOperationLocked(): boolean {
  return useDataOperationStore.getState().locked;
}
