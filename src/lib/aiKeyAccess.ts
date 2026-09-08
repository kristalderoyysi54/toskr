import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";

import { api, isAiKeyStatus, type AiKeyStatus } from "@/lib/tauri";
import {
  legacyAiApiKey,
  migrateLegacyAiApiKey,
  withoutLegacyAiApiKey,
} from "@/lib/aiKeyMigration";
import { currentDataGeneration, matchesDataGeneration } from "@/lib/dataGeneration";
import { isDataOperationLocked } from "@/store/dataOperationStore";
import { useNotesStore } from "@/store/notesStore";

const AI_KEY_ACCESS_REQUEST = "toskr://ai-key-access-request";
const AI_KEY_ACCESS_RESULT = "toskr://ai-key-access-result";
const pendingAccess = new Map<number, Promise<AiKeyStatus>>();

/** 只由 main 在实际使用 AI 时调用；读取已有授权，必要时迁移当前目录旧副本。 */
export function getAiKeyStatusForUse(): Promise<AiKeyStatus> {
  const generation = currentDataGeneration();
  const assertCurrent = () => {
    if (isDataOperationLocked() || !matchesDataGeneration(generation)) {
      throw new Error("数据操作进行中，请稍后再使用 AI");
    }
  };
  try {
    assertCurrent();
  } catch (error) {
    return Promise.reject(error);
  }
  const pending = pendingAccess.get(generation);
  if (pending) return pending;
  const source = useNotesStore.getState().settings;
  const legacyKey = legacyAiApiKey(source);
  const access = Promise.resolve().then(async () => {
    assertCurrent();
    let status = await api.getAiKeyStatus();
    assertCurrent();
    if (!legacyKey) return status;
    // 先读取状态：用户取消授权时不立刻再尝试一次写入授权。
    const result = await migrateLegacyAiApiKey(source, {
      setAiApiKey: async (key, overwriteExisting) => {
        status = await api.setAiApiKey(key, overwriteExisting);
        return status;
      },
      commit: () => {
        const current = useNotesStore.getState().settings;
        if (
          !matchesDataGeneration(generation) ||
          isDataOperationLocked() ||
          legacyAiApiKey(current) !== legacyKey
        ) return;
        useNotesStore.setState({ settings: withoutLegacyAiApiKey(current) });
      },
    });
    assertCurrent();
    // 钥匙串已有不同密钥时继续使用现有配置；旧副本只在确认迁移成功后清理。
    if (result === "failed" && !status.configured) {
      throw new Error("AI 密钥迁移失败；旧副本仍保留，请在 AI 智能设置中重试");
    }
    return status;
  }).finally(() => pendingAccess.delete(generation));
  pendingAccess.set(generation, access);
  return access;
}

type KeyAccessResult = { requestId: string; status?: AiKeyStatus };

/** 安装监听本身不会访问钥匙串；设置窗也只能收到无密钥的状态。 */
export function installAiKeyAccessHost(): Promise<UnlistenFn> {
  return listen<{ requestId: string }>(AI_KEY_ACCESS_REQUEST, (event) => {
    const requestId = event.payload?.requestId;
    if (typeof requestId !== "string" || !requestId || requestId.length > 100) return;
    void getAiKeyStatusForUse().then(
      (status) => emitTo("settings", AI_KEY_ACCESS_RESULT, { requestId, status }),
      () => emitTo("settings", AI_KEY_ACCESS_RESULT, { requestId })
    ).catch(() => {});
  });
}

/** 设置窗没有旧 secret，由主窗口迁移并只回传状态。 */
export async function requestAiKeyStatusForSettings(): Promise<AiKeyStatus> {
  const requestId = crypto.randomUUID();
  let stop: UnlistenFn | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const result = new Promise<AiKeyStatus>((resolve, reject) => {
    const fail = () => reject(new Error("无法读取 AI 密钥状态，请稍后重试"));
    timer = setTimeout(fail, 60_000);
    void listen<KeyAccessResult>(AI_KEY_ACCESS_RESULT, (event) => {
      if (event.payload?.requestId !== requestId) return;
      if (isAiKeyStatus(event.payload.status)) resolve(event.payload.status);
      else fail();
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      stop = unlisten;
      return emitTo("main", AI_KEY_ACCESS_REQUEST, { requestId });
    }).catch(fail);
  });
  try {
    return await result;
  } finally {
    disposed = true;
    clearTimeout(timer);
    stop?.();
  }
}
