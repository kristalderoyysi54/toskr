import { parseAiJson } from "@/lib/ai";
import {
  AiError,
  aiErrorTip,
  startAiRequest,
  type AiRequestHandle,
} from "@/lib/aiClient";
import {
  deliveryEventOutputMode,
  type DeliveryEvent,
} from "@/lib/deliveryActivityCore";
import {
  PLACEHOLDER_NAME_PATTERN,
  PLACEHOLDER_PATTERN,
  replaceFirewallFindings,
} from "@/lib/delivery/firewall";
import { buildTaskMarkdown } from "@/lib/delivery/buildDraft";
import type { ScanSensitiveText } from "@/lib/delivery/firewallController";
import { imageCaption, buildSendText } from "@/lib/format";
import { api } from "@/lib/tauri";
import {
  useNotesStore,
  noteImages,
  type Note,
  type NoteProvenance,
  type NotesState,
  type Task,
} from "@/store/notesStore";

export const RESULT_VERIFICATION_REQUEST_EVENT =
  "toskr:result-verification-request";

export type ResultVerificationRequest =
  | { kind: "open"; noteId: string; returnFocus?: HTMLElement | null }
  | { kind: "close" };

function dispatchVerificationRequest(detail: ResultVerificationRequest): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ResultVerificationRequest>(RESULT_VERIFICATION_REQUEST_EVENT, {
      detail,
    })
  );
}

export function requestResultVerification(
  noteId: string,
  returnFocus?: HTMLElement | null
): void {
  dispatchVerificationRequest({ kind: "open", noteId, returnFocus });
}

export function closeResultVerificationDialog(): void {
  dispatchVerificationRequest({ kind: "close" });
}

export type VerificationStatus = "pass" | "needsReview" | "blocked";

export interface VerificationCheck {
  id: string;
  status: VerificationStatus;
  message: string;
}

export interface VerificationReport {
  status: VerificationStatus;
  checks: VerificationCheck[];
  missing: string[];
  newAssumptions: string[];
  risks: string[];
  questions: string[];
  createdAtMs: number;
  sourceRevision: string;
  resultRevision: string;
}

export type ResultExpectedFormat = "auto" | "text" | "json";

export interface ResultVerificationExpectation {
  format: ResultExpectedFormat;
  requiredJsonFields: string[];
  requiredSections: string[];
  /** null 表示发送会话证据已失效，无法完整核对占位符。 */
  expectedPlaceholderCounts: Readonly<Record<string, number>> | null;
}

type VerificationSource =
  | { id: string; kind: "note"; entity: Note; text: string }
  | { id: string; kind: "task"; entity: Task; text: string };

export interface ResultVerificationContext {
  resultNote: Note;
  sources: VerificationSource[];
  missingSourceIds: string[];
  sourceText: string;
  resultText: string;
  sourceRevision: string;
  resultRevision: string;
  /** 持久词典的占位符集合：会话映射失效后仍可识别词典化名，只对临时占位符降级。 */
  dictionaryPlaceholders?: ReadonlySet<string>;
}

const entityRevisions = new WeakMap<object, number>();
let entityRevisionSequence = 0;

function entityRevision(entity: object): number {
  const current = entityRevisions.get(entity);
  if (current) return current;
  entityRevisionSequence += 1;
  entityRevisions.set(entity, entityRevisionSequence);
  return entityRevisionSequence;
}

function sourceRevisionOf(context: ResultVerificationContext): string {
  const sources = context.sources.map((source) =>
    `${source.kind === "note" ? "n" : "t"}${entityRevision(source.entity)}`
  );
  const missing = context.missingSourceIds.map((_, index) => `m${index}`);
  return `source:${[...sources, ...missing].join(",") || "none"}`;
}

function resultRevisionOf(context: ResultVerificationContext): string {
  return `result:${entityRevision(context.resultNote)}`;
}

function noteSourceText(note: Note): string {
  return note.kind === "image" ? imageCaption(note) : note.text;
}

/**
 * revision 是当前 WebView 会话内的对象版本，不是正文 hash。Zustand 的内容
 * 修改会替换实体对象，因此能检测 stale，又不会把可枚举正文指纹写入磁盘。
 */
