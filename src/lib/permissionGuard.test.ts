import { describe, expect, it } from "vitest";

import {
  advancePermissionGuard,
  initialPermissionGuardState,
  type PermissionGuardState,
} from "@/lib/permissionGuard";

const healthyIdle = { listening: true, installed: true, receiving: false };
const receiving = { listening: true, installed: true, receiving: true };
const noAuth = { listening: false, installed: true, receiving: false };

function run(
  ticks: Array<{
    tap: { listening: boolean; installed: boolean; receiving: boolean };
    keydownBefore?: boolean;
  }>
) {
  let state: PermissionGuardState = initialPermissionGuardState();
  let stuck = false;
  for (const tick of ticks) {
    if (tick.keydownBefore) state = { ...state, webviewKeySeen: true };
    const advanced = advancePermissionGuard(state, tick.tap);
    state = advanced.state;
    stuck = advanced.stuck;
  }
  return { state, stuck };
}

describe("advancePermissionGuard", () => {
  it("授权正常、启动后长时间无人打字不误判为被扣（更新重启误报回归）", () => {
    const { stuck } = run(
      Array.from({ length: 20 }, () => ({ tap: healthyIdle }))
    );
    expect(stuck).toBe(false);
  });

  it("webview 收到过按键而 tap 连续 4 tick 无事件才定罪", () => {
    const ticks = Array.from({ length: 4 }, (_, i) => ({
      tap: healthyIdle,
      keydownBefore: i === 0,
    }));
    expect(run(ticks.slice(0, 3)).stuck).toBe(false);
    expect(run(ticks).stuck).toBe(true);
  });

  it("授权查询单 tick 抖动不报，连续 2 tick 为否才报", () => {
    expect(run([{ tap: noAuth }]).stuck).toBe(false);
    expect(run([{ tap: noAuth }, { tap: healthyIdle }]).stuck).toBe(false);
    expect(run([{ tap: noAuth }, { tap: noAuth }]).stuck).toBe(true);
  });

  it("事件到达即解除定罪并清空按键证据", () => {
    const blocked = [
      { tap: healthyIdle, keydownBefore: true },
      { tap: healthyIdle },
      { tap: healthyIdle },
      { tap: healthyIdle },
    ];
    const recovered = run([...blocked, { tap: receiving }]);
    expect(recovered.stuck).toBe(false);
    expect(recovered.state.webviewKeySeen).toBe(false);
    expect(recovered.state.stuckTicks).toBe(0);
  });

  it("恢复健康后再次静默等待不会凭旧证据复发", () => {
    const { stuck } = run([
      { tap: healthyIdle, keydownBefore: true },
      { tap: receiving },
      ...Array.from({ length: 10 }, () => ({ tap: healthyIdle })),
    ]);
    expect(stuck).toBe(false);
  });
});
