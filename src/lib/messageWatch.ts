import type {
  MessageWatchBridgeInfo,
  MessageWatchCapture,
} from "@/lib/tauri";
import {
  normalizeMessageWatchRules,
  type MessageWatchRule,
} from "@/lib/messages";

function cleanLabel(value: string | null | undefined, fallback: string): string {
  const clean = value?.replace(/[\r\n\t]+/g, " ").trim();
  return clean || fallback;
}

/** 普通笔记只承载可读摘要；不做截断的 raw 对象以 JSONL 账本为权威。 */
export function formatMessageWatchNote(message: MessageWatchCapture): string {
  const group = cleanLabel(message.conversationName, "未知群组");
  const sender = cleanLabel(
    message.senderName,
    message.senderUid ? `用户 ${message.senderUid}` : "未知发送者"
  );
  const reason = [
    message.mentionedSelf ? "@我" : "",
    message.followedSender ? "特别关注" : "",
    message.matchedRuleIds.length ? "组合规则" : "",
  ]
    .filter(Boolean)
    .join(" + ");
  const body = message.text.trim() || `[${message.messageType || "非文本消息"}]`;
  const occurredAt = message.occurredAtMs ?? message.receivedAtMs;
  const stamp = new Date(occurredAt).toLocaleString("zh-CN", { hour12: false });
  return `【${group}】\n${sender} · ${reason} · ${stamp}\n${body}\n\n消息标识：${message.messageId}`;
}

/**
 * 复制给目标 IM 的 DevTools Console 的临时桥。它只读 window.__ccImStore__ /
 * window.__ccMainStore__，不切会话、不改 readUids、不调用发送接口。
 */
export type MessageWatchTransport = "http" | "cdp";

