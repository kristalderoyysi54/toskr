import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { TARGET_CHANGED_EVENT, type TargetSnapshot } from "@/lib/tauri";
import {
  applyTargetEvent,
  readTarget,
} from "@/store/targetStore";

type TargetListener = (
  handler: (snapshot: TargetSnapshot) => void
) => Promise<UnlistenFn>;

/**
 * WebView 可被系统独立回收，而 Native 目标状态仍存活。先接上增量事件，再读取
 * 一次当前快照，既补回冷/重载基线，也不留“读取后、订阅前”丢事件窗口。
 */
export function installTargetSnapshotSync(options: {
  listen?: TargetListener;
} = {}) {
  let alive = true;
  let stop: UnlistenFn | null = null;
  const listenToChanges: TargetListener = options.listen ?? ((handler) =>
    listen<TargetSnapshot>(TARGET_CHANGED_EVENT, (event) => handler(event.payload)));

  const ready = listenToChanges((snapshot) => {
    if (alive) applyTargetEvent(snapshot);
  })
    .then(async (unlisten) => {
      if (!alive) {
        unlisten();
        return;
      }
      stop = unlisten;
      await readTarget();
    })
    .catch(() => {
      // 未建立增量监听时保持 unknown/blocked，不能用一次性快照放开发送。
    });

  return {
    ready,
    dispose() {
      alive = false;
      stop?.();
    },
  };
}
