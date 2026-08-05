import { undoableTip } from "@/lib/actions";
import { tip } from "@/lib/tip";
import { api } from "@/lib/tauri";
import {
  useNotesStore,
  type Settings,
  type TaskPriority,
} from "@/store/notesStore";

/**
 * AI 智能能力（OpenAI 兼容单配置）：
 * 自然语言建任务 / 拆解子任务 / 笔记智能转任务 / AI 起标题。
 * 提示词与解析都在本文件；HTTP 由 Rust ai_chat（curl）承担。
 */

// ===== 提供商预设 =====

export interface AiPreset {
  id: "deepseek" | "openai" | "kimi" | "qwen" | "custom";
  label: string;
  baseUrl: string;
  modelHint: string;
}

export const AI_PRESETS: AiPreset[] = [
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

/** 由 baseUrl 反查当前命中的预设（不单独持久化选中项，避免双字段打架）。 */
export function matchPreset(baseUrl: string): AiPreset["id"] {
  return (
    AI_PRESETS.find((p) => p.id !== "custom" && p.baseUrl === baseUrl.trim())
      ?.id ?? "custom"
  );
}

// ===== 基础设施（纯函数，vitest 覆盖） =====

/** 剥掉 ``` 围栏与围栏外解释文字，只留最外层 JSON 对象文本。 */
export function stripJsonFence(raw: string): string {
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return s;
}

/** 按 Unicode 码点截断（emoji/生僻字不会被从代理对中间劈开）。 */
export function truncateChars(s: string, n: number): string {
  const chars = [...s.trim()];
  return chars.length > n ? chars.slice(0, n).join("") : chars.join("");
}

export function aiReady(
  s: Pick<Settings, "aiEnabled" | "aiBaseUrl" | "aiApiKey" | "aiModel">
): boolean {
  return (
    s.aiEnabled && !!s.aiBaseUrl.trim() && !!s.aiApiKey.trim() && !!s.aiModel.trim()
  );
}

export type AiErrorKind = "not-configured" | "network" | "parse";

export class AiError extends Error {
  kind: AiErrorKind;
  constructor(kind: AiErrorKind, msg: string) {
    super(msg);
    this.kind = kind;
  }
}

export function aiErrorTip(e: unknown): string {
  if (e instanceof AiError) {
    if (e.kind === "not-configured") return "请先在 设置 → AI 智能 中配置并启用";
    if (e.kind === "parse") return "AI 返回内容无法解析";
  }
  return `AI 请求失败：${String(e).slice(0, 60)}`;
}

// ===== 结果类型与守卫 =====

const PRIORITIES: TaskPriority[] = ["none", "low", "mid", "high"];

export interface ParseTaskResult {
  title: string;
  dueAtMs: number | null;
  priority: TaskPriority;
  checklist: string[];
}

/** 把宽松数值（number/数字字符串/秒级时间戳）归一为毫秒时间戳。 */
function toMs(v: unknown): number | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  // 秒级纪元（~1e9）自动升毫秒
  return n < 1e11 ? n * 1000 : n;
}

function normalizePriority(v: unknown): TaskPriority {
  if (PRIORITIES.includes(v as TaskPriority)) return v as TaskPriority;
  const s = String(v ?? "").toLowerCase();
  if (/high|urgent|紧急|高/.test(s)) return "high";
  if (/mid|medium|中/.test(s)) return "mid";
  if (/low|低/.test(s)) return "low";
  return "none";
}

