import { api } from "@/lib/tauri";
import { useNotesStore, type Settings } from "@/store/notesStore";

export interface AiPreset {
  id: "deepseek" | "openai" | "kimi" | "qwen" | "custom";
  label: string;
  baseUrl: string;
  modelHint: string;
}

export const AI_PRESETS: readonly AiPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    modelHint: "deepseek-chat",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    modelHint: "gpt-4o-mini",
  },
  {
    id: "kimi",
    label: "Kimi",
    baseUrl: "https://api.moonshot.cn",
    modelHint: "moonshot-v1-8k",
  },
  {
    id: "qwen",
    label: "通义",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    modelHint: "qwen-plus",
  },
  { id: "custom", label: "自定义", baseUrl: "", modelHint: "" },
];

export function matchPreset(baseUrl: string): AiPreset["id"] {
  return (
    AI_PRESETS.find(
      (preset) => preset.id !== "custom" && preset.baseUrl === baseUrl.trim()
    )?.id ?? "custom"
  );
}

export function aiReady(
  settings: Pick<Settings, "aiEnabled" | "aiBaseUrl" | "aiModel">
): boolean {
  return settings.aiEnabled &&
    !!settings.aiBaseUrl.trim() &&
    !!settings.aiModel.trim();
}

export type AiErrorKind =
  | "not-configured"
  | "network"
  | "parse"
  | "cancelled";

export class AiError extends Error {
  kind: AiErrorKind;

  constructor(kind: AiErrorKind, message: string) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
  }
}

export function aiErrorTip(error: unknown): string {
  if (error instanceof AiError) {
    if (error.kind === "not-configured") {
      return "请先在 设置 → AI 智能 中配置并启用";
    }
    if (error.kind === "parse") return "AI 返回内容无法解析";
    if (error.kind === "cancelled") return "AI 转换已取消";
    // network 携带的具体原因（HTTP 状态/超时等）直接给用户，可定位
    if (error.kind === "network" && error.message && error.message !== "AI 请求失败") {
      return error.message;
    }
  }
  return "AI 请求失败，请检查网络与服务配置";
}

export interface AiClientDescriptor {
  provider: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
  ready: boolean;
}

export type AiConnectionOverride = {
  baseUrl: string;
  model: string;
  /** 设置页测试连接不依赖“启用 AI”开关。 */
  requireEnabled?: boolean;
};

export function describeAiClient(
  override?: AiConnectionOverride,
  settings: Pick<Settings, "aiEnabled" | "aiBaseUrl" | "aiModel"> =
    useNotesStore.getState().settings
): AiClientDescriptor {
  const baseUrl = (override?.baseUrl ?? settings.aiBaseUrl).trim();
  const model = (override?.model ?? settings.aiModel).trim();
  const enabled = override
    ? override.requireEnabled !== true || settings.aiEnabled
    : settings.aiEnabled;
  const presetId = matchPreset(baseUrl);
  const provider = AI_PRESETS.find((preset) => preset.id === presetId)?.label ??
    "自定义";
  return {
    provider,
    model,
    baseUrl,
    enabled,
    ready: enabled && !!baseUrl && !!model,
  };
}

export interface AiRequestInput {
  system: string;
  user: string;
  maxTokens: number;
  connection?: AiConnectionOverride;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AiRequestHandle {
  descriptor: AiClientDescriptor;
  result: Promise<string>;
  /** 只能保证本地结果立即取消；已进入 Native 的网络请求由其自身超时收口。 */
  cancel: () => void;
  /** 底层 invoke 真正结束；转换层用它阻止取消后的同配方并发。 */
  transportSettled: Promise<void>;
}

function cancelledError(): AiError {
  return new AiError("cancelled", "AI 请求已取消");
}

/**
 * 唯一前端 AI transport。密钥始终由 Rust 从 Keychain 读取；这里既不接收也不
 * 返回密钥。取消只切断本地结果，迟到 Native 回执仍由调用者 requestId guard。
 */
export function startAiRequest(input: AiRequestInput): AiRequestHandle {
  const descriptor = describeAiClient(input.connection);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const externalAbort = () => cancel();
  input.signal?.addEventListener("abort", externalAbort, { once: true });
  if (input.signal?.aborted) cancel();

  const transport = Promise.resolve().then(async () => {
    if (controller.signal.aborted) throw cancelledError();
    if (!descriptor.ready) {
      throw new AiError("not-configured", "AI 未配置或未启用");
    }
    try {
      const keyStatus = await api.getAiKeyStatus();
      if (controller.signal.aborted) throw cancelledError();
      if (!keyStatus.configured) {
        throw new AiError("not-configured", "AI API Key 尚未配置");
      }
      const result = await api.aiChat(
        descriptor.baseUrl,
        descriptor.model,
        input.system,
        input.user,
        input.maxTokens
      );
      if (controller.signal.aborted) throw cancelledError();
      return result;
    } catch (error) {
      if (error instanceof AiError) throw error;
      // Rust 侧错误串已是脱敏后的人话（HTTP 状态、URL 校验、密钥未配置等），
      // 必须透传——吞成固定文案会让「换了密钥连不上」这类问题无从定位
      const detail =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "";
      throw new AiError("network", detail || "AI 请求失败");
    }
  });

  const result = new Promise<string>((resolve, reject) => {
    let finished = false;
    const finish = (callback: () => void) => {
      if (finished) return;
      finished = true;
      globalThis.clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(cancelledError()));
    const timer = globalThis.setTimeout(() => {
      finish(() => reject(new AiError("network", "AI 请求超时")));
      controller.abort();
    }, input.timeoutMs ?? 32_000);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    transport.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
  const transportSettled = transport.then(
    () => undefined,
    () => undefined
  ).finally(() => {
    input.signal?.removeEventListener("abort", externalAbort);
  });

  return { descriptor, result, cancel, transportSettled };
}

export async function requestAi(input: AiRequestInput): Promise<string> {
  return startAiRequest(input).result;
}
