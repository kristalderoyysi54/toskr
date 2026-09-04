import {
  AiError,
  aiErrorTip,
  startAiRequest,
  type AiRequestHandle,
} from "@/lib/aiClient";
import {
  evaluateDeliveryDraftFirewall,
  scanOpenDeliveryDraft,
  type ScanSensitiveText,
} from "@/lib/delivery/firewallController";
import { useDeliveryStore } from "@/store/deliveryStore";
import { cleanupDeliveryDraftImages } from "@/lib/delivery/imageFirewall";

export type TransformRecipeId =
  | "summarize"
  | "extract-actions"
  | "improve-prompt"
  | "structure-requirements";

export interface TransformRecipe {
  id: TransformRecipeId;
  label: string;
  description: string;
  systemPrompt: string;
  outputMode: "text" | "json";
  maxTokens: number;
}

export const TRANSFORM_RECIPES: readonly TransformRecipe[] = [
  {
    id: "summarize",
    label: "总结要点",
    description: "压缩为清晰、忠于原文的要点，不补造事实。",
    systemPrompt:
      "请把用户文本总结为简洁 Markdown 要点。忠于原文，不补造事实，不输出解释或代码围栏。",
    outputMode: "text",
    maxTokens: 900,
  },
  {
    id: "extract-actions",
    label: "提取行动项",
    description: "提取可执行事项、负责人和期限；缺失信息明确标注。",
    systemPrompt:
      "从用户文本中提取可执行行动项，用 Markdown 清单输出。不得猜测负责人或期限；缺失时写“未指定”。不要输出额外解释。",
    outputMode: "text",
    maxTokens: 1_000,
  },
  {
    id: "improve-prompt",
    label: "优化 Prompt",
    description: "在不改变意图的前提下补齐目标、约束和输出要求。",
    systemPrompt:
      "把用户文本优化成可直接交给 AI 的高质量 Prompt，保留全部原始约束，不虚构背景。只输出优化后的 Prompt。",
    outputMode: "text",
    maxTokens: 1_200,
  },
  {
    id: "structure-requirements",
    label: "结构化需求",
    description: "整理目标、范围、约束、验收与待确认问题。",
    systemPrompt:
      '把用户需求整理为 JSON 对象，只输出合法 JSON：{"goal":string,"scope":string[],"constraints":string[],"acceptance":string[],"openQuestions":string[]}。不得补造事实。',
    outputMode: "json",
    maxTokens: 1_200,
  },
];

export interface TransformRequest {
  requestId: string;
  draftId: string;
  draftRevision: number;
  recipeId: TransformRecipeId;
  provider: string;
  model: string;
  inputChars: number;
  startedAtMs: number;
}

export interface TransformResult {
  requestId: string;
  draftId: string;
  draftRevision: number;
  recipeId: TransformRecipeId;
  provider: string;
  model: string;
  text: string;
  createdAtMs: number;
}

export type TransformStatus =
  | "idle"
  | "running"
  | "ready"
  | "stale"
  | "applied"
  | "error"
  | "cancelled";

export interface TransformSession {
  status: TransformStatus;
  request: TransformRequest | null;
  result: TransformResult | null;
  error: string | null;
  restoreText: string | null;
  /** 当前 applied 状态对应的最终输出投影；用于区分后续正文改写。 */
  appliedText: string | null;
  transportPending: boolean;
}

export function emptyTransformSession(): TransformSession {
  return {
    status: "idle",
    request: null,
    result: null,
    error: null,
    restoreText: null,
    appliedText: null,
    transportPending: false,
  };
}

export function transformRecipe(
  recipeId: string
): TransformRecipe | null {
  return TRANSFORM_RECIPES.find((recipe) => recipe.id === recipeId) ?? null;
}