/** "YYYY-MM-DD"/"YYYY/MM/DD" + "HH:MM" → 本地毫秒时间戳。 */
function dateTimeToMs(date: unknown, time: unknown): number | null {
  if (typeof date !== "string") return null;
  const dm = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(date.trim());
  if (!dm) return null;
  let hh = 9;
  let mm = 0;
  if (typeof time === "string") {
    const tm = /^(\d{1,2}):(\d{1,2})/.exec(time.trim());
    if (tm) {
      hh = Number(tm[1]);
      mm = Number(tm[2]);
    }
  }
  const ms = new Date(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    hh,
    mm,
    0,
    0
  ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 宽容归一化：模型输出的时间以「相对分钟 / 日期+钟点」为主（模型不做
 * 纪元运算），也兼容旧式 dueAtMs（含数字字符串/秒级戳）。完全不可用
 * 才返回 null（对象都不是）。绝对时刻落在过去 → 丢弃到期（不建过期任务）。
 */
export function normalizeParsedTask(
  v: unknown,
  fallbackTitle: string,
  now: number
): ParseTaskResult | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const title =
    typeof o.title === "string" && o.title.trim() ? o.title.trim() : fallbackTitle;

  let dueAtMs: number | null = null;
  const due = o.due;
  if (typeof due === "object" && due !== null) {
    const d = due as Record<string, unknown>;
    const rel = toMs(d.minutesFromNow);
    if (rel !== null) {
      // toMs 会把小数值当秒升毫秒——分钟数走原始数值
      const mins =
        typeof d.minutesFromNow === "number"
          ? d.minutesFromNow
          : Number(String(d.minutesFromNow).trim());
      if (Number.isFinite(mins) && mins > 0) dueAtMs = now + mins * 60_000;
    }
    if (dueAtMs === null) dueAtMs = dateTimeToMs(d.date, d.time);
  }
  if (dueAtMs === null) dueAtMs = toMs(o.dueAtMs);
  if (dueAtMs !== null && dueAtMs < now - 60_000) dueAtMs = null;

  const checklist = Array.isArray(o.checklist)
    ? o.checklist
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        .filter(Boolean)
    : [];

  return { title, dueAtMs, priority: normalizePriority(o.priority), checklist };
}

export interface SplitResult {
  items: string[];
}

export function isSplitResult(v: unknown): v is SplitResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.items) && o.items.every((c) => typeof c === "string");
}

export interface NoteToTaskResult {
  title: string;
  checklist: string[];
}

export function isNoteToTaskResult(v: unknown): v is NoteToTaskResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.title === "string" &&
    !!o.title.trim() &&
    Array.isArray(o.checklist) &&
    o.checklist.every((c) => typeof c === "string")
  );
}

export interface TitleResult {
  title: string;
}

export function isTitleResult(v: unknown): v is TitleResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.title === "string" && !!o.title.trim();
}

// ===== 调用管线 =====

async function callAi(system: string, user: string, maxTokens: number): Promise<string> {
  const { settings } = useNotesStore.getState();
  if (!aiReady(settings)) throw new AiError("not-configured", "AI 未配置或未启用");
  try {
    return await api.aiChat(
      settings.aiBaseUrl.trim(),
      settings.aiApiKey.trim(),
      settings.aiModel.trim(),
      system,
      user,
      maxTokens
    );
  } catch (e) {
    throw new AiError("network", String(e));
  }
}