export function buildVerificationContext(
  resultNote: Note,
  notes: readonly Note[],
  tasks: readonly Task[],
  aliasEntities: readonly { placeholder: string }[] = []
): ResultVerificationContext {
  const sourceIds = resultNote.provenance?.sourceItemIds ?? [];
  const sources: VerificationSource[] = [];
  const missingSourceIds: string[] = [];
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const id of sourceIds) {
    const note = noteById.get(id);
    if (note) {
      sources.push({ id, kind: "note", entity: note, text: noteSourceText(note) });
      continue;
    }
    const task = taskById.get(id);
    if (task) {
      sources.push({ id, kind: "task", entity: task, text: buildTaskMarkdown(task) });
      continue;
    }
    missingSourceIds.push(id);
  }
  const sourceText = buildSendText(
    sources.map((source) => source.text.trim()).filter(Boolean)
  );
  const context: ResultVerificationContext = {
    resultNote,
    sources,
    missingSourceIds,
    sourceText,
    resultText: resultNote.text,
    sourceRevision: "",
    resultRevision: "",
    dictionaryPlaceholders: new Set(
      aliasEntities.map((entity) => entity.placeholder).filter(Boolean)
    ),
  };
  context.sourceRevision = sourceRevisionOf(context);
  context.resultRevision = resultRevisionOf(context);
  return context;
}

export function isVerificationReportStale(
  report: VerificationReport,
  context: ResultVerificationContext
): boolean {
  return report.sourceRevision !== sourceRevisionOf(context) ||
    report.resultRevision !== resultRevisionOf(context);
}

const STATUS_RANK: Record<VerificationStatus, number> = {
  pass: 0,
  needsReview: 1,
  blocked: 2,
};

function highestStatus(statuses: readonly VerificationStatus[]): VerificationStatus {
  return statuses.reduce((current, status) =>
    STATUS_RANK[status] > STATUS_RANK[current] ? status : current, "pass");
}

function addCheck(
  checks: VerificationCheck[],
  id: string,
  status: VerificationStatus,
  message: string
): void {
  checks.push({ id, status, message });
}

function placeholderCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

function jsonPathExists(root: unknown, path: string): boolean {
  let current = root;
  for (const part of path.split(".").map((item) => item.trim()).filter(Boolean)) {
    if (
      !current || typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, part)
    ) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return current !== undefined && current !== null;
}