export function summarizeTransformChange(before: string, after: string): string {
  const beforeChars = [...before];
  const afterChars = [...after];
  let prefix = 0;
  while (
    prefix < beforeChars.length &&
    prefix < afterChars.length &&
    beforeChars[prefix] === afterChars[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeChars.length - prefix &&
    suffix < afterChars.length - prefix &&
    beforeChars[beforeChars.length - 1 - suffix] ===
      afterChars[afterChars.length - 1 - suffix]
  ) suffix += 1;
  const removed = beforeChars.length - prefix - suffix;
  const added = afterChars.length - prefix - suffix;
  const beforeLines = before ? before.split("\n").length : 0;
  const afterLines = after ? after.split("\n").length : 0;
  return `替换 ${removed} 字符，新增 ${added} 字符 · ${beforeLines}→${afterLines} 行`;
}

function normalizeResult(recipe: TransformRecipe, raw: string): string {
  let text = raw.trim();
  if (!text) throw new AiError("parse", "AI 返回内容为空");
  if (recipe.outputMode === "text") return text;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AiError("parse", "AI 返回内容不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AiError("parse", "AI 返回结构不符合要求");
  }
  return JSON.stringify(parsed, null, 2);
}

type ActiveTransform = {
  key: string;
  requestId: string;
  handle: AiRequestHandle;
};

const activeByKey = new Map<string, ActiveTransform>();
const activeByRequest = new Map<string, ActiveTransform>();
let requestSequence = 0;

type RunOptions = {
  startRequest?: typeof startAiRequest;
  requestId?: () => string;
  now?: () => number;
};

function nextRequestId(): string {
  requestSequence += 1;
  return `transform-${Date.now()}-${requestSequence}`;
}

function releaseActive(active: ActiveTransform): void {
  if (activeByKey.get(active.key) === active) activeByKey.delete(active.key);
  if (activeByRequest.get(active.requestId) === active) {
    activeByRequest.delete(active.requestId);
  }
  useDeliveryStore.getState().settleTransformTransport(active.requestId);
}

export async function runOpenDraftTransform(
  recipeId: string,
  options: RunOptions = {}
): Promise<TransformResult | null> {
  const recipe = transformRecipe(recipeId);
  const state = useDeliveryStore.getState();
  const draft = state.draft;
  if (!recipe || !state.open || !draft || state.busy) return null;

  const firewall = evaluateDeliveryDraftFirewall(draft);
  if (!draft.firewallEnabled || draft.firewallStatus !== "ready" || !firewall.canSend) {
    state.setTransformError("请先完成并处理本地隐私检查，再发送文本给 AI");
    return null;
  }

  const key = `${draft.id}:${recipe.id}`;
  if (state.transform.status === "running" || activeByKey.has(key)) return null;
  const startRequest = options.startRequest ?? startAiRequest;
  const handle = startRequest({
    system: recipe.systemPrompt,
    user: draft.finalText,
    maxTokens: recipe.maxTokens,
  });
  const request: TransformRequest = {
    requestId: (options.requestId ?? nextRequestId)(),
    draftId: draft.id,
    draftRevision: draft.revision,
    recipeId: recipe.id,
    provider: handle.descriptor.provider,
    model: handle.descriptor.model,
    inputChars: draft.finalText.length,
    startedAtMs: (options.now ?? Date.now)(),
  };
  if (!state.beginTransform(request)) {
    handle.cancel();
    void handle.result.catch(() => undefined);
    return null;
  }
  const active = { key, requestId: request.requestId, handle };
  activeByKey.set(key, active);
  activeByRequest.set(request.requestId, active);
  void handle.transportSettled.then(() => releaseActive(active));

  try {
    const text = normalizeResult(recipe, await handle.result);
    const result: TransformResult = {
      requestId: request.requestId,
      draftId: request.draftId,
      draftRevision: request.draftRevision,
      recipeId: request.recipeId,
      provider: request.provider,
      model: request.model,
      text,
      createdAtMs: (options.now ?? Date.now)(),
    };
    useDeliveryStore.getState().finishTransform(result);
    return result;
  } catch (error) {
    const current = useDeliveryStore.getState();
    if (error instanceof AiError && error.kind === "cancelled") {
      current.cancelTransform(request.requestId);
    } else {
      current.failTransform(request.requestId, aiErrorTip(error));
    }
    return null;
  }
}

export function cancelOpenDraftTransform(): void {
  const request = useDeliveryStore.getState().transform.request;
  if (!request) return;
  activeByRequest.get(request.requestId)?.handle.cancel();
  useDeliveryStore.getState().cancelTransform(request.requestId);
}

export function discardOpenDraftTransform(): void {
  useDeliveryStore.getState().discardTransform();
}

export async function applyOpenDraftTransform(
  scan?: ScanSensitiveText
): Promise<boolean> {
  if (!useDeliveryStore.getState().applyTransformResult()) return false;
  await scanOpenDeliveryDraft(scan);
  return true;
}

export async function restoreOpenDraftTransform(
  scan?: ScanSensitiveText
): Promise<boolean> {
  if (!useDeliveryStore.getState().restoreTransformText()) return false;
  await scanOpenDeliveryDraft(scan);
  return true;
}

export function closeOpenDraftWithTransforms(): void {
  cancelOpenDraftTransform();
  const draft = useDeliveryStore.getState().draft;
  useDeliveryStore.getState().closeDraft();
  cleanupDeliveryDraftImages(draft);
}
