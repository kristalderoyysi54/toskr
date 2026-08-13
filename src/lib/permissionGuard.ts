/**
 * 权限守护的「输入监控被扣」判定（App 级 3s 轮询跨 tick 累计）。
 *
 * 只认铁证，不把「启动后没人打字」当故障——更新自动重启后用户盯着界面
 * 不敲键，老逻辑 12s 即误弹「键盘事件被系统拦截」横幅，诱导无谓的
 * 「重置授权/重启」。铁证二选一：
 * 1. 系统授权查询（CGPreflightListenEventAccess）连续 2 tick 为否；
 * 2. webview 自己收到过 keydown（键盘活动确凿存在）而 tap 连续 4 tick 无事件。
 */
export type PermissionGuardState = {
  /** 授权查询连续为否的 tick 数。 */
  noAuthTicks: number;
  /** 已授权+已安装但 tap 无事件的连续 tick 数。 */
  stuckTicks: number;
  /** 不健康窗口内 webview 收到过 keydown（收到事件后清零）。 */
  webviewKeySeen: boolean;
};

export function initialPermissionGuardState(): PermissionGuardState {
  return { noAuthTicks: 0, stuckTicks: 0, webviewKeySeen: false };
}

export function advancePermissionGuard(
  state: PermissionGuardState,
  tap: { listening: boolean; installed: boolean; receiving: boolean }
): { state: PermissionGuardState; stuck: boolean } {
  const noAuthTicks = tap.listening ? 0 : state.noAuthTicks + 1;
  const stuckTicks =
    tap.listening && tap.installed && !tap.receiving ? state.stuckTicks + 1 : 0;
  const webviewKeySeen = tap.receiving ? false : state.webviewKeySeen;
  return {
    state: { noAuthTicks, stuckTicks, webviewKeySeen },
    stuck: noAuthTicks >= 2 || (stuckTicks >= 4 && webviewKeySeen),
  };
}
