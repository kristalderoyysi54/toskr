import { currentDataGeneration } from "@/lib/dataGeneration";
import { currentDraftSegments } from "./orderedSegments";
import type { DeliveryDraft } from "./types";

/** 只持久化不含正文/正文指纹的执行清单。随机版本号不由内容生成。 */
export interface ExecutionManifest {
  version: string;
  templateId: string | null;
  parts: Array<"text" | "image">;
}
interface SessionBaseline {
  deliveryId: string;
  generation: number;
  expiresAt: number;
  text: string;
  imageCount: number;
}
const baselines = new Map<string, SessionBaseline>();
const TTL = 30 * 60 * 1000;
const MAX_CHARS = 2 * 1024 * 1024;
function prune(now: number): void {
  const generation = currentDataGeneration();
  for (const [key, value] of baselines) {
    if (value.expiresAt <= now || value.generation !== generation) baselines.delete(key);
  }
}

/** 在原生调用之前同步截取；不会把重建的来源误当成实际执行正文。 */
export function captureExecutionManifest(draft: DeliveryDraft, now = Date.now()): ExecutionManifest {
  prune(now);
  const version = crypto.randomUUID();
  const parts = currentDraftSegments(draft)?.map((segment) => segment.kind)
    ?? [...(draft.finalText ? ["text" as const] : []), ...draft.imageFiles.map(() => "image" as const)];
  if (draft.finalText.length <= MAX_CHARS) {
    baselines.set(version, {
      deliveryId: draft.id, generation: currentDataGeneration(), expiresAt: now + TTL,
      text: draft.finalText, imageCount: draft.imageFiles.length,
    });
    setTimeout(() => baselines.delete(version), TTL);
  }
  let chars = [...baselines.values()].reduce((n, value) => n + value.text.length, 0);
  while (baselines.size > 32 || chars > MAX_CHARS) {
    const key = baselines.keys().next().value;
    if (!key) break;
    chars -= baselines.get(key)!.text.length;
    baselines.delete(key);
  }
  return { version, templateId: draft.promptSnippetId, parts };
}

export function executionBaseline(deliveryId: string, version?: string, now = Date.now()): Readonly<SessionBaseline> | null {
  prune(now);
  const baseline = version ? baselines.get(version) : undefined;
  return baseline?.deliveryId === deliveryId ? baseline : null;
}
