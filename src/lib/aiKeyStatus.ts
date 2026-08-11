import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  AI_KEY_STATUS_EVENT,
  api,
  isAiKeyStatus,
  type AiKeyStatus,
} from "@/lib/tauri";

/**
 * 先建立事件监听再查当前值；查询在途若收到更新事件，丢弃较旧查询结果。
 * 这样设置窗不会在“保存成功事件”后又被慢查询回滚成未配置。
 */
export async function subscribeAiKeyStatus(
  onStatus: (status: AiKeyStatus) => void,
  getStatus: () => Promise<AiKeyStatus> = api.getAiKeyStatus,
  onError?: () => void
): Promise<UnlistenFn> {
  let eventRevision = 0;
  let unlisten: UnlistenFn;
  try {
    unlisten = await listen<AiKeyStatus>(AI_KEY_STATUS_EVENT, (event) => {
      if (!isAiKeyStatus(event.payload)) return;
      eventRevision += 1;
      onStatus(event.payload);
    });
  } catch {
    onError?.();
    return () => {};
  }
  const queryRevision = eventRevision;
  try {
    const status = await getStatus();
    if (eventRevision === queryRevision && isAiKeyStatus(status)) {
      onStatus(status);
    }
  } catch {
    onError?.();
  }
  return unlisten;
}