export function buildMessageWatchBridgeScript(
  info: MessageWatchBridgeInfo,
  transport: MessageWatchTransport = "http",
  rules: readonly MessageWatchRule[] = []
): string {
  const endpoint = JSON.stringify(info.endpoint);
  const startedAt = Math.max(0, Math.trunc(info.sessionStartedAtMs));
  const normalizedRules = JSON.stringify(normalizeMessageWatchRules(rules));
  return `(() => {
  "use strict";
  const TRANSPORT = ${JSON.stringify(transport)};
  const ENDPOINT = ${endpoint};
  const STARTED_AT = ${startedAt};
  const RULES = ${normalizedRules};
  const VERSION = 1;
  const prior = window.__toskrMessageWatchV1;
  if (prior && typeof prior.stop === "function") prior.stop();

  const ignored = new Set();
  const queued = new Set();
  const delivered = new Set();
  const pending = [];
  const restorers = [];
  let stopped = false;
  let draining = false;
  let drainScheduled = false;
  let initialScan = true;
  let scanTimer = 0;
  let healthTimer = 0;
  let healthFailures = 0;

  const first = (...values) => values.find((value) => value !== undefined && value !== null);
  const stateOf = (store) => {
    if (!store) return {};
    try {
      if (typeof store.getState === "function") return store.getState() || {};
    } catch (_) {}
    return store.state || store;
  };
  const entriesOf = (value) => {
    if (!value) return [];
    try {
      if (value instanceof Map || typeof value.entries === "function") return Array.from(value.entries());
    } catch (_) {}
    if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
    if (typeof value === "object") return Object.entries(value);
    return [];
  };
  const listOf = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      if (typeof value.values === "function") return Array.from(value.values());
    } catch (_) {}
    return Array.isArray(value.list) ? value.list : Array.isArray(value.items) ? value.items : [];
  };
  const valueAt = (collection, key) => {
    if (!collection || !key) return undefined;
    try {
      if (typeof collection.get === "function") return collection.get(key) ?? collection.get(String(key));
    } catch (_) {}
    return collection[key] ?? collection[String(key)];
  };
  const parseJson = (value) => {
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (!text || (text[0] !== "{" && text[0] !== "[")) return value;
    try { return JSON.parse(text); } catch (_) { return value; }
  };
  const flag = (value) => value === true || value === 1 || value === "1" || value === "true";
  const asId = (value) => value === undefined || value === null ? "" : String(value);
  const timeMs = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return number < 100000000000 ? Math.trunc(number * 1000) : Math.trunc(number);
  };
  const toPlain = (value, seen = new WeakSet(), depth = 0) => {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return String(value);
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (depth > 64) return "[MaxDepth]";
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Map) {
        const output = {};
        for (const [key, item] of value.entries()) output[String(key)] = toPlain(item, seen, depth + 1);
        return output;
      }
      if (value instanceof Set) return Array.from(value, (item) => toPlain(item, seen, depth + 1));
      if (Array.isArray(value)) return value.map((item) => toPlain(item, seen, depth + 1));
      const output = {};
      for (const key of Object.keys(value)) {
        try {
          const item = toPlain(value[key], seen, depth + 1);
          if (item !== undefined) output[key] = item;
        } catch (_) {}
      }
      return output;
    } finally {
      seen.delete(value);
    }
  };
  const snapshot = (value) => {
    try {
      const serialized = JSON.stringify(value, (_key, item) => {
        if (typeof item === "bigint") return String(item);
        if (item instanceof Map) return Object.fromEntries(item.entries());
        if (item instanceof Set) return Array.from(item.values());
        return item;
      });
      if (serialized !== undefined) return JSON.parse(serialized);
    } catch (_) {}
    return toPlain(value);
  };
  const findText = (value, depth = 0) => {
    if (value === null || value === undefined || depth > 10) return [];
    if (typeof value === "string") return value.trim() ? [value] : [];
    if (typeof value !== "object") return [];
    if (Array.isArray(value)) return value.flatMap((item) => findText(item, depth + 1));
    const preferred = ["text", "content", "title", "desc", "description", "val", "v", "file_name", "fileName", "name", "n"];
    const selected = preferred.flatMap((key) => key in value ? findText(value[key], depth + 1) : []);
    if (selected.length) return selected;
    const blocks = first(value.dt, value.blocks, value.items);
    return blocks ? findText(blocks, depth + 1) : [];
  };
  const messageKey = (value, fallback) => asId(first(
    value && value.msg_id, value && value.msgId, value && value.message_id,
    value && value.messageId, value && value.svr_msg_id, value && value.serverId,
    value && value.cli_msg_id, value && value.clientId, value && value.client_msg_id,
    value && value.id, fallback
  ));
  const conversationIndex = (messageState) => {
    const index = new Map();
    for (const [conversationId, rawList] of entriesOf(messageState && messageState.messageList)) {
      for (const ref of listOf(rawList)) {
        const key = messageKey(ref, typeof ref === "string" || typeof ref === "number" ? ref : "");
        if (key) index.set(key, String(conversationId));
      }
    }
    return index;
  };
  const followUids = (main) => {
    const users = first(main && main.msgTrain && main.msgTrain.followUsers, main && main.followUsers, []);
    return new Set(listOf(users).map((user) => asId(first(
      user && user.uid, user && user.user_id, user && user.userId, user
    ))).filter(Boolean));
  };
  const selfUid = (main) => asId(first(
    valueAt(main && main.loginInfo && main.loginInfo.loginInfo, "uid"),
    main && main.login && main.login.uid,
    main && main.login && main.login.userInfo && main.login.userInfo.uid,
    main && main.mainInfo && main.mainInfo.uid,
    main && main.userInfo && main.userInfo.uid,
    main && main.account && main.account.uid
  ));
  const containsUid = (value, uid) => {
    if (!uid || value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.some((item) => containsUid(item, uid));
    if (typeof value === "object") return containsUid(first(value.uid, value.user_id, value.userId, value.at_uid), uid);
    const id = String(value);
    return id === uid || id === "0";
  };
  const includesAny = (values, needles) => {
    if (!needles.length) return true;
    const haystack = values.filter(Boolean).join("\\n").toLocaleLowerCase();
    return needles.some((needle) => haystack.includes(String(needle).toLocaleLowerCase()));
  };
  const matchingRuleIds = (conversationId, conversationName, senderUid, senderName, text) =>
    RULES.filter((rule) => rule.enabled &&
      (rule.groupTerms.length || rule.senderTerms.length || rule.keywords.length) &&
      includesAny([conversationId, conversationName], rule.groupTerms) &&
      includesAny([senderUid, senderName], rule.senderTerms) &&
      includesAny([text], rule.keywords)
    ).map((rule) => rule.id);
  const inferGroup = (record, session) => {
    if (first(record && record.gid, record && record.group_id, record && record.groupId, session && session.gid, session && session.group_id)) return true;
    const value = String(first(
      record && record.session_type, record && record.chat_type,
      session && session.session_type, session && session.chat_type, session && session.type, ""
    )).toLowerCase();
    if (value.includes("group")) return true;
    if (value.includes("single") || value.includes("direct") || value.includes("person")) return false;
    return null;
  };
  const contextFor = (conversationId, targetId, targetAt, messageState, conversationByMessage) => {
    // 时间不可比较时宁可不展示上下文，也不把目标后的消息误称作“前文”。
    if (!targetAt) return [];
    const output = [];
    for (const [entryKey, record] of entriesOf(messageState && messageState.messageInfo)) {
      if (!record || typeof record !== "object") continue;
      const parsed = parseJson(record.msg);
      const id = messageKey(record, entryKey);
      if (!id || id === targetId) continue;
      const groupId = asId(first(record.groupId, record.group_id));
      const recordConversationId = asId(first(
        record.conversation_id, record.conversationId, record.session_id, record.sessionId,
        groupId && groupId !== "0" ? groupId : undefined,
        record.gid, conversationByMessage.get(id), record.fromId, record.from_uid, "unknown"
      ));
      if (recordConversationId !== conversationId) continue;
      const occurredAtMs = timeMs(first(
        record.msg_time, record.msgTime, record.timestamp, record.time, record.create_time,
        record.created_at, parsed && parsed.msg_time, parsed && parsed.timestamp, parsed && parsed.time
      ));
      if (!occurredAtMs || occurredAtMs > targetAt) continue;
      output.push({
        messageId: id,
        senderUid: asId(first(
          record.from_uid, record.fromUid, record.fromId, record.sender_uid, record.senderUid,
          parsed && parsed.from_uid, parsed && parsed.fromUid, parsed && parsed.sender_uid,
          parsed && parsed.u && parsed.u.uid
        )),
        senderName: String(first(
          record.from_name, record.fromName, record.sender_name, record.senderName,
          parsed && parsed.from_name, parsed && parsed.sender_name,
          parsed && parsed.u && parsed.u.n, ""
        )) || null,
        occurredAtMs,
        messageType: asId(first(record.msg_type, record.msgType, parsed && parsed.type)) || null,
        text: findText(first(parsed && parsed.dt, parsed, record.content, record.text)).join("\\n").trim(),
      });
    }
    output.sort((a, b) => (a.occurredAtMs || 0) - (b.occurredAtMs || 0));
    return output.slice(-4);
  };
  const envelopeFor = (entryKey, record, conversationByMessage, sessions, main, messageState) => {
    if (!record || typeof record !== "object") return null;
    const parsed = parseJson(record.msg);
    const id = messageKey(record, entryKey);
    if (!id) return null;
    const formattedGroupId = asId(first(record.groupId, record.group_id));
    const conversationId = asId(first(
      record.conversation_id, record.conversationId, record.session_id, record.sessionId,
      formattedGroupId && formattedGroupId !== "0" ? formattedGroupId : undefined,
      record.gid, conversationByMessage.get(id), record.fromId, record.from_uid, "unknown"
    ));
    const session = valueAt(sessions, conversationId) || {};
    const mainUid = selfUid(main);
    const senderUid = asId(first(
      record.from_uid, record.fromUid, record.fromId, record.sender_uid, record.senderUid,
      parsed && parsed.from_uid, parsed && parsed.fromUid, parsed && parsed.sender_uid,
      parsed && parsed.u && parsed.u.uid
    ));
    const atValues = first(
      record.at, record.client_at, parsed && parsed.at, parsed && parsed.client_at,
      parsed && parsed.at_list, parsed && parsed.atList
    );
    const mentionedSelf = flag(first(
      record.at_me_msg, record.atMeMsg, record.isCall && record.isCall.at_me_msg,
      parsed && parsed.at_me_msg, parsed && parsed.atMeMsg, false
    )) || containsUid(atValues, mainUid);
    const followedSender = flag(first(
      record.follow_msg, record.followMsg, parsed && parsed.follow_msg, parsed && parsed.followMsg, false
    )) || followUids(main).has(senderUid);
    const occurredAtMs = timeMs(first(
      record.msg_time, record.msgTime, record.timestamp, record.time, record.create_time,
      record.created_at, parsed && parsed.msg_time, parsed && parsed.timestamp, parsed && parsed.time
    ));
    const text = findText(first(parsed && parsed.dt, parsed, record.content, record.text)).join("\\n").trim();
    const isGroup = inferGroup(record, session);
    if (isGroup !== true) return null;
    const conversationName = String(first(
      session.name, session.group_name, session.groupName, session.title,
      record.group_name, record.groupName, ""
    )) || null;
    const senderName = String(first(
      record.from_name, record.fromName, record.sender_name, record.senderName,
      parsed && parsed.from_name, parsed && parsed.sender_name,
      parsed && parsed.u && parsed.u.n, ""
    )) || null;
    const matchedRuleIds = matchingRuleIds(
      conversationId, conversationName, senderUid, senderName, text
    );
    if (!mentionedSelf && !followedSender && !matchedRuleIds.length) return null;
    return {
      bridgeVersion: VERSION,
      conversationId,
      messageId: id,
      conversationName,
      senderUid,
      senderName,
      occurredAtMs,
      capturedAtMs: Date.now(),
      mentionedSelf,
      followedSender,
      matchedRuleIds,
      isGroup,
      messageType: asId(first(record.msg_type, record.msgType, parsed && parsed.type)) || null,
      text,
      context: contextFor(conversationId, id, occurredAtMs, messageState, conversationByMessage),
      raw: { message: snapshot(record), session: snapshot(session) },
    };
  };
  const signalEnvelope = (record, mentionedSelf, followedSender) => {
    if (!record || typeof record !== "object") return null;
    const parsed = parseJson(first(record.msg_body, record.msgBody, record.msg));
    const id = messageKey(record, "");
    if (!id) return null;
    // 原生 @/关注 action 执行后，优先从已经写入 messageInfo 的同一消息构造
    // 富投影（群名、完整正文、内存前文、组合规则）；不发网络请求、不切会话。
    const im = stateOf(window.__ccImStore__);
    const main = stateOf(window.__ccMainStore__);
    const messageState = im.message || {};
    const detailed = valueAt(messageState.messageInfo, id);
    if (detailed && typeof detailed === "object") {
      const rich = envelopeFor(
        id,
        detailed,
        conversationIndex(messageState),
        (im.session && im.session.sessionInfo) || {},
        main,
        messageState
      );
      if (rich) {
        rich.mentionedSelf ||= mentionedSelf;
        rich.followedSender ||= followedSender;
        rich.raw = { ...rich.raw, signal: snapshot(record) };
        return rich;
      }
    }
    const toGroup = asId(first(record.to_gid, record.toGid));
    if (!toGroup || toGroup === "0") return null;
    const senderUid = asId(first(record.from_uid, record.fromUid, parsed && parsed.u && parsed.u.uid));
    const conversationId = toGroup && toGroup !== "0" ? toGroup : senderUid || "unknown";
    return {
      bridgeVersion: VERSION,
      conversationId,
      messageId: id,
      conversationName: String(first(record.name, record.group_name, record.groupName, "")) || null,
      senderUid,
      senderName: String(first(
        record.from_name, record.fromName, parsed && parsed.u && parsed.u.n, ""
      )) || null,
      occurredAtMs: timeMs(first(record.send_time, record.sendTime, record.msg_time, record.time)),
      capturedAtMs: Date.now(),
      mentionedSelf,
      followedSender,
      matchedRuleIds: [],
      isGroup: true,
      messageType: asId(first(record.msg_type, record.msgType, parsed && parsed.r && parsed.r.type)) || null,
      text: String(first(record.content, record.text, "")) ||
        findText(first(parsed && parsed.dt, parsed)).join("\\n").trim(),
      context: [],
      raw: { signal: snapshot(record) },
    };
  };
  const signalLists = (main) => {
    const items = listOf(main && main.msgTrain && main.msgTrain.items);
    const output = [];
    for (const item of items) {
      if (!item || item.key !== "at" && item.key !== "follow") continue;
      const records = item.key === "follow"
        ? listOf(item.list && item.list.datas)
        : listOf(item.list);
      for (const record of records) {
        output.push({
          record,
          mentionedSelf: item.key === "at",
          followedSender: item.key === "follow",
        });
      }
    }
    return output;
  };
  const stopBridge = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(scanTimer);
    clearInterval(healthTimer);
    pending.length = 0;
    queued.clear();
    for (const restore of restorers.splice(0)) {
      try { restore(); } catch (_) {}
    }
  };
  const post = async (message) => {
    if (TRANSPORT === "cdp") {
      const bridgeEmit = globalThis.__toskrEmit;
      if (typeof bridgeEmit === "function") {
        try { bridgeEmit(JSON.stringify(message)); return true; }
        catch (_) { return false; }
      }
      return false;
    }
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(message),
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
      });
      if (response.status === 410) {
        stopBridge();
        return false;
      }
      if (!response.ok) {
        console.warn("[Toskr] 本地消息桥暂未接收该消息（HTTP " + response.status + "），已保留队列等待重试。");
      }
      return response.ok;
    } catch (_) {
      return false;
    }
  };
  const drain = async () => {
    if (draining || stopped) return;
    draining = true;
    while (pending.length && !stopped) {
      const current = pending[0];
      if (!(await post(current.message))) break;
      pending.shift();
      queued.delete(current.key);
      delivered.add(current.key);
    }
    draining = false;
    if (pending.length && !stopped) setTimeout(drain, 1500);
  };
  const enqueue = (key, message) => {
    if (ignored.has(key) || delivered.has(key)) return;
    if (queued.has(key)) {
      const current = pending.find((item) => item.key === key);
      if (current) {
        current.message.mentionedSelf ||= message.mentionedSelf;
        current.message.followedSender ||= message.followedSender;
        current.message.matchedRuleIds = Array.from(new Set([
          ...(current.message.matchedRuleIds || []), ...(message.matchedRuleIds || [])
        ]));
        current.message.raw = { ...current.message.raw, ...message.raw };
        if (!current.message.text && message.text) current.message.text = message.text;
        if ((message.context || []).length >= (current.message.context || []).length) {
          current.message.context = message.context;
        }
      }
      return;
    }
    queued.add(key);
    pending.push({ key, message });
    if (!drainScheduled) {
      drainScheduled = true;
      Promise.resolve().then(() => {
        drainScheduled = false;
        void drain();
      });
    }
  };
  const acceptSignal = (record, mentionedSelf, followedSender, historical) => {
    const message = signalEnvelope(record, mentionedSelf, followedSender);
    if (!message) return;
    const key = message.conversationId + "\\u0000" + message.messageId;
    if (historical && (!message.occurredAtMs || message.occurredAtMs < STARTED_AT - 2000)) {
      ignored.add(key);
      return;
    }
    enqueue(key, message);
  };
  const installHooks = () => {
    const action = window.__ccMainStore__ && window.__ccMainStore__.action &&
      window.__ccMainStore__.action.msgTrain;
    if (!action) return;
    for (const [name, mentionedSelf, followedSender] of [
      ["addAtMeMsg", true, false],
      ["addFollowMsg", false, true],
    ]) {
      const original = action[name];
      if (typeof original !== "function" || original.__toskrMessageWatchHookV1) continue;
      const wrapped = function (...args) {
        let result;
        try {
          result = original.apply(this, args);
        } finally {
          try { acceptSignal(args[0], mentionedSelf, followedSender, false); } catch (_) {}
        }
        return result;
      };
      Object.defineProperty(wrapped, "__toskrMessageWatchHookV1", { value: true });
      try {
        action[name] = wrapped;
        if (action[name] === wrapped) {
          restorers.push(() => { if (action[name] === wrapped) action[name] = original; });
        }
      } catch (_) {}
    }
  };
  const heartbeat = async () => {
    if (stopped) return;
    try {
      const response = await fetch(ENDPOINT, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
      });
      if (response.status === 410) {
        stopBridge();
        return;
      }
      healthFailures = response.ok ? 0 : healthFailures + 1;
    } catch (_) {
      healthFailures += 1;
    }
    if (healthFailures >= 3) stopBridge();
  };
  const scan = () => {
    const im = stateOf(window.__ccImStore__);
    const main = stateOf(window.__ccMainStore__);
    const messageState = im.message || {};
    const infos = messageState.messageInfo;
    const sessions = (im.session && im.session.sessionInfo) || {};
    const index = conversationIndex(messageState);
    installHooks();
    for (const signal of signalLists(main)) {
      acceptSignal(signal.record, signal.mentionedSelf, signal.followedSender, initialScan);
    }
    for (const [entryKey, record] of entriesOf(infos)) {
      const message = envelopeFor(entryKey, record, index, sessions, main, messageState);
      if (!message) continue;
      const key = message.conversationId + "\\u0000" + message.messageId;
      if (initialScan && (!message.occurredAtMs || message.occurredAtMs < STARTED_AT - 2000)) {
        ignored.add(key);
      } else {
        enqueue(key, message);
      }
    }
    initialScan = false;
  };

  scan();
  scanTimer = setInterval(scan, 250);
  if (TRANSPORT === "http") {
    healthTimer = setInterval(() => { void heartbeat(); }, 2_000);
  }
  window.__toskrMessageWatchV1 = {
    stop: stopBridge,
    scan,
    status() {
      return { active: !stopped, pending: pending.length, delivered: delivered.size, ignored: ignored.size };
    },
  };
  console.info("[Toskr] IM 只读消息桥已启动；未切换会话、未修改已读状态、未调用发送接口。");
  return window.__toskrMessageWatchV1.status();
})()`;
}
