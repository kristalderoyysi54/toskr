/** 消息来源的中性标识（不绑定任何具体 IM 品牌）；旧值 "tuitui" 由持久化迁移转来。 */
export const MESSAGE_SOURCE = "im" as const;

export type MessageStatus = "new" | "waiting" | "done" | "archived";

export interface MessageContextItem {
  messageId: string;
  senderUid: string;
  senderName: string | null;
  occurredAtMs: number | null;
  messageType: string | null;
  text: string;
}

/**
 * 同一维度内是 OR，不同非空维度间是 AND。空规则永不命中，避免误收整群。
 * 例：群=[项目群] + 人=[小王,小李] + 词=[发布,回滚]。
 */
export interface MessageWatchRule {
  id: string;
  name: string;
  enabled: boolean;
  groupTerms: string[];
  senderTerms: string[];
  keywords: string[];
}

export interface MessageSourceRef {
  kind: "message";
  source: typeof MESSAGE_SOURCE;
  conversationId: string;
  conversationName: string | null;
  messageId: string;
  senderUid: string;
  senderName: string | null;
}

export interface MessageItem {
  id: string;
  source: typeof MESSAGE_SOURCE;
  /** 来源 IM 的显示名 / bundle：捕获时由用户指定的 profile 注入，历史数据保留原值。 */
  sourceApp?: string;
  sourceBundle?: string;
  conversationId: string;
  messageId: string;
  conversationName: string | null;
  senderUid: string;
  senderName: string | null;
  occurredAtMs: number | null;
  receivedAtMs: number;
  mentionedSelf: boolean;
  followedSender: boolean;
  matchedRuleIds: string[];
  isGroup: boolean | null;
  messageType: string | null;
  text: string;
  /** 捕获时已在客户端内存里的前文；读取它不会打开或切换会话。 */
  context: MessageContextItem[];
  status: MessageStatus;
  linkedTaskId?: string;
  aiDraft?: string;
  aiDraftAtMs?: number;
}

export interface MessageCaptureLike {
  sourceApp?: string;
  sourceBundle?: string;
  conversationId: string;
  messageId: string;
  conversationName: string | null;
  senderUid: string;
  senderName: string | null;
  occurredAtMs: number | null;
  receivedAtMs: number;
  mentionedSelf: boolean;
  followedSender: boolean;
  matchedRuleIds?: string[];
  isGroup: boolean | null;
  messageType: string | null;
  text: string;
  context?: MessageContextItem[];
}

const RULE_MAX = 50;
const TERM_MAX = 20;
const TERM_CHARS = 80;
const CONTEXT_MAX = 8;

function clipped(value: unknown, max = TERM_CHARS): string {
  return typeof value === "string"
    ? [...value.replace(/[\r\n\t]+/g, " ").trim()].slice(0, max).join("")
    : "";
}

function terms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const term = clipped(item);
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= TERM_MAX) break;
  }
  return out;
}

