import { describe, expect, it } from "vitest";
import {
  availableDataActions,
  DATA_FRESHNESS_TOLERANCE_MS,
  needsBlockingDataOverlay,
  targetDataFreshness,
} from "./dataLocation";
import type { DataLocationInspection, DataLocationKind } from "./tauri";

function inspection(
  kind: DataLocationKind,
  overrides: Partial<DataLocationInspection> = {}
): DataLocationInspection {
  return {
    path: "/target",
    kind,
    revision: "target-revision",
    readable: true,
    writable: true,
    sameAsActive: false,
    externalSyncLikely: false,
    storeVersion: kind === "valid" ? 8 : null,
    noteCount: 0,
    taskCount: 0,
    mediaCount: 0,
    ordinaryFileCount: 0,
    ...overrides,
  };
}

describe("data location decision table", () => {
  it("keeps conflict recovery actions reachable while ordinary transactions block input", () => {
    expect(needsBlockingDataOverlay({ locked: true, phase: "prepare" })).toBe(true);
    expect(needsBlockingDataOverlay({ locked: true, phase: "conflict" })).toBe(false);
    expect(
      needsBlockingDataOverlay({ locked: true, phase: "storageRecovery" })
    ).toBe(false);
  });

  it.each(["missing", "empty"] as const)(
    "offers migrate and cancel for %s targets",
    (kind) => {
      expect(availableDataActions(inspection(kind))).toEqual([
        "migrateCurrentToTarget",
        "cancel",
      ]);
    }
  );

  it("keeps load and explicit replacement separate for valid datasets", () => {
    expect(availableDataActions(inspection("valid"))).toEqual([
      "loadExistingTarget",
      "replaceTargetWithCurrent",
      "cancel",
    ]);
  });

  it.each(["nonToskr", "corrupt", "unsupported"] as const)(
    "fails closed for %s targets",
    (kind) => {
      expect(availableDataActions(inspection(kind))).toEqual(["cancel"]);
    }
  );

  it("offers only cancel for same-path or non-writable targets", () => {
    expect(
      availableDataActions(inspection("valid", { sameAsActive: true }))
    ).toEqual(["cancel"]);
    expect(
      availableDataActions(inspection("empty", { writable: false }))
    ).toEqual(["cancel"]);
  });
});

describe("target data freshness", () => {
  const current = { noteCount: 10, taskCount: 0, mediaCount: 0, dataModifiedAtMs: 1_000_000_000 };
  const at = (dataModifiedAtMs: number | null) =>
    inspection("valid", { dataModifiedAtMs, current });

  it("flags an older target so loading it cannot silently show stale data", () => {
    expect(targetDataFreshness(at(current.dataModifiedAtMs - DATA_FRESHNESS_TOLERANCE_MS - 1))).toBe("older");
  });

  it("flags a newer target so replacing it cannot overwrite fresher data", () => {
    expect(targetDataFreshness(at(current.dataModifiedAtMs + DATA_FRESHNESS_TOLERANCE_MS + 1))).toBe("newer");
  });

  it("treats writes within the tolerance as the same period", () => {
    expect(targetDataFreshness(at(current.dataModifiedAtMs - 5_000))).toBe("similar");
  });

  it("is unknown without both timestamps or for non-valid targets", () => {
    expect(targetDataFreshness(at(null))).toBe("unknown");
    expect(targetDataFreshness(inspection("valid", { dataModifiedAtMs: 1 }))).toBe("unknown");
    expect(targetDataFreshness(inspection("corrupt", { dataModifiedAtMs: 1, current }))).toBe("unknown");
  });
});
