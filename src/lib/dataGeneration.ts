import { emit } from "@tauri-apps/api/event";

let generation = 0;
let inFlight = 0;

export const DATA_CONTEXT_INVALIDATED_EVENT = "toskr://data-context-invalidated";

/** 主数据集上下文代数；目录事务一开始即递增，使所有旧预览载荷失效。 */
export function advanceDataGeneration(): number {
  generation = (generation + 1) % Number.MAX_SAFE_INTEGER;
  void emit(DATA_CONTEXT_INVALIDATED_EVENT, { generation }).catch(() => {});
  return generation;
}

export function currentDataGeneration(): number {
  return generation;
}

export function matchesDataGeneration(candidate: number): boolean {
  return Number.isSafeInteger(candidate) && candidate === generation;
}

export type DataGenerationLease = {
  generation: number;
  release: () => void;
};

/** AI/发送等异步业务持有租约时，目录事务必须 fail-closed。 */
export function beginDataGenerationLease(): DataGenerationLease {
  inFlight += 1;
  let released = false;
  return {
    generation,
    release: () => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
    },
  };
}

export function hasDataGenerationLeases(): boolean {
  return inFlight > 0;
}