function looksTruncated(text: string): boolean {
  const trimmed = text.trim();
  const fences = trimmed.match(/```/g)?.length ?? 0;
  return /(?:…|\.{3}|未完|待续)$/u.test(trimmed) || fences % 2 !== 0;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

export function verifyResultDeterministically(
  context: ResultVerificationContext,
  expectation: ResultVerificationExpectation,
  now = Date.now(),
  baselineSourceRevision?: string
): VerificationReport {
  const checks: VerificationCheck[] = [];
  const missing: string[] = [];
  const newAssumptions: string[] = [];
  const risks: string[] = [];
  const questions: string[] = [];
  const result = context.resultText.trim();

  addCheck(
    checks,
    "result.present",
    result ? "pass" : "blocked",
    result ? "结果正文存在" : "结果为空"
  );
  if (!result) missing.push("结果正文");

  const unusuallyShort = !!result && (
    [...result].length < 24 ||
    ([...context.sourceText].length >= 400 && [...result].length < 80)
  );
  addCheck(
    checks,
    "result.length",
    unusuallyShort ? "needsReview" : "pass",
    unusuallyShort ? "结果相对过短，可能不完整" : "结果长度未见明显异常"
  );
  if (unusuallyShort) risks.push("结果过短，可能遗漏来源内容");

  const truncated = !!result && looksTruncated(result);
  addCheck(
    checks,
    "result.truncation",
    truncated ? "needsReview" : "pass",
    truncated ? "结果结尾或代码围栏疑似异常截断" : "未发现常见截断标记"
  );
  if (truncated) risks.push("结果疑似截断");

  const expectsJson = expectation.format === "json" ||
    (expectation.format === "auto" && /^[{[]/.test(result));
  let parsedJson: unknown = null;
  let jsonValid = !expectsJson;
  if (expectsJson && result) {
    try {
      parsedJson = JSON.parse(result);
      jsonValid = true;
    } catch {
      jsonValid = false;
    }
  }
  addCheck(
    checks,
    "format.json",
    jsonValid ? "pass" : "blocked",
    expectsJson
      ? jsonValid ? "JSON 语法有效" : "结果不是合法 JSON"
      : "本次未要求 JSON"
  );
  if (expectsJson && !jsonValid) missing.push("合法 JSON");

  const requiredJsonFields = uniqueStrings(expectation.requiredJsonFields);
  const missingJsonFields = jsonValid && expectsJson
    ? requiredJsonFields.filter((field) => !jsonPathExists(parsedJson, field))
    : requiredJsonFields;
  addCheck(
    checks,
    "format.json-fields",
    missingJsonFields.length ? "blocked" : "pass",
    missingJsonFields.length
      ? `缺少 JSON 必填字段：${missingJsonFields.join("、")}`
      : requiredJsonFields.length ? "JSON 必填字段齐全" : "未指定 JSON 必填字段"
  );
  missing.push(...missingJsonFields.map((field) => `JSON 字段 ${field}`));

  const requiredSections = uniqueStrings(expectation.requiredSections);
  const normalizedResult = result.toLocaleLowerCase();
  const missingSections = requiredSections.filter(
    (section) => !normalizedResult.includes(section.toLocaleLowerCase())
  );
  addCheck(
    checks,
    "structure.sections",
    missingSections.length ? "blocked" : "pass",
    missingSections.length
      ? `缺少必要标题或段落：${missingSections.join("、")}`
      : requiredSections.length ? "必要标题或段落齐全" : "未指定必要标题或段落"
  );
  missing.push(...missingSections.map((section) => `章节 ${section}`));

  const sourcePlaceholders = placeholderCounts(context.sourceText);
  const resultPlaceholders = placeholderCounts(result);
  const expected = new Map(sourcePlaceholders);
  if (expectation.expectedPlaceholderCounts) {
    for (const [placeholder, count] of Object.entries(expectation.expectedPlaceholderCounts)) {
      if (PLACEHOLDER_NAME_PATTERN.test(placeholder)) {
        expected.set(placeholder, Math.max(expected.get(placeholder) ?? 0, count));
      }
    }
  }
  const missingPlaceholders: string[] = [];
  const duplicatePlaceholders: string[] = [];
  for (const [placeholder, count] of expected) {
    const actual = resultPlaceholders.get(placeholder) ?? 0;
    if (actual < count) missingPlaceholders.push(placeholder);
    if (actual > count) duplicatePlaceholders.push(placeholder);
  }
  const unknownPlaceholders = [...resultPlaceholders.keys()].filter(
    (placeholder) => !expected.has(placeholder)
  );
  const mappingExpired = expectation.expectedPlaceholderCounts === null;
  // 会话清单失效后仍可用持久词典识别化名占位符，只对临时占位符降级
  const dictionary = context.dictionaryPlaceholders ?? new Set<string>();
  const dictionaryKnown = mappingExpired
    ? [...resultPlaceholders.keys()].filter((item) => dictionary.has(item))
    : [];
  const temporaryUnknown = mappingExpired
    ? [...resultPlaceholders.keys()].filter((item) => !dictionary.has(item))
    : [];
  const expiredMessage = resultPlaceholders.size === 0
    ? "应用重启过或该次发送较久，临时占位符清单已清理；无法确认是否有占位符丢失"
    : temporaryUnknown.length
      ? `词典化名 ${dictionaryKnown.length} 处可识别；${temporaryUnknown.length} 处临时占位符无法核对（应用重启过或该次发送较久）`
      : `词典化名 ${dictionaryKnown.length} 处均可识别、可恢复；数量核对不可用（应用重启过或该次发送较久）`;
  const placeholderProblem = mappingExpired || missingPlaceholders.length ||
    duplicatePlaceholders.length || unknownPlaceholders.length;
  addCheck(
    checks,
    "privacy.placeholders",
    placeholderProblem ? "needsReview" : "pass",
    mappingExpired
      ? expiredMessage
      : placeholderProblem
        ? "占位符存在丢失、重复或未知项"
        : "占位符数量与已知发送会话一致"
  );
  missing.push(...missingPlaceholders.map((placeholder) => `占位符 ${placeholder}`));
  if (duplicatePlaceholders.length) {
    risks.push(`占位符重复：${duplicatePlaceholders.join("、")}`);
  }
  if (mappingExpired) {
    risks.push(
      "应用重启过或该次发送较久，临时占位符清单已清理，数量核对不可用；如需严格核对请人工比对"
    );
    if (temporaryUnknown.length) {
      risks.push(`临时占位符 ${temporaryUnknown.join("、")} 无法判断是否来自本次发送`);
    }
  } else {
    newAssumptions.push(
      ...unknownPlaceholders.map((placeholder) => `未知占位符 ${placeholder}`)
    );
  }

  const sourceMissing = context.missingSourceIds.length > 0 || !context.sources.length;
  addCheck(
    checks,
    "source.references",
    sourceMissing ? "blocked" : "pass",
    sourceMissing
      ? `来源引用缺失 ${context.missingSourceIds.length || 1} 项`
      : `当前来源 ${context.sources.length} 项均存在`
  );
  missing.push(...context.missingSourceIds.map((id) => `来源 ${id}`));
  if (!context.sources.length && !context.missingSourceIds.length) missing.push("来源关联");

  const sourceTextMissing = context.sources.length > 0 && !context.sourceText.trim();
  addCheck(
    checks,
    "source.content",
    sourceTextMissing ? "blocked" : "pass",
    sourceTextMissing ? "当前来源没有可核验文本" : "当前来源包含可核验文本"
  );
  if (sourceTextMissing) missing.push("来源文本");

  const sourceChanged = !!baselineSourceRevision &&
    baselineSourceRevision !== sourceRevisionOf(context);
  addCheck(
    checks,
    "source.stability",
    sourceChanged ? "blocked" : "pass",
    sourceChanged ? "来源在本次核验期间发生变化" : "来源自本次核验开始未变化"
  );
  if (sourceChanged) risks.push("来源版本已变化，请重新打开核验");

  const sourceImageCount = context.sources.reduce((count, source) =>
    count + (source.kind === "note" ? noteImages(source.entity).length : 0), 0);
  const resultImageCount = noteImages(context.resultNote).length;
  const hasImagesOutsideScope = sourceImageCount + resultImageCount > 0;
  addCheck(
    checks,
    "scope.images",
    hasImagesOutsideScope ? "needsReview" : "pass",
    hasImagesOutsideScope
      ? `图片附件不在本阶段文本核验范围（来源 ${sourceImageCount}，结果 ${resultImageCount}）`
      : "本次没有超出文本核验范围的图片附件"
  );
  if (hasImagesOutsideScope) risks.push("图片附件内容需人工核对");

  if (missing.length) questions.push("是否补齐所有明确缺失项后重新核验？");
  const status = highestStatus(checks.map((check) => check.status));
  return {
    status,
    checks,
    missing: uniqueStrings(missing),
    newAssumptions: uniqueStrings(newAssumptions),
    risks: uniqueStrings(risks),
    questions: uniqueStrings(questions),
    createdAtMs: now,
    sourceRevision: sourceRevisionOf(context),
    resultRevision: resultRevisionOf(context),
  };
}

export type PreparedVerificationAiInput =
  | {
      status: "ready";
      sourceText: string;
      resultText: string;
      sourceChars: number;
      resultChars: number;
      findingCount: number;
      replacedCount: number;
      sourceRevision: string;
      resultRevision: string;
    }
  | { status: "blocked"; reason: string };

function scanIsComplete(text: string, result: Awaited<ReturnType<ScanSensitiveText>>): boolean {
  return result.complete &&
    result.inputUtf16 === text.length &&
    result.scannedUtf16 === text.length;
}

/** 本地扫描并自动替换全部 finding；raw map 只活在本函数栈内。 */
export async function prepareVerificationAiInput(
  context: ResultVerificationContext,
  scan: ScanSensitiveText = api.scanSensitiveText
): Promise<PreparedVerificationAiInput> {
  if (!context.sourceText.trim() || !context.resultText.trim() || context.missingSourceIds.length) {
    return { status: "blocked", reason: "来源或结果不完整，不能调用 AI 核验" };
  }
  try {
    const [sourceScan, resultScan] = await Promise.all([
      scan(context.sourceText),
      scan(context.resultText),
    ]);
    if (
      !scanIsComplete(context.sourceText, sourceScan) ||
      !scanIsComplete(context.resultText, resultScan)
    ) {
      return { status: "blocked", reason: "本地隐私检查未完整执行" };
    }
    const source = replaceFirewallFindings(context.sourceText, sourceScan.findings, {});
    const result = replaceFirewallFindings(
      context.resultText,
      resultScan.findings,
      source.redactionMap
    );
    return {
      status: "ready",
      sourceText: source.text,
      resultText: result.text,
      sourceChars: context.sourceText.length,
      resultChars: context.resultText.length,
      findingCount: sourceScan.findings.length + resultScan.findings.length,
      replacedCount:
        source.replacedFindingIds.length + result.replacedFindingIds.length,
      sourceRevision: sourceRevisionOf(context),
      resultRevision: resultRevisionOf(context),
    };
  } catch {
    return { status: "blocked", reason: "本地隐私检查失败" };
  }
}

export interface AiVerificationPayload {
  status: VerificationStatus;
  checks: VerificationCheck[];
  missing: string[];
  newAssumptions: string[];
  risks: string[];
  questions: string[];
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length &&
    [...keys].sort().every((key, index) => key === actual[index]);
}

function boundedString(value: unknown, max = 600): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}

function boundedStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 50 &&
    value.every((item) => boundedString(item));
}

export function isAiVerificationPayload(value: unknown): value is AiVerificationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = ["status", "checks", "missing", "newAssumptions", "risks", "questions"];
  if (!hasExactKeys(payload, keys) ||
    !["pass", "needsReview", "blocked"].includes(String(payload.status)) ||
    !boundedStrings(payload.missing) ||
    !boundedStrings(payload.newAssumptions) ||
    !boundedStrings(payload.risks) ||
    !boundedStrings(payload.questions) ||
    !Array.isArray(payload.checks) || payload.checks.length > 50) return false;
  return payload.checks.every((check) => {
    if (!check || typeof check !== "object" || Array.isArray(check)) return false;
    const record = check as Record<string, unknown>;
    return hasExactKeys(record, ["id", "status", "message"]) &&
      boundedString(record.id, 80) &&
      ["pass", "needsReview", "blocked"].includes(String(record.status)) &&
      boundedString(record.message);
  });
}

type VerificationAiRequest = {
  resultNoteId: string;
  expectation: ResultVerificationExpectation;
  localReport: VerificationReport;
  prepared: Extract<PreparedVerificationAiInput, { status: "ready" }>;
};

export type AiVerificationOutcome =
  | { status: "ready"; report: VerificationReport; provider: string; model: string }
  | { status: "cancelled" | "duplicate" }
  | { status: "error"; error: string };

type ActiveVerification = {
  requestId: string;
  handle: AiRequestHandle;
  cancelled: boolean;
};

const activeVerification = new Map<string, ActiveVerification>();
let verificationRequestSequence = 0;

function nextVerificationRequestId(): string {
  verificationRequestSequence += 1;
  return `verify-${Date.now()}-${verificationRequestSequence}`;
}

function mergeVerificationReports(
  local: VerificationReport,
  ai: AiVerificationPayload,
  createdAtMs: number,
  sourceRevision: string,
  resultRevision: string
): VerificationReport {
  const checks = [
    ...local.checks,
    ...ai.checks.map((check) => ({ ...check, id: `ai.${check.id}` })),
  ];
  const missing = uniqueStrings([...local.missing, ...ai.missing]);
  const newAssumptions = uniqueStrings([...local.newAssumptions, ...ai.newAssumptions]);
  const risks = uniqueStrings([...local.risks, ...ai.risks]);
  const questions = uniqueStrings([...local.questions, ...ai.questions]);
  let status = highestStatus([local.status, ai.status, ...checks.map((check) => check.status)]);
  if (missing.length) status = "blocked";
  else if (status === "pass" && (newAssumptions.length || risks.length || questions.length)) {
    status = "needsReview";
  }
  return {
    status,
    checks,
    missing,
    newAssumptions,
    risks,
    questions,
    createdAtMs,
    sourceRevision,
    resultRevision,
  };
}

const VERIFICATION_SYSTEM = `你是结果核验助手。只比较提供的“当前来源”和“当前结果”，不得补造事实，不得宣称已发现全部错误，也不得替代人工审批。
只输出 JSON，不要 Markdown 或解释。严格 schema：
{"status":"pass|needsReview|blocked","checks":[{"id":string,"status":"pass|needsReview|blocked","message":string}],"missing":string[],"newAssumptions":string[],"risks":string[],"questions":string[]}`;

export async function runAiResultVerification(
  input: VerificationAiRequest,
  options: {
    startRequest?: typeof startAiRequest;
    requestId?: () => string;
    now?: () => number;
  } = {}
): Promise<AiVerificationOutcome> {
  if (activeVerification.size > 0) return { status: "duplicate" };
  const requestId = (options.requestId ?? nextVerificationRequestId)();
  const handle = (options.startRequest ?? startAiRequest)({
    system: VERIFICATION_SYSTEM,
    user: JSON.stringify({
      schemaVersion: 1,
      expectation: {
        format: input.expectation.format,
        requiredJsonFields: uniqueStrings(input.expectation.requiredJsonFields),
        requiredSections: uniqueStrings(input.expectation.requiredSections),
      },
      localChecks: input.localReport.checks,
      source: input.prepared.sourceText,
      result: input.prepared.resultText,
    }),
    maxTokens: 1_800,
  });
  const active: ActiveVerification = { requestId, handle, cancelled: false };
  activeVerification.set(input.resultNoteId, active);
  void handle.transportSettled.finally(() => {
    if (activeVerification.get(input.resultNoteId) === active) {
      activeVerification.delete(input.resultNoteId);
    }
  });
  try {
    const raw = await handle.result;
    if (active.cancelled) return { status: "cancelled" };
    const parsed = parseAiJson(raw, isAiVerificationPayload);
    return {
      status: "ready",
      report: mergeVerificationReports(
        input.localReport,
        parsed,
        (options.now ?? Date.now)(),
        input.prepared.sourceRevision,
        input.prepared.resultRevision
      ),
      provider: handle.descriptor.provider,
      model: handle.descriptor.model,
    };
  } catch (error) {
    if (active.cancelled || (error instanceof AiError && error.kind === "cancelled")) {
      return { status: "cancelled" };
    }
    return { status: "error", error: aiErrorTip(error) };
  }
}

export function cancelAiResultVerification(resultNoteId: string): void {
  const active = activeVerification.get(resultNoteId);
  if (!active) return;
  active.cancelled = true;
  active.handle.cancel();
}

export function resultVerificationTransportPending(resultNoteId: string): boolean {
  return activeVerification.has(resultNoteId);
}

export async function awaitResultVerificationTransport(resultNoteId: string): Promise<void> {
  await activeVerification.get(resultNoteId)?.handle.transportSettled;
}

export function verificationIssueCount(report: VerificationReport): number {
  return report.checks.filter((check) => check.status !== "pass").length +
    report.missing.length + report.newAssumptions.length +
    report.risks.length + report.questions.length;
}

function nextActivityEventId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `verified-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 正向构造活动白名单，未来给 DeliveryEvent 加正文也不会被对象展开带入 IPC。 */
export function resultVerifiedEvent(
  delivery: DeliveryEvent,
  resultNoteId: string,
  report: VerificationReport,
  timestampMs = Date.now()
): DeliveryEvent {
  return {
    eventId: nextActivityEventId(),
    deliveryId: delivery.deliveryId,
    eventType: "resultVerified",
    timestampMs,
    sourceKind: delivery.sourceKind,
    sourceItemIds: [...delivery.sourceItemIds],
    targetBundleId: delivery.targetBundleId,
    targetAppName: delivery.targetAppName,
    profileId: delivery.profileId,
    status: "verified",
    reasonCode: null,
    durationMs: null,
    textCharCount: delivery.textCharCount,
    imageCount: delivery.imageCount,
    firewallCounts: { ...delivery.firewallCounts },
    redactionCount: delivery.redactionCount,
    clipboardOutcome: null,
    resultNoteId,
    metricsEligible: delivery.metricsEligible !== false,
    metricsEpoch: delivery.metricsEpoch ?? 0,
    transformRecipeId: delivery.transformRecipeId ?? null,
    ...(deliveryEventOutputMode(delivery)
      ? { format: delivery.format, markdownMode: delivery.markdownMode }
      : {}),
    verificationStatus: report.status,
    verificationCheckCount: report.checks.length,
    verificationIssueCount: verificationIssueCount(report),
  };
}

const REPORT_STATUS_LABEL: Record<VerificationStatus, string> = {
  pass: "规则内未发现问题",
  needsReview: "需要人工复核",
  blocked: "存在明确缺失或阻断",
};

function reportLines(title: string, values: readonly string[]): string[] {
  return values.length ? [`## ${title}`, ...values.map((item) => `- ${item}`), ""] : [];
}

export function formatVerificationReport(report: VerificationReport): string {
  return [
    "# 结果核验报告",
    "",
    `状态：${REPORT_STATUS_LABEL[report.status]}`,
    `生成时间：${new Date(report.createdAtMs).toLocaleString("zh-CN", { hour12: false })}`,
    "说明：核验只呈现规则内证据与问题，不代表结果完全正确，也不替代人工审批。",
    "",
    "## 检查",
    ...report.checks.map((check) => `- [${check.status}] ${check.message}`),
    "",
    ...reportLines("明确缺失", report.missing),
    ...reportLines("新增假设", report.newAssumptions),
    ...reportLines("风险", report.risks),
    ...reportLines("待确认问题", report.questions),
  ].join("\n").trim();
}

type CreateVerificationNoteResult =
  | { ok: true; noteId: string; created: boolean }
  | { ok: false; reason: "stale" | "missing" | "empty" | "duplicate" };

function liveVerificationContext(context: ResultVerificationContext): ResultVerificationContext | null {
  const state = useNotesStore.getState();
  const result = state.notes.find((note) => note.id === context.resultNote.id);
  return result?.provenance
    ? buildVerificationContext(
        result,
        state.notes,
        state.tasks,
        state.settings.aliasEntities
      )
    : null;
}

function createAssociatedNote(
  text: string,
  title: string,
  provenance: NoteProvenance,
  state: NotesState
): CreateVerificationNoteResult {
  const added = state.addNote(text);
  if (added.result === "empty" || !added.id) return { ok: false, reason: "empty" };
  if (added.result === "duplicate") {
    const existing = useNotesStore.getState().notes.find((note) => note.id === added.id);
    return existing?.provenance?.deliveryId === provenance.deliveryId
      ? { ok: true, noteId: added.id, created: false }
      : { ok: false, reason: "duplicate" };
  }
  const created = useNotesStore.getState().notes.find((note) => note.id === added.id);
  if (!created) return { ok: false, reason: "missing" };
  useNotesStore.getState().setNoteProvenance(added.id, {
    ...provenance,
    capturedAtMs: created.createdAt,
    sourceItemIds: [...provenance.sourceItemIds],
  });
  useNotesStore.getState().updateNoteTitle(added.id, title);
  return { ok: true, noteId: added.id, created: true };
}

export function saveVerificationReportAsNote(
  report: VerificationReport,
  context: ResultVerificationContext
): CreateVerificationNoteResult {
  const live = liveVerificationContext(context);
  if (!live || !live.resultNote.provenance) return { ok: false, reason: "missing" };
  if (isVerificationReportStale(report, live)) return { ok: false, reason: "stale" };
  return createAssociatedNote(
    formatVerificationReport(report),
    "结果核验报告",
    live.resultNote.provenance,
    useNotesStore.getState()
  );
}

function verificationQuestionsText(report: VerificationReport): string {
  const items = uniqueStrings([
    ...report.questions,
    ...report.missing.map((item) => `请补齐：${item}`),
    ...report.risks.map((item) => `请核对风险：${item}`),
  ]);
  if (!items.length) return "";
  return [
    "# 结果核验待确认问题",
    "",
    "请基于下列问题给出证据充分、逐项对应的答复；不知道时明确说明，不要猜测：",
    "",
    ...items.map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");
}

export function createVerificationQuestionsNote(
  report: VerificationReport,
  context: ResultVerificationContext
): CreateVerificationNoteResult {
  const live = liveVerificationContext(context);
  if (!live || !live.resultNote.provenance) return { ok: false, reason: "missing" };
  if (isVerificationReportStale(report, live)) return { ok: false, reason: "stale" };
  const text = verificationQuestionsText(report);
  if (!text) return { ok: false, reason: "empty" };
  return createAssociatedNote(
    text,
    "结果核验待确认问题",
    live.resultNote.provenance,
    useNotesStore.getState()
  );
}