export function normalizeMessageWatchRules(value: unknown): MessageWatchRule[] {
  if (!Array.isArray(value)) return [];
  const out: MessageWatchRule[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length && out.length < RULE_MAX; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const id = clipped(record.id, 128) || `message-rule-${index + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const rule: MessageWatchRule = {
      id,
      name: clipped(record.name, 40) || `关注规则 ${out.length + 1}`,
      enabled: record.enabled !== false,
      groupTerms: terms(record.groupTerms),
      senderTerms: terms(record.senderTerms),
      keywords: terms(record.keywords),
    };
    if (rule.groupTerms.length || rule.senderTerms.length || rule.keywords.length) {
      out.push(rule);
    }
  }
  return out;
}

function includesAny(haystacks: Array<string | null | undefined>, needles: string[]): boolean {
  if (!needles.length) return true;
  const value = haystacks.filter(Boolean).join("\n").toLocaleLowerCase();
  return needles.some((needle) => value.includes(needle.toLocaleLowerCase()));
}

export function matchingMessageRuleIds(
  capture: Pick<
    MessageCaptureLike,
    "conversationId" | "conversationName" | "senderUid" | "senderName" | "text"
  >,
  rules: readonly MessageWatchRule[]
): string[] {
  return rules
    .filter(
      (rule) =>
        rule.enabled &&
        (rule.groupTerms.length || rule.senderTerms.length || rule.keywords.length) &&
        includesAny([capture.conversationId, capture.conversationName], rule.groupTerms) &&
        includesAny([capture.senderUid, capture.senderName], rule.senderTerms) &&
        includesAny([capture.text], rule.keywords)
    )
    .map((rule) => rule.id);
}

export function messageSourceKey(
  source: string,
  conversationId: string,
  messageId: string
): string {
  return JSON.stringify([source, conversationId, messageId]);
}

export function normalizeMessageContext(value: unknown): MessageContextItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: MessageContextItem[] = [];
  for (const raw of value.slice(-CONTEXT_MAX)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const messageId = clipped(record.messageId, 512);
    if (!messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    out.push({
      messageId,
      senderUid: clipped(record.senderUid, 512),
      senderName: clipped(record.senderName, 1024) || null,
      occurredAtMs:
        typeof record.occurredAtMs === "number" && Number.isFinite(record.occurredAtMs)
          ? Math.max(0, record.occurredAtMs)
          : null,
      messageType: clipped(record.messageType, 128) || null,
      // 正文只去掉 NUL，不截断；完整性优先，显示层再折叠。
      text: typeof record.text === "string" ? record.text.replaceAll("\0", "") : "",
    });
  }
  return out;
}

export function messageItemFromCapture(capture: MessageCaptureLike): MessageItem {
  return {
    id: messageSourceKey(MESSAGE_SOURCE, capture.conversationId, capture.messageId),
    source: MESSAGE_SOURCE,
    sourceApp: capture.sourceApp,
    sourceBundle: capture.sourceBundle,
    conversationId: capture.conversationId,
    messageId: capture.messageId,
    conversationName: capture.conversationName,
    senderUid: capture.senderUid,
    senderName: capture.senderName,
    occurredAtMs: capture.occurredAtMs,
    receivedAtMs: capture.receivedAtMs,
    mentionedSelf: capture.mentionedSelf,
    followedSender: capture.followedSender,
    matchedRuleIds: [...new Set(capture.matchedRuleIds ?? [])],
    isGroup: capture.isGroup,
    messageType: capture.messageType,
    // 与 context 同理：结构化投影保留完整正文，UI 负责折叠。
    text: capture.text.replaceAll("\0", ""),
    context: normalizeMessageContext(capture.context),
    status: "new",
  };
}

export function mergeMessageCapture(
  current: MessageItem | undefined,
  capture: MessageCaptureLike
): MessageItem {
  const incoming = messageItemFromCapture(capture);
  if (!current) return incoming;
  return {
    ...incoming,
    // 工作流字段属于 Toskr，不允许重放 JSONL 时覆盖。
    status: current.status,
    linkedTaskId: current.linkedTaskId,
    aiDraft: current.aiDraft,
    aiDraftAtMs: current.aiDraftAtMs,
    // 监听后续拿到更完整投影时采用更丰富版本。
    conversationName: incoming.conversationName ?? current.conversationName,
    senderName: incoming.senderName ?? current.senderName,
    occurredAtMs: incoming.occurredAtMs ?? current.occurredAtMs,
    text: incoming.text || current.text,
    context: incoming.context.length >= current.context.length ? incoming.context : current.context,
    matchedRuleIds: [...new Set([...current.matchedRuleIds, ...incoming.matchedRuleIds])],
  };
}

export function messageSourceRef(message: MessageItem): MessageSourceRef {
  return {
    kind: "message",
    source: MESSAGE_SOURCE,
    conversationId: message.conversationId,
    conversationName: message.conversationName,
    messageId: message.messageId,
    senderUid: message.senderUid,
    senderName: message.senderName,
  };
}

export function messageTaskTitle(message: MessageItem): string {
  const group = message.conversationName?.trim() || "群消息";
  const body = message.text.trim().replace(/\s+/g, " ");
  return body ? `[${group}] ${[...body].slice(0, 80).join("")}` : `[${group}] 处理消息`;
}

export function messageTaskNote(message: MessageItem): string {
  const sender = message.senderName || message.senderUid || "未知发送者";
  const stamp = new Date(message.occurredAtMs ?? message.receivedAtMs).toLocaleString("zh-CN", {
    hour12: false,
  });
  return [
    `来源：${message.sourceApp || "IM"} · ${message.conversationName || message.conversationId}`,
    `发送者：${sender}`,
    `时间：${stamp}`,
    `消息标识：${message.messageId}`,
    "",
    message.text || `[${message.messageType || "非文本消息"}]`,
  ].join("\n");
}