/** 常见模型 JSON 瑕疵修复：尾逗号、中文引号/弯引号。 */
export function repairJson(s: string): string {
  return s
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseAiRaw(raw: string): unknown {
  const body = stripJsonFence(raw);
  try {
    return JSON.parse(body);
  } catch {
    try {
      return JSON.parse(repairJson(body));
    } catch {
      throw new AiError("parse", "AI 返回内容不是合法 JSON");
    }
  }
}

export function parseAiJson<T>(raw: string, guard: (v: unknown) => v is T): T {
  const parsed = parseAiRaw(raw);
  if (!guard(parsed)) throw new AiError("parse", "AI 返回内容缺少必要字段");
  return parsed;
}

async function callAiJson<T>(
  system: string,
  user: string,
  guard: (v: unknown) => v is T,
  maxTokens: number
): Promise<T> {
  return parseAiJson(await callAi(system, user, maxTokens), guard);
}

/** 按「功能:目标id」加锁；同一对象在途时重复触发静默忽略。 */
const busyKeys = new Set<string>();
function withLock(key: string): boolean {
  if (busyKeys.has(key)) return false;
  busyKeys.add(key);
  return true;
}

// ===== 提示词 =====

const ONLY_JSON = "只输出 JSON，不要任何解释文字，不要使用 markdown 代码块。";

function nowContext(): string {
  const d = new Date();
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `当前本地时间：${iso}（${week}）`;
}

function parseTaskSystem(): string {
  return `你是任务解析助手。将用户输入的一句话解析为结构化任务 JSON。

${nowContext()}

规则：
1. title：任务核心内容，去掉"提醒我""帮我"等口语外壳与时间短语，保留动作本身，不超过30字。
2. due：提到时间才给，三选一，不要自行计算时间戳：
   - 相对时长（"20分钟后""2小时后"）→ {"minutesFromNow": 分钟数}（小时换算成分钟）
   - 具体时刻（"下午3点""明早9点"）→ {"date": "YYYY-MM-DD", "time": "HH:MM"}（24小时制；
     结合上面的当前日期推算；该钟点当天已过则用明天的日期；用户说"明天/明早"必须用明天日期）
   - 没提到时间 → null
3. priority：只能是 "none"|"low"|"mid"|"high"。出现"重要""紧急""务必""deadline"→ high；
   "有空""顺手""不急"→ low；无法判断 → none。
4. checklist：仅当用户明确要求拆步骤/清单（"拆一下""分几步""列个清单"）时才给出，
   3-8 条，每条动词开头不超过20字；否则给空数组 []。

输出结构（所有键都必须出现）：
{"title": string, "due": {"minutesFromNow": number} | {"date": string, "time": string} | null, "priority": string, "checklist": string[]}

示例（假设当前是 2026-08-05 周三 10:00）：
输入"下午3点提醒我开会" → {"title":"开会","due":{"date":"2026-08-05","time":"15:00"},"priority":"none","checklist":[]}
输入"20分钟后提醒我关火" → {"title":"关火","due":{"minutesFromNow":20},"priority":"high","checklist":[]}
输入"晚上8点提醒我复盘"（当前已 21:00）→ {"title":"复盘","due":{"date":"2026-08-06","time":"20:00"},"priority":"none","checklist":[]}
输入"明早9点前交周报，拆一下步骤" → {"title":"交周报","due":{"date":"2026-08-06","time":"09:00"},"priority":"mid","checklist":["整理本周完成事项","汇总下周计划","检查数据与附件","发送周报"]}

${ONLY_JSON}`;
}

const SPLIT_SYSTEM = `你是任务拆解助手。把给出的任务（可能带备注/已有检查项）拆解为 3-8 条具体可执行的检查项。
要求：动词开头、可勾选完成、每条不超过20字、按执行顺序排列、不要重复任务标题本身；
若提供了"已有检查项"，不要生成与其重复的内容。
输出结构：{"items": string[]}
${ONLY_JSON}`;

const NOTE_TO_TASK_SYSTEM = `你是笔记转任务助手。阅读笔记正文，提炼一个任务标题与若干检查项。
title：不超过30字，概括这段内容要做的核心事情。
checklist：3-8 条可执行步骤，动词开头、每条不超过20字；内容明显不含多步骤时可给 1-2 条或空数组。
输出结构：{"title": string, "checklist": string[]}
${ONLY_JSON}`;

const TITLE_SYSTEM = `你是标题生成助手。为给出的笔记内容生成一个不超过 12 个字的简洁标题，
准确概括核心主题，不加标点符号，不加引号。
输出结构：{"title": string}
${ONLY_JSON}`;

// ===== 业务功能 =====

/**
 * ✨ 自然语言建任务。任何失败（未配置/网络/解析）都回退为普通文本任务入库
 * ——回车的语义是「存下这句话」，AI 只是增强，用户输入绝不能凭空消失。
 */
export async function parseTaskInput(rawText: string): Promise<void> {
  const text = rawText.trim();
  if (!text) return;
  try {
    const raw = await callAi(parseTaskSystem(), text, 600);
    const r = normalizeParsedTask(parseAiRaw(raw), text, Date.now());
    if (!r) throw new AiError("parse", "AI 返回内容缺少必要字段");
    const store = useNotesStore.getState();
    const { result, id } = store.addTask(truncateChars(r.title, 30) || text);
    if (result !== "added" || !id) return;
    if (r.dueAtMs !== null) store.setTaskDue(id, r.dueAtMs);
    if (r.priority !== "none") store.setTaskPriority(id, r.priority);
    for (const item of r.checklist.slice(0, 8)) {
      store.addChecklistItem(id, item);
    }
    tip("ok", `已创建任务「${truncateChars(r.title, 12)}」`);
  } catch (e) {
    useNotesStore.getState().addTask(text);
    tip("warn", `${aiErrorTip(e)} · 已按原文创建任务`);
  }
}

/** 右键「AI 拆解子任务」：拆成检查项批量写入（一次快照，可整体撤销）。 */
export async function splitSubtasks(taskId: string): Promise<void> {
  const key = `split:${taskId}`;
  if (!withLock(key)) return;
  try {
    const task = useNotesStore.getState().tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (!aiReady(useNotesStore.getState().settings)) {
      tip("info", "请先在 设置 → AI 智能 中配置并启用");
      return;
    }
    tip("info", "AI 正在拆解子任务…");
    let user = task.text;
    if (task.note) user += `\n备注：${task.note}`;
    const existing = (task.checklist ?? []).map((c) => c.text);
    if (existing.length) user += `\n已有检查项：${existing.join("、")}`;
    const r = await callAiJson(SPLIT_SYSTEM, user, isSplitResult, 600);
    const items = r.items.map((t) => t.trim()).filter(Boolean).slice(0, 8);
    const store = useNotesStore.getState();
    if (!items.length || !store.tasks.some((t) => t.id === taskId)) {
      tip("warn", "AI 未返回可用的检查项");
      return;
    }
    store.snapshot("AI 拆解子任务");
    for (const item of items) store.addChecklistItem(taskId, item);
    undoableTip(`已拆解 ${items.length} 条子任务`);
  } catch (e) {
    tip("warn", aiErrorTip(e));
  } finally {
    busyKeys.delete(key);
  }
}

/** 右键「AI 转任务」：提炼标题+检查项，原子替换笔记（AI 期间笔记被删则放弃）。 */
export async function noteToTaskSmart(noteId: string): Promise<void> {
  const key = `to-task:${noteId}`;
  if (!withLock(key)) return;
  try {
    const note = useNotesStore.getState().notes.find((n) => n.id === noteId);
    if (!note || note.kind === "image") return;
    if (!aiReady(useNotesStore.getState().settings)) {
      tip("info", "请先在 设置 → AI 智能 中配置并启用");
      return;
    }
    tip("info", "AI 正在提炼任务…");
    const r = await callAiJson(
      NOTE_TO_TASK_SYSTEM,
      note.text,
      isNoteToTaskResult,
      600
    );
    // AI 思考期间笔记可能已被删除/变更：以当下状态为准
    if (!useNotesStore.getState().notes.some((n) => n.id === noteId)) {
      tip("warn", "笔记已不存在，转换取消");
      return;
    }
    const ok = useNotesStore
      .getState()
      .convertNoteToTaskSmart(noteId, truncateChars(r.title, 30), r.checklist.slice(0, 8));
    if (ok) undoableTip("已转为任务（AI）");
    else tip("warn", "该卡片不支持转为任务");
  } catch (e) {
    tip("warn", aiErrorTip(e));
  } finally {
    busyKeys.delete(key);
  }
}

/** 右键「AI 起标题」：生成 ≤12 字标题写入卡片自定义标题。 */
export async function suggestTitle(noteId: string): Promise<void> {
  const key = `title:${noteId}`;
  if (!withLock(key)) return;
  try {
    const note = useNotesStore.getState().notes.find((n) => n.id === noteId);
    if (!note || note.kind === "image") return;
    if (!aiReady(useNotesStore.getState().settings)) {
      tip("info", "请先在 设置 → AI 智能 中配置并启用");
      return;
    }
    tip("info", "AI 正在起标题…");
    const r = await callAiJson(TITLE_SYSTEM, note.text, isTitleResult, 100);
    if (!useNotesStore.getState().notes.some((n) => n.id === noteId)) return;
    const title = truncateChars(r.title, 12);
    useNotesStore.getState().updateNoteTitle(noteId, title);
    tip("ok", `已命名：${title}`);
  } catch (e) {
    tip("warn", aiErrorTip(e));
  } finally {
    busyKeys.delete(key);
  }
}

/**
 * 设置页「测试连接」。配置从参数传入而非读 store：设置窗是独立 webview，
 * 它的 zustand 副本不同步，读 store 会测到旧值（多窗口陷阱，勿改回）。
 */
export async function testAiConnection(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<void> {
  const reply = await api.aiChat(
    baseUrl.trim(),
    apiKey.trim(),
    model.trim(),
    "你是连通性测试助手。",
    "收到请只回复：OK",
    50
  );
  if (!reply.trim()) throw new Error("响应为空");
}
