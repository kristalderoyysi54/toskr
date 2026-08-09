import { describe, expect, it, vi } from "vitest";

import { hasDataOperationOwner, withDataOperationMutex } from "./dataOperationMutex";

describe("data operation mutex", () => {
  it("fails a concurrent operation without releasing the first owner", async () => {
    let finish!: () => void;
    const first = withDataOperationMutex(
      "执行第一事务",
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    await vi.waitFor(() => expect(hasDataOperationOwner()).toBe(true));

    await expect(
      withDataOperationMutex("执行第二事务", async () => undefined)
    ).rejects.toThrow("已有数据操作进行中");
    expect(hasDataOperationOwner()).toBe(true);

    finish();
    await first;
    expect(hasDataOperationOwner()).toBe(false);
  });
});
