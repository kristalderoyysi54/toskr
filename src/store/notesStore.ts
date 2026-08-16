import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { advanceCycle, billFallbackColor } from "@/lib/bills";
import { detectCode } from "@/lib/code";
import { detectLink } from "@/lib/link";
import { imageCaption } from "@/lib/format";
import { normalizeNoteContent } from "@/lib/noteContent";
import {
  normalizeNoteContentBlocks,
  noteContentBlocks,
  projectNoteContent,
  replaceNoteTextProjection,
  textFromContentBlocks,
  type NoteContentBlock,
} from "@/lib/noteContentBlocks";
import { FIREWALL_WARN_CATEGORIES } from "@/lib/delivery/firewall";
import {
  isAliasCategoryRecordValid,
  isAliasCounterRecordValid,
  isAliasEntityRecordValid,
  type AliasCategoryDefinition,
  type AliasEntity,
} from "@/lib/delivery/aliasEntities";
import type { FindingCategory } from "@/lib/tauri";
import {
  normalizeOutcomeBaselines,
  normalizeProblemSessions,
  type OutcomeBaseline,
  type OutcomeProblemSession,
  type OutcomeRetentionDays,
} from "@/lib/outcomeIntelligence";
import {
  GENERAL_PROMPT_GROUP_ID,
  SAFETY_PROFILE_ID,
  TERMINAL_BUNDLE_IDS,
  createDefaultPromptGroups,
  createDefaultTargetProfiles,
  repairTargetProfileConfiguration,
  type PromptGroup,
  type PromptSnippet,
  type TargetProfile,
} from "@/lib/targetProfiles";
import {
  ONBOARDING_VERSION,
  defaultOnboardingState,
  onboardingAfter,
  onboardingStateFromPersisted,
  type OnboardingEvent,
  type OnboardingState,
} from "@/lib/onboarding";
import type { SecretKey, SecretMeta } from "@/lib/secret/secret";
import { tauriStateStorage } from "./persistStorage";

export type { PromptGroup, PromptSnippet, TargetProfile } from "@/lib/targetProfiles";
export type { AliasCategoryDefinition, AliasEntity } from "@/lib/delivery/aliasEntities";
export type { OnboardingEvent, OnboardingState } from "@/lib/onboarding";
export type { NoteContentBlock } from "@/lib/noteContentBlocks";
export type { SecretKey, SecretMeta, SecretDirection } from "@/lib/secret/secret";
export { noteContentBlocks, textFromContentBlocks };

export type NoteKind = "text" | "image" | "link" | "secret";

/** 面板页签（与 uiStore.PanelPage 同集合；此处独立声明避免 store 互相依赖）。 */
export type PageId = "notes" | "clipboard" | "tasks" | "secret";

/** 页签默认顺序（剪贴最高频，居首；秘文默认关闭故垫底）。 */
export const DEFAULT_PAGE_ORDER: PageId[] = ["clipboard", "notes", "tasks", "secret"];
export const STORE_VERSION = 19;

/**
 * 归一化页签顺序：去重、剔除未知项、补齐缺失页（按默认序追加）。
 * 持久化数据可能来自旧版本（无此字段）或将来新增页的版本，
 * 少一页就会整页无法访问，必须兜底。
 */
export function normalizePageOrder(order: unknown): PageId[] {
  const seen = new Set<PageId>();
  const out: PageId[] = [];
  if (Array.isArray(order)) {
    for (const p of order) {
      if (DEFAULT_PAGE_ORDER.includes(p as PageId) && !seen.has(p as PageId)) {
        seen.add(p as PageId);
        out.push(p as PageId);
      }
    }
  }
  for (const p of DEFAULT_PAGE_ORDER) if (!seen.has(p)) out.push(p);
  return out;
}

export interface Note {
  id: string;
  /** 内容类型（缺省视为 text，兼容旧数据）。 */
  kind?: NoteKind;
  /** 检测到的代码语言（普通文本为 undefined）。 */
  codeLang?: string;
  /** 链接卡片的 URL（kind=link）。 */
  url?: string;
  /** 链接卡片抓取的网页标题（未抓到/未完成时缺省，展示回退 URL）。 */
  linkTitle?: string;
  /** 链接卡片的站点图标 URL。 */
  linkIcon?: string;
  /** 图片附件文件名（kind=image 的主图）。 */
  imageFile?: string;
  /** 附加图片（合并后的组合卡片可同时带多张图）。 */
  attachments?: string[];
  /**
   * 富卡权威内容。缺省仅用于兼容旧内存夹具/导入；v16 新建与持久化迁移
   * 都会写入。text/imageFile/attachments 是由它确定性生成的兼容投影。
   */
  contentBlocks?: NoteContentBlock[];
  imageW?: number;
  imageH?: number;
  text: string;
  sectionId: string;
  done: boolean;
  /** 常用内容：发送后不标记完成，长期复用（右键「设为常用」；剪贴板卡=固定不清理）。 */
  keep?: boolean;
  /** 自定义标题（右键「重命名」；卡片通栏显示，便于识别长内容）。 */
  title?: string;
  /** 标签（右键「标签」/多选条批量添加；归一去重，最多 8 个）。 */
  tags?: string[];
  createdAt: number;
  /**
   * 内容最后修改时间（编辑正文/富块/增删图片/重命名/合并时打点）。
   * 组织类操作（完成/常用/移动/打标签）不打点；缺省 = 创建后从未修改。
   */
  updatedAt?: number;
  /** 捕获来源应用名（如 "Safari"）。 */
  sourceApp?: string;
  /** 来源应用 bundle id（图标经内存缓存按需获取，不落盘）。 */
  sourceBundle?: string;
  /** 手动确认的发送结果来源；结果正文仍只存在本 Note。 */
  provenance?: NoteProvenance;
  /**
   * 秘文卡元数据（kind=secret）：text 存中文密文信封，明文永不落盘、展示按需解密。
   * keyId=null 表示收到但无匹配密钥（锁定卡）。字段名 secretMeta 而非 secret：
   * 备份导出黑名单（backup.rs reject_forbidden_fields）会拒绝规范化后恰为 "secret" 的键名。
   */
  secretMeta?: SecretMeta;
}

export interface NoteProvenance {
  kind: "deliveryResult";
  deliveryId: string;
  capturedAtMs: number;
  sourceBundle: string;
  sourceItemIds: string[];
}

export interface Section {
  id: string;
  name: string;
  collapsed?: boolean;
  /** 分组色标（"#rrggbb"；未设为无色）。 */
  color?: string;
  /** 组内卡片发送后不标记完成（Prompt 库等长期复用分组）。 */
  keepAfterSend?: boolean;
}

// ===== 任务（闪念/待办，任务页专用；与笔记独立的数据域）=====

export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "none" | "low" | "mid" | "high";

/** 任务的检查列表项（子任务，Apple 提醒事项风格）。 */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  text: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** 到期时间（epoch ms）；null = 未设置。 */
  dueAt: number | null;
  createdAt: number;
  /** 该 dueAt 是否已推送过到期提醒；重设 dueAt 时清空，允许对新时间重新提醒。 */
  remindedAt: number | null;
  /** 备注（展开详情里编辑；缺省无）。 */
  note?: string;
  /** 检查列表（子任务；缺省无）。 */
  checklist?: ChecklistItem[];
  /** 类型：缺省普通待办；"spark" = 闪念灵感（单独分区、⚡ 一键转待办）。 */
  kind?: "spark";
  /** 所属任务分组（缺省归收集箱）。 */
  sectionId?: string;
}

/** 任务默认分组（收集箱）。 */
export const TASK_INBOX_ID = "task-inbox";

/** 任务分组（轻量：无色标等笔记分组特有属性）。 */
export interface TaskSection {
  id: string;
  name: string;
  collapsed?: boolean;
}

const defaultTaskSections = (): TaskSection[] => [
  { id: TASK_INBOX_ID, name: "收集箱" },
];

// ===== 账单（订阅 / 信用卡还款；「提醒」页第二子视图，与任务独立的数据域）=====

export type BillKind = "subscription" | "creditCard";

/** 周期五档（周条/月历色点图例一一对应）；信用卡固定 monthly。 */
export type BillCycle = "weekly" | "monthly" | "quarterly" | "semiannual" | "yearly";

/** paused/canceled 行为一致（保留记录、不提醒、不计消费），仅语义标签不同。 */
export type BillStatus = "active" | "paused" | "canceled";

/** 提前提醒档位（天）：0 = 到期当天。 */
export type ReminderOffsetDays = 0 | 1 | 3 | 7;

export const BILL_REMINDER_OFFSET_OPTIONS: ReminderOffsetDays[] = [7, 3, 1, 0];

/** 单账单记账事件封顶（月付约 5 年），趋势图只看近 6 个月，余量充足。 */
export const BILL_HISTORY_MAX = 60;

/**
 * 一次记账事件：订阅到期自动滚动、信用卡「标记已还」各落一条。
 * 是消费历史/趋势图的唯一数据源（事件流可重算聚合，不维护合计缓存）。
 */
export interface BillPaymentEvent {
  id: string;
  /** 记的是哪一期（滚动前的 nextDueAt）。 */
  periodDueAt: number;
  amount: number;
  /** auto = periodDueAt 本身（长期未开应用也补记进正确历史月份）；manual = 点击时刻。 */
  paidAt: number;
  method: "auto" | "manual";
}

export interface Bill {
  id: string;
  kind: BillKind;
  name: string;
  /** 已缓存进本地媒体库的 favicon 文件名（与笔记图片同一套 GC/备份）。 */
  iconFile?: string;
  /** 首字色块兜底色（"#rrggbb"，创建时按 name 稳定派生，不随改名重算）。 */
  fallbackColor: string;
  /** 每期金额；订阅必填（UI 强制），信用卡可留空（标记已还时再录）。 */
  amount: number | null;
  cycle: BillCycle;
  /** 下次到期/还款日（epoch ms，本地当天 00:00）。 */
  nextDueAt: number;
  status: BillStatus;
  /** 启用的提前提醒档（可多选；空数组 = 不提醒）。 */
  reminderOffsets: ReminderOffsetDays[];
  /** 当前账期已提醒过的档位；nextDueAt 滚动后整体重置。 */
  remindedFor: { dueAt: number; offsets: ReminderOffsetDays[] };
  /** 记账历史（FIFO 封顶 BILL_HISTORY_MAX）。 */
  history: BillPaymentEvent[];
  note?: string;
  createdAt: number;
  /** 来自预置服务目录时的条目 id（展示参考，非强约束）。 */
  catalogId?: string;
}

/** 分组可选色板（对齐 Paste 的色点风格）。 */
// 用户可选的分组调色板（数据，非样式 token）：用户直接挑选的颜色值，刻意独立于 design-token 体系
export const SECTION_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#94a3b8",
];

export type ThemePref = "system" | "light" | "dark";

/** 到期快捷档配置：相对分钟 / 今天定点 / 明天定点 / 下个周几定点。 */
export type DuePresetCfg =
  | { id: string; kind: "relative"; minutes: number }
  | { id: string; kind: "today" | "tomorrow"; hour: number; minute: number }
  | { id: string; kind: "weekday"; weekday: number; hour: number; minute: number };

export const DEFAULT_DUE_PRESETS: DuePresetCfg[] = [
  { id: "rel-30m", kind: "relative", minutes: 30 },
  { id: "rel-1h", kind: "relative", minutes: 60 },
  { id: "rel-3h", kind: "relative", minutes: 180 },
  { id: "rel-6h", kind: "relative", minutes: 360 },
  { id: "today-20", kind: "today", hour: 20, minute: 0 },
  { id: "tomorrow-9", kind: "tomorrow", hour: 9, minute: 0 },
  { id: "next-mon-9", kind: "weekday", weekday: 1, hour: 9, minute: 0 },
];

export const DEFAULT_PROMPT_SNIPPETS: PromptSnippet[] = [
  {
    id: "review",
    label: "代码审查",
    text: "请帮我 review 以下代码，指出问题与改进建议：\n\n{内容}",
    groupId: GENERAL_PROMPT_GROUP_ID,
  },
  {
    id: "translate",
    label: "翻译成中文",
    text: "请把以下内容翻译成中文：\n\n{内容}",
    groupId: GENERAL_PROMPT_GROUP_ID,
  },
  {
    id: "summarize",
    label: "总结要点",
    text: "请总结以下内容的要点：\n\n{内容}",
    groupId: GENERAL_PROMPT_GROUP_ID,
  },
  {
    id: "explain",
    label: "解释内容",
    text: "请解释以下内容：\n\n{内容}",
    groupId: GENERAL_PROMPT_GROUP_ID,
  },
  {
    id: "optimize-prompt",
    label: "优化提示词",
    text: "请你不要执行接下来的任务。你现在的身份是世界顶级的提示工程专家，请仔细阅读我提供的提示词：\n\n{内容}\n\n并从清晰度、专业度、结构化、模型适应性四个维度进行批判性优化。请仅输出优化后的提示词内容，并用 ``` 包裹起来。",
    groupId: GENERAL_PROMPT_GROUP_ID,
  },
];

export type VibrancyMaterial =
  | "hud"
  | "popover"
  | "sidebar"
  | "under-window"
  | "fullscreen";

export interface Settings {
  /** 主题：跟随系统 / 浅色 / 深色。 */
  theme: ThemePref;
  /** 内容膜层不透明度（0.25–1）：影响面板底色，毛玻璃关闭时最直观。 */
  panelOpacity: number;
  /** 窗口整体不透明度（0.3–1）：连毛玻璃层一起变透，真正能看穿下层窗口。 */
  windowOpacity: number;
  /** 毛玻璃（系统 vibrancy）开关。 */
  vibrancy: boolean;
  /** 毛玻璃材质。 */
  vibrancyMaterial: VibrancyMaterial;
  /** 卡片顶部彩色通栏（关闭则用中性灰）。 */
  cardTint: boolean;
  /** 卡片底色不透明度（0.3–1）：调低可透出毛玻璃背景。 */
  cardOpacity: number;
  /** 卡片密度：舒适（瓷砖）/ 紧凑（单行列表）。 */
  cardDensity: "comfortable" | "compact";
  /** 文本详情窗正文字号（px；详情窗 ⌘+/⌘- 同步调整，⌘0 复位）。 */
  detailFontSize: number;
  /** 剪贴卡模板（仅舒适密度竖栏生效）：标准瓷砖 / 浓缩（票据头+单行摘要）。 */
  clipCardTemplate: "standard" | "condensed";
  /** 卡片右键菜单项显隐与顺序（合并置顶、删除垫底不参与自定义）。 */
  contextMenu: { id: ContextMenuItemId; on: boolean }[];
  /** 启动时自动检查更新。 */
  autoCheckUpdate: boolean;
  /** 发现新版本自动下载安装（重启后生效，不打断当前使用）。 */
  autoInstallUpdate: boolean;
  /** 剪贴板历史自动收集（首装默认开启）。 */
  clipHistory: boolean;
  /** 剪贴板历史保留时长（天；null = 永久，首装默认 30 天）。超龄的非固定卡自动清理。 */
  clipRetentionDays: number | null;
  /** 暂停剪贴板收集到该时刻（epoch ms；null = 未暂停）。 */
  clipPauseUntil: number | null;
  /** 剪贴板规则：忽略机密内容（密码管理器 ConcealedType 标记）。 */
  clipIgnoreConcealed: boolean;
  /** 剪贴板规则：忽略瞬时内容（AutoGenerated/Transient 标记）。 */
  clipIgnoreTransient: boolean;
  /** 连续复制两次（10 秒内同一内容）自动置顶该剪贴卡。 */
  clipDoubleCopyKeep: boolean;
  /** 剪贴板规则：忽略应用列表（独立于捕获排除）。 */
  clipExcludedApps: string[];
  /** v8 兼容字段；v9 起仅迁移读取，发送统一由 TargetProfile.enterPolicy 决定。 */
  autoEnter: boolean;
  /** 面板失焦自动隐藏。 */
  hideOnBlur: boolean;
  /** v16 兼容字段；当前固定为 true，贴边隐藏已是无需配置的默认能力。 */
  autoEdgeHide: boolean;
  /** 全局触发键：双击哪个修饰键。 */
  hotkeyModifier: "shift" | "control" | "option";
  /** 两次轻击「抬起→抬起」最大间隔（ms）。 */
  hotkeyGapMs: number;
  /** 双击触发仅捕获（面板开关交给专用快捷键；默认智能：无选中时开关面板）。 */
  doubleTapCaptureOnly: boolean;
  /** 面板显示/隐藏专用快捷键（global-shortcut 格式如 "Cmd+Shift+KeyV"，null=未设置）。
   *  与双击触发独立：只开关面板不捕获，钉住时也可收起。 */
  panelToggleHotkey: string | null;
  /** 隐身模式：捕获照常入库但不弹 HUD（会议投屏用）。 */
  stealth: boolean;
  /** 捕获成功音效（隐身模式下强制静音）。 */
  soundEnabled: boolean;
  /** 非粘性提示气泡自动隐藏时长（ms）。 */
  hudDurationMs: number;
  /** 首个数据档案的面板默认态是否已成功下发（仅首启消费一次）。 */
  initialPanelSetupDone: boolean;
  /** 伴随停靠：面板磁吸到目标应用窗口右缘并跟随。 */
  companionEnabled: boolean;
  /** 伴随应用 bundle id 列表。 */
  companionApps: string[];
  /** 伴随停靠时面板与目标窗口的间隙（pt，0=紧贴）。 */
  companionGap: number;
  /** 独立模式下手动拖动后的位置（null=默认屏幕右缘）。 */
  panelFreeX: number | null;
  panelFreeY: number | null;
  /** 边栏模式：贴屏幕某缘（保留停靠间距），与伴随磁吸互斥。 */
  rightSidebar: boolean;
  /** 边栏停靠缘（左右=全高竖栏，上下=全宽横栏）。 */
  sidebarEdge: "right" | "left" | "top" | "bottom";
  /** 页签顺序（可拖动重排；同时决定切页滑动方向）。 */
  pageOrder: PageId[];
  /** 底部新增框上次选择的笔记分组；null = 按当前排序取第一组。 */
  lastDraftSectionId: string | null;
  /** 面板置顶（屏幕最上层）；关闭后可被其他窗口盖住。 */
  panelTopmost: boolean;
  /** 到期快捷档（可增删改）：相对分钟 / 今天 / 明天 / 下个周几。 */
  duePresets: DuePresetCfg[];
  /** 账单金额展示的货币符号（纯前缀，不做汇率/多币种）。 */
  currencySymbol: string;
  /** 新建账单默认勾选的提前提醒档；只作用于此后新建，不回写已有账单。 */
  billDefaultReminderOffsets: ReminderOffsetDays[];
  /** AI 提供商（OpenAI 兼容）：Base URL（如 https://api.deepseek.com）。 */
  aiBaseUrl: string;
  /** AI 模型名（如 deepseek-chat）。 */
  aiModel: string;
  /** AI 智能功能总开关（独立于配置是否填写）。 */
  aiEnabled: boolean;
  /** 捕获排除列表：这些应用内双击只开关面板、绝不捕获（密码管理器等）。 */
  excludedApps: string[];
  /** Prompt 前缀模板：发送时可选拼在内容前（Prompt 组装台）。 */
  promptSnippets: PromptSnippet[];
  /** Prompt 分组；通用分组始终存在。 */
  promptGroups: PromptGroup[];
  /** 目标应用发送偏好，按数组顺序决定重复 bundle 的稳定 winner。 */
  targetProfiles: TargetProfile[];
  /** 未精确命中 bundle 时使用的用户默认 Profile。 */
  defaultTargetProfileId: string;
  /** 本地出站隐私检查总开关；首装默认开启。 */
  firewallEnabled: boolean;
  /** 用户本次关闭的提示级类别；block 规则不允许进入此列表。 */
  firewallDisabledWarnCategories: FindingCategory[];
  /** 可逆化名总开关（词典为空时天然惰性）。 */
  aliasEntitiesEnabled: boolean;
  /** 化名词典：用户主动录入的原文 → 稳定占位符（明文随本地数据与完整备份保存）。 */
  aliasEntities: AliasEntity[];
  /** 用户自定义化名类别（预置类别硬编码，不落此处）。 */
  aliasCustomCategories: AliasCategoryDefinition[];
  /** 类别码 → 下一个可用编号；只增不减，删除条目不回收编号。 */
  aliasNextNumberByCategory: Record<string, number>;
  /** 划词捕获入库时自动把词典占位符恢复为原文。 */
  aliasAutoRestoreOnCapture: boolean;
  /** 本机成效聚合开关；关闭后新发送仍可恢复，但不进入指标。 */
  outcomeMetricsEnabled: boolean;
  /** 发送元数据账本保留期；按当前数据目录压实。 */
  outcomeRetentionDays: OutcomeRetentionDays;
  /** “清除成效历史”推进的本机代次；不删除最近发送恢复账本。 */
  outcomeMetricsEpoch: number;
  /** 用户明确填写的传统流程基线；没有基线绝不估算节省时间。 */
  outcomeBaselines: OutcomeBaseline[];
  /** 用户主动开始的问题处理计时，只保存时间与关联发送 ID。 */
  outcomeProblemSessions: OutcomeProblemSession[];
  /** 数据文件夹展示值（真实来源在 Rust，这里仅用于设置界面回显）。 */
  dataDir: string;
  /** 面板逻辑宽度（pt）。 */
  panelWidth: number;
  /** 面板顶缘相对基准的偏移（pt，上下拖拽产生）。 */
  panelTopOffset: number;
  /** 面板高度覆盖（pt；null = 自动同目标窗口/近全高）。 */
  panelHeight: number | null;
  /** 秘文（中文加密通信）总开关；默认关闭，关闭时秘文页与捕获识别都不启用。 */
  secretEnabled: boolean;
  /** 共享密钥列表（明文随本地数据保存；威胁模型见设置页说明）。 */
  secretKeys: SecretKey[];
  /** 发送时默认使用的密钥 id；null = 用列表首个。 */
  secretDefaultKeyId: string | null;
  /** 秘文卡揭示明文后自动重新遮罩的超时（ms）；0 = 常驻不自动遮罩。 */
  secretRevealTimeoutMs: number;
  onboarding: OnboardingState;
}

export const INBOX_ID = "inbox";
/** 剪贴板历史专用分组（自动创建，插在收件箱之后）。 */
export const CLIPBOARD_ID = "clipboard";
/** 「连续复制两次自动置顶」判定窗口；写死不做可调（YAGNI，改动需同步设置页 hint 文案）。 */
export const CLIP_DOUBLE_COPY_KEEP_WINDOW_MS = 10_000;
/** 秘文专用分组（首次收发时自动创建，插在收件箱之后）。 */
export const SECRET_ID = "secret";

/** 卡片右键菜单可自定义项（顺序即默认顺序；具体卡片类型不适用的项自动隐藏）。 */
export type ContextMenuItemId =
  | "preview"
  | "textops"
  | "send"
  | "send-template"
  | "send-preflight"
  | "copy"
  | "copy-list"
  | "edit"
  | "ocr"
  | "done"
  | "keep"
  | "rename"
  | "tags"
  | "to-task"
  | "ai-to-task"
  | "ai-title"
  | "move";

export const CONTEXT_MENU_REGISTRY: { id: ContextMenuItemId; label: string }[] = [
  { id: "preview", label: "预览 / 打开链接" },
  { id: "textops", label: "文本处理" },
  { id: "send", label: "发送到对话" },
  { id: "send-template", label: "用模板发送" },
  { id: "send-preflight", label: "预检并发送" },
  { id: "copy", label: "复制内容" },
  { id: "copy-list", label: "复制为列表" },
  { id: "edit", label: "编辑" },
  { id: "ocr", label: "识别文字 (OCR)" },
  { id: "done", label: "标记完成" },
  { id: "keep", label: "设为常用 / 固定" },
  { id: "rename", label: "重命名" },
  { id: "tags", label: "标签" },
  { id: "to-task", label: "转为任务" },
  { id: "ai-to-task", label: "AI 转任务" },
  { id: "ai-title", label: "AI 起标题" },
  { id: "move", label: "移动到分组" },
];

/**
 * 右键菜单固定按用途分区，用户自定义顺序只在同一分区内生效。
 * 保持一级菜单，避免窄面板里多层子菜单越过 WebView 边界。
 */
export const CONTEXT_MENU_GROUPS = [
  { id: "view", label: "查看与编辑" },
  { id: "content", label: "复制与处理" },
  { id: "send", label: "发送与转换" },
  { id: "organize", label: "整理" },
] as const;

export type ContextMenuGroupId = (typeof CONTEXT_MENU_GROUPS)[number]["id"];

const CONTEXT_MENU_GROUP_BY_ITEM: Record<ContextMenuItemId, ContextMenuGroupId> = {
  preview: "view",
  edit: "view",
  rename: "view",
  copy: "content",
  "copy-list": "content",
  textops: "content",
  ocr: "content",
  "ai-title": "content",
  send: "send",
  "send-template": "send",
  "send-preflight": "send",
  "to-task": "send",
  "ai-to-task": "send",
  done: "organize",
  keep: "organize",
  tags: "organize",
  move: "organize",
};

export const NOTE_TAG_MAX_COUNT = 8;
export const NOTE_TAG_MAX_LENGTH = 24;

/**
 * 归一化标签集合：去首尾空白与前导 #、去空、大小写不敏感去重（保序、保首个
 * 写法）、单条长度按码点封顶、条数封顶；空集合归一为 undefined（不落盘空数组）。
 */
export function sanitizeNoteTags(
  tags: readonly string[]
): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.replace(/^[\s#]+/u, "").trim();
    if (!tag) continue;
    const clipped = [...tag].slice(0, NOTE_TAG_MAX_LENGTH).join("");
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= NOTE_TAG_MAX_COUNT) break;
  }
  return out.length ? out : undefined;
}

export function groupContextMenuIds(ids: readonly ContextMenuItemId[]) {
  return CONTEXT_MENU_GROUPS.map((group) => ({
    ...group,
    ids: ids.filter((id) => CONTEXT_MENU_GROUP_BY_ITEM[id] === group.id),
  }));
}

/** 归一化菜单配置：补齐新版本新增项（老配置向前兼容）、剔除未知项。 */
export function normalizeContextMenu(
  cfg: { id: ContextMenuItemId; on: boolean }[] | undefined
): { id: ContextMenuItemId; on: boolean }[] {
  const known = new Set(CONTEXT_MENU_REGISTRY.map((i) => i.id));
  const seen = new Set<string>();
  const out: { id: ContextMenuItemId; on: boolean }[] = [];
  for (const item of cfg ?? []) {
    if (known.has(item.id) && !seen.has(item.id)) {
      out.push({ id: item.id, on: item.on });
      seen.add(item.id);
    }
  }
  for (const { id } of CONTEXT_MENU_REGISTRY) {
    if (!seen.has(id)) out.push({ id, on: true });
  }
  return out;
}
export const PANEL_WIDTH_MIN = 320;
export const PANEL_WIDTH_MAX = 520;
export const HUD_DURATION_MIN_MS = 2_000;
export const HUD_DURATION_MAX_MS = 10_000;
export const HUD_DURATION_DEFAULT_MS = 3_000;

const defaultSections = (): Section[] => [{ id: INBOX_ID, name: "收件箱" }];

export const DEFAULT_COMPANION_APPS = [
  ...TERMINAL_BUNDLE_IDS,
  "com.todesktop.230313mzl4w4u92",
  "com.microsoft.VSCode",
  "com.microsoft.VSCodeInsiders",
  "com.dimillian.codexmonitor",
  "com.codepilot.app",
  "io.appmakes.otty",
  "com.openai.codex",
];

export const DEFAULT_EXCLUDED_APPS = [
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  "com.apple.Passwords",
  "com.apple.keychainaccess",
];

/** 详情窗字号边界与默认（默认对齐 --text-body=12px）。 */
export const DETAIL_FONT_SIZE_DEFAULT = 12;
export const DETAIL_FONT_SIZE_MIN = 10;
export const DETAIL_FONT_SIZE_MAX = 24;

export const clampDetailFontSize = (size: number): number =>
  Math.min(
    DETAIL_FONT_SIZE_MAX,
    Math.max(DETAIL_FONT_SIZE_MIN, Math.round(size))
  );

export const defaultSettings = (): Settings => ({
  theme: "system",
  panelOpacity: 0.62,
  windowOpacity: 1,
  vibrancy: true,
  vibrancyMaterial: "hud",
  cardTint: true,
  cardOpacity: 1,
  cardDensity: "comfortable",
  detailFontSize: DETAIL_FONT_SIZE_DEFAULT,
  clipCardTemplate: "standard",
  contextMenu: CONTEXT_MENU_REGISTRY.map((i) => ({ id: i.id, on: true })),
  autoCheckUpdate: true,
  autoInstallUpdate: false,
  // 首装默认（2026-08 用户指定）：剪贴板历史开，保留 1 个月
  clipHistory: true,
  clipRetentionDays: 30,
  clipPauseUntil: null,
  clipIgnoreConcealed: true,
  clipIgnoreTransient: true,
  clipDoubleCopyKeep: true,
  clipExcludedApps: [...DEFAULT_EXCLUDED_APPS],
  autoEnter: false,
  hideOnBlur: true,
  // 贴边隐藏是默认能力（字段保留用于兼容旧备份），伴随磁吸按需开启
  autoEdgeHide: true,
  hotkeyModifier: "shift",
  hotkeyGapMs: 400,
  doubleTapCaptureOnly: false,
  panelToggleHotkey: null,
  stealth: false,
  soundEnabled: true,
  hudDurationMs: HUD_DURATION_DEFAULT_MS,
  // Native 启动仍保持隐藏；数据水合确认是新档案后再一次性打开、固定并启用磁吸
  initialPanelSetupDone: false,
  companionEnabled: false,
  companionApps: [...DEFAULT_COMPANION_APPS],
  companionGap: 8,
  panelFreeX: null,
  panelFreeY: null,
  rightSidebar: false,
  pageOrder: [...DEFAULT_PAGE_ORDER],
  lastDraftSectionId: null,
  sidebarEdge: "right",
  panelTopmost: true,
  duePresets: DEFAULT_DUE_PRESETS.map((p) => ({ ...p })),
  currencySymbol: "¥",
  billDefaultReminderOffsets: [3, 1],
  aiBaseUrl: "",
  aiModel: "",
  aiEnabled: false,
  excludedApps: [...DEFAULT_EXCLUDED_APPS],
  promptGroups: createDefaultPromptGroups(),
  promptSnippets: DEFAULT_PROMPT_SNIPPETS.map((item) => ({ ...item })),
  targetProfiles: createDefaultTargetProfiles(false),
  defaultTargetProfileId: SAFETY_PROFILE_ID,
  firewallEnabled: true,
  firewallDisabledWarnCategories: [],
  aliasEntitiesEnabled: true,
  aliasEntities: [],
  aliasCustomCategories: [],
  aliasNextNumberByCategory: {},
  aliasAutoRestoreOnCapture: true,
  outcomeMetricsEnabled: true,
  outcomeRetentionDays: 30,
  outcomeMetricsEpoch: 0,
  outcomeBaselines: [],
  outcomeProblemSessions: [],
  dataDir: "",
  panelWidth: 380,
  panelTopOffset: 0,
  panelHeight: null,
  // 秘文默认关闭（用户指定）：不显示秘文页、不做捕获识别
  secretEnabled: false,
  secretKeys: [],
  secretDefaultKeyId: null,
  secretRevealTimeoutMs: 8000,
  onboarding: defaultOnboardingState(),
});

function repairSettingsTargetProfiles(settings: Settings): Settings {
  const repaired = repairTargetProfileConfiguration({
    groups: settings.promptGroups,
    snippets: settings.promptSnippets,
    profiles: settings.targetProfiles,
    defaultProfileId: settings.defaultTargetProfileId,
  });
  return {
    ...settings,
    firewallDisabledWarnCategories: [
      ...new Set(settings.firewallDisabledWarnCategories),
    ].filter((category) =>
      FIREWALL_WARN_CATEGORIES.includes(
        category as (typeof FIREWALL_WARN_CATEGORIES)[number]
      )
    ),
    outcomeRetentionDays: ([7, 30, 90] as const).includes(settings.outcomeRetentionDays)
      ? settings.outcomeRetentionDays
      : 30,
    outcomeBaselines: normalizeOutcomeBaselines(settings.outcomeBaselines),
    outcomeProblemSessions: normalizeProblemSessions(settings.outcomeProblemSessions),
    onboarding: onboardingStateFromPersisted(settings.onboarding),
    promptGroups: repaired.groups,
    promptSnippets: repaired.snippets,
    targetProfiles: repaired.profiles,
    defaultTargetProfileId: repaired.defaultProfileId,
  };
}

export interface UndoEntry {
  label: string;
  sections: Section[];
  notes: Note[];
  tasks: Task[];
  taskSections: TaskSection[];
  bills: Bill[];
}

export type AddNoteResult = "added" | "duplicate" | "empty";

export interface NotesState {
  sections: Section[];
  notes: Note[];
  /** 任务（任务页；与笔记同一持久化 bag、同一条撤销栈）。 */
  tasks: Task[];
  /** 任务分组（收集箱恒存）。 */
  taskSections: TaskSection[];
  /** 账单（「提醒」页订阅子视图；同一持久化 bag、同一条撤销栈）。 */
  bills: Bill[];
  /** 勾选态（临时，不持久化）。 */
  checkedIds: string[];
  settings: Settings;
  /** 撤销栈（内存，不持久化）。 */
  undoStack: UndoEntry[];

  addNote: (
    text: string,
    opts?: {
      sectionId?: string;
      sourceApp?: string;
      sourceBundle?: string;
      kind?: NoteKind;
      imageFile?: string;
      imageW?: number;
      imageH?: number;
      /** 除 imageFile 外的其余图片附件（输入框暂存多图成组合卡）。 */
      attachments?: string[];
      /** 有序富内容；传入后为权威，text 与旧图片字段只作调用兼容。 */
      contentBlocks?: NoteContentBlock[];
      /** 来源侧捕获时间；异步图片本地化完成顺序不应改写原始时间。 */
      createdAt?: number;
    }
  ) => { result: AddNoteResult; id?: string };
  /**
   * 剪贴板历史入库：自动建「剪贴板」分组、超限裁剪。返回待清理图片与
   * 手势信号：`autoKept` = 本次触发「连续复制两次自动置顶」（供 HUD 提示+撤销）。
   */
  addClipNote: (
    text: string,
    opts?: {
      sourceApp?: string;
      sourceBundle?: string;
      kind?: NoteKind;
      imageFile?: string;
      imageW?: number;
      imageH?: number;
      attachments?: string[];
      /** 有序富内容；传入后为权威。 */
      contentBlocks?: NoteContentBlock[];
      /** 来源侧捕获时间；重复项提升也使用该时间。 */
      createdAt?: number;
    }
  ) => { orphanImages: string[]; autoKept?: { id: string; preview: string } };
  /**
   * 秘文入库：自动建「秘文」分组；envelope 为中文密文信封（明文永不落盘）。
   * 同信封重复视为 duplicate。用于捕获自动解密与发送方留存己发卡。
   */
  addSecretNote: (
    envelope: string,
    meta: SecretMeta,
    opts?: { sourceApp?: string; sourceBundle?: string; createdAt?: number }
  ) => { result: AddNoteResult; id?: string };
  /**
   * 回写秘文卡元数据（命中密钥变化时用）：卡片改用全部密钥试解成功后，把最新
   * keyId/keyLabel 写回，让锁定卡补配密钥后模糊态标签也随之更新。纯元数据、不打 updatedAt。
   */
  setSecretMeta: (id: string, meta: Partial<SecretMeta>) => void;
  /** 清空剪贴板历史（固定 ★ 卡保留；可撤销）。返回删除数与待清理图片。 */
  clearClipHistory: () => { removed: number; orphanImages: string[] };
  /** 按保留时长清理超龄剪贴板卡（固定卡豁免；静默，不占撤销栈）。返回待清理图片。 */
  pruneClipHistory: () => string[];
  /** 更新正文；详情编辑器传 imageFiles 时同步替换附件。 */
  updateNoteText: (id: string, text: string, imageFiles?: string[]) => void;
  /** 原子替换富卡权威块，并同步所有兼容投影。 */
  updateNoteContent: (id: string, blocks: NoteContentBlock[]) => void;
  /**
   * 从卡片移除一张图片（组合卡详情页的 ⊗）。剩余图片顺次补位；一张不剩时：
   * 有文字 → 退化为纯文本卡，无文字 → 整张卡删除。可撤销，故刻意不删磁盘
   * 文件（与 deleteNotes 同约定：撤销要还原得回来）。
   * 返回：卡片是否已被整张删除（调用方据此决定是否关闭详情窗）。
   */
  removeNoteImage: (id: string, file: string) => { noteDeleted: boolean };
  /** 回填链接卡片抓取到的网页标题/图标。 */
  setLinkMeta: (id: string, meta: { title?: string; icon?: string }) => void;
  /** 重命名卡片（空串 = 清除标题）。 */
  updateNoteTitle: (id: string, title: string) => void;
  /** 覆写卡片标签（经 sanitizeNoteTags 归一；空集清除）。组织操作，不打 updatedAt。 */
  setNoteTags: (id: string, tags: string[]) => void;
  /** 批量追加标签（并集，多选条「打标签」）。 */
  addNoteTags: (ids: string[], tags: string[]) => void;
  /** 关联/改绑/解除发送结果；不删除或改写 Note 正文。 */
  setNoteProvenance: (id: string, provenance?: NoteProvenance) => boolean;
  deleteNotes: (ids: string[], undoLabel?: string) => void;
  setDone: (ids: string[], done: boolean) => void;
  toggleDone: (id: string) => void;
  clearDone: () => number;
  /** 切换卡片「常用」（发送后不标完成）。 */
  toggleNoteKeep: (id: string) => void;
  /** 切换分组「发送后保留」。 */
  toggleSectionKeep: (id: string) => void;

  toggleChecked: (id: string) => void;
  setChecked: (ids: string[]) => void;
  clearChecked: () => void;

  mergeNotes: (ids: string[]) => void;
  moveNotes: (ids: string[], sectionId: string) => void;
  reorderNotes: (activeId: string, overId: string) => void;

  addSection: (name?: string) => void;
  renameSection: (id: string, name: string) => void;
  setSectionColor: (id: string, color?: string) => void;
  deleteSection: (id: string) => void;
  moveSection: (id: string, dir: -1 | 1) => void;
  reorderSections: (activeId: string, overId: string) => void;
  toggleSectionCollapsed: (id: string) => void;

  // ===== 任务 =====
  addTask: (
    text: string,
    opts?: { kind?: "spark"; sectionId?: string }
  ) => { result: "added" | "empty"; id?: string };
  /** 闪念 ⚡ 转正式待办。 */
  sparkToTask: (id: string) => void;
  moveTasksToSection: (ids: string[], sectionId: string) => void;
  /** 分组内拖拽排序（同 reorderNotes 心智）：把 activeId 移到 overId 所在位置。 */
  reorderTasks: (activeId: string, overId: string) => void;
  addTaskSection: (name?: string) => void;
  renameTaskSection: (id: string, name: string) => void;
  /** 删除分组：组内任务归收集箱（收集箱不可删）。 */
  deleteTaskSection: (id: string) => void;
  moveTaskSection: (id: string, dir: -1 | 1) => void;
  toggleTaskSectionCollapsed: (id: string) => void;
  updateTaskText: (id: string, text: string) => void;
  /** 状态点点击：todo → doing → done → todo 三态循环。 */
  cycleTaskStatus: (id: string) => void;
  /** 键盘 x/Space：done ↔ 非 done 二态直切（跳过「进行中」）。 */
  toggleTaskDone: (id: string) => void;
  /** 右键菜单直达设置状态。 */
  setTaskStatus: (id: string, status: TaskStatus) => void;
  setTaskPriority: (id: string, priority: TaskPriority) => void;
  /** 优先级色条点击：none → low → mid → high → none 循环。 */
  cycleTaskPriority: (id: string) => void;
  /** 设置/清除到期时间；改动会清空 remindedAt 以便对新时间重新提醒。 */
  setTaskDue: (id: string, dueAt: number | null) => void;
  markTasksReminded: (ids: string[]) => void;
  /** 更新备注（空串视为清除）。 */
  updateTaskNote: (id: string, note: string) => void;
  addChecklistItem: (taskId: string, text: string) => void;
  toggleChecklistItem: (taskId: string, itemId: string) => void;
  updateChecklistItem: (taskId: string, itemId: string, text: string) => void;
  deleteChecklistItem: (taskId: string, itemId: string) => void;
  deleteTasks: (ids: string[], undoLabel?: string) => void;
  clearDoneTasks: () => number;
  /** 笔记转任务：一次快照原子完成「建任务 + 删笔记」；图片/组合卡返回 false。 */
  convertNoteToTask: (noteId: string) => boolean;
  /** AI 版笔记转任务：标题/检查项由调用方（AI 解析后）传入，同款原子语义。 */
  convertNoteToTaskSmart: (
    noteId: string,
    title: string,
    checklist: string[]
  ) => boolean;

  // ===== 账单 =====
  /** 新建账单（reminderOffsets 缺省取 settings.billDefaultReminderOffsets）。 */
  addBill: (input: {
    kind: BillKind;
    name: string;
    amount: number | null;
    cycle: BillCycle;
    nextDueAt: number;
    reminderOffsets?: ReminderOffsetDays[];
    iconFile?: string;
    fallbackColor: string;
    note?: string;
    catalogId?: string;
  }) => string;
  /** 编辑/暂停/恢复/取消统一入口；nextDueAt 变化时重置当期已提醒档。 */
  updateBill: (
    id: string,
    patch: Partial<Omit<Bill, "id" | "createdAt" | "history" | "remindedFor">>
  ) => void;
  /** 删除账单（可撤销）；iconFile 的媒体 GC 由调用方 scheduleMediaGc。 */
  deleteBill: (id: string) => void;
  /** 信用卡「标记已还」：落 manual 记账、金额回写为本期实付、滚到下期。 */
  markBillPaid: (id: string, amount: number) => void;
  /** 滚动所有到期的 active 订阅（可跨多期补记）；信用卡不自动滚。 */
  rollBillsIfDue: (now: number) => void;
  /** 提醒去重打点：把命中的档位并入对应账单当期 remindedFor。 */
  markBillsReminded: (
    hits: { billId: string; offset: ReminderOffsetDays }[]
  ) => void;

  setSettings: (patch: Partial<Settings>) => void;
  markOnboarding: (patch: Partial<OnboardingState>) => void;
  transitionOnboarding: (event: OnboardingEvent) => void;

  snapshot: (label: string) => void;
  undo: () => string | null;
  /** 导入合并：按 id 去重追加，返回各域新增条数。 */
  importMerge: (data: {
    sections?: Section[];
    notes?: Note[];
    tasks?: Task[];
    taskSections?: TaskSection[];
    bills?: Bill[];
  }) => { notes: number; tasks: number; bills: number; skippedDuplicates: number };
}

const UNDO_DEPTH = 5;

type PersistentNotesState = Pick<
  NotesState,
  "sections" | "notes" | "tasks" | "taskSections" | "bills" | "settings"
>;

export type NotesStoreSnapshot = PersistentNotesState &
  Pick<NotesState, "checkedIds" | "undoStack">;

function dedupeById<T extends { id: string }>(values: unknown): T[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values.filter((value): value is T => {
    if (!value || typeof value !== "object") return false;
    const id = (value as { id?: unknown }).id;
    if (typeof id !== "string" || !id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function assertCurrentSchemaHasUniqueIds(
  persisted: Partial<NotesState>
): void {
  const assertUnique = (values: unknown, field: string) => {
    if (!Array.isArray(values)) return;
    const seen = new Set<string>();
    for (const value of values) {
      if (!value || typeof value !== "object") continue;
      const id = (value as { id?: unknown }).id;
      if (typeof id === "string" && id && seen.has(id)) {
        throw new Error(`${field} 含重复 id：${id}`);
      }
      if (typeof id === "string" && id) seen.add(id);
    }
  };
  assertUnique(persisted.sections, "sections");
  assertUnique(persisted.notes, "notes");
  assertUnique(persisted.taskSections, "taskSections");
  assertUnique(persisted.tasks, "tasks");
  for (const task of Array.isArray(persisted.tasks) ? persisted.tasks : []) {
    if (task && typeof task === "object") {
      assertUnique((task as Task).checklist, "task.checklist");
    }
  }
  assertUnique(persisted.bills, "bills");
  for (const bill of Array.isArray(persisted.bills) ? persisted.bills : []) {
    if (bill && typeof bill === "object") {
      assertUnique((bill as Bill).history, "bill.history");
    }
  }
  assertUnique(persisted.settings?.promptGroups, "settings.promptGroups");
  assertUnique(persisted.settings?.promptSnippets, "settings.promptSnippets");
  assertUnique(persisted.settings?.targetProfiles, "settings.targetProfiles");
  assertUnique(persisted.settings?.aliasEntities, "settings.aliasEntities");
  assertUnique(persisted.settings?.secretKeys, "settings.secretKeys");
}

function validateSettingsShape(value: unknown, version: number): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings 必须是对象");
  }
  const settings = value as Record<string, unknown>;
  // v10 及更早的 aiApiKey 只为异步 Keychain 迁移保留。迁移失败时它必须
  // 继续作为唯一可恢复副本存在，因此 v11 也只校验类型，不在 decoder 中删除。
  if (settings.aiApiKey !== undefined && typeof settings.aiApiKey !== "string") {
    throw new Error("settings.aiApiKey 类型无效");
  }
  const defaults = defaultSettings() as unknown as Record<string, unknown>;
  const nullableTypes: Record<string, "number" | "string"> = {
    clipPauseUntil: "number",
    panelToggleHotkey: "string",
    panelFreeX: "number",
    panelFreeY: "number",
    panelHeight: "number",
    lastDraftSectionId: "string",
    secretDefaultKeyId: "string",
  };
  for (const [key, fallback] of Object.entries(defaults)) {
    const current = settings[key];
    if (current === undefined) continue;
    if (key === "clipRetentionDays") {
      if (current !== null && (typeof current !== "number" || !Number.isFinite(current))) {
        throw new Error("settings.clipRetentionDays 类型无效");
      }
      continue;
    }
    if (key in nullableTypes) {
      if (current !== null && typeof current !== nullableTypes[key]) {
        throw new Error(`settings.${key} 类型无效`);
      }
      continue;
    }
    if (Array.isArray(fallback) || (fallback && typeof fallback === "object")) continue;
    if (typeof current !== typeof fallback) {
      throw new Error(`settings.${key} 类型无效`);
    }
    if (typeof current === "number" && !Number.isFinite(current)) {
      throw new Error(`settings.${key} 必须是有限数字`);
    }
  }
  const enumField = (key: string, allowed: readonly string[]) => {
    const current = settings[key];
    if (current !== undefined && (typeof current !== "string" || !allowed.includes(current))) {
      throw new Error(`settings.${key} 枚举无效`);
    }
  };
  enumField("theme", ["system", "light", "dark"]);
  enumField("vibrancyMaterial", ["hud", "popover", "sidebar", "under-window", "fullscreen"]);
  enumField("cardDensity", ["comfortable", "compact"]);
  // banner 是已移除的旧「单行」模板，仅为读取旧数据保留；迁移后统一写成 condensed。
  enumField("clipCardTemplate", ["standard", "condensed", "banner"]);
  enumField("hotkeyModifier", ["shift", "control", "option"]);
  enumField("sidebarEdge", ["right", "left", "top", "bottom"]);
  if (settings.outcomeRetentionDays !== undefined &&
    ![7, 30, 90].includes(settings.outcomeRetentionDays as number)) {
    throw new Error("settings.outcomeRetentionDays 枚举无效");
  }
  if (settings.outcomeMetricsEpoch !== undefined && (
    typeof settings.outcomeMetricsEpoch !== "number" ||
    !Number.isSafeInteger(settings.outcomeMetricsEpoch) ||
    settings.outcomeMetricsEpoch < 0
  )) {
    throw new Error("settings.outcomeMetricsEpoch 字段无效");
  }
  if (settings.hudDurationMs !== undefined && (
    typeof settings.hudDurationMs !== "number" ||
    !Number.isInteger(settings.hudDurationMs) ||
    settings.hudDurationMs < HUD_DURATION_MIN_MS ||
    settings.hudDurationMs > HUD_DURATION_MAX_MS
  )) {
    throw new Error("settings.hudDurationMs 超出允许范围");
  }

  const stringArrays = ["clipExcludedApps", "companionApps", "excludedApps"];
  for (const key of stringArrays) {
    const current = settings[key];
    if (current !== undefined && (!Array.isArray(current) || !current.every((item) => typeof item === "string"))) {
      throw new Error(`settings.${key} 必须是字符串数组`);
    }
  }
  const disabledWarnCategories = settings.firewallDisabledWarnCategories;
  if (disabledWarnCategories !== undefined && (
    !Array.isArray(disabledWarnCategories) ||
    !disabledWarnCategories.every((item) =>
      FIREWALL_WARN_CATEGORIES.includes(item as (typeof FIREWALL_WARN_CATEGORIES)[number])
    )
  )) {
    throw new Error("settings.firewallDisabledWarnCategories 含不可关闭类别");
  }
  const validateNormalizedArray = (
    key: string,
    max: number,
    normalize: (items: never[]) => unknown[]
  ) => {
    const current = settings[key];
    if (current === undefined) return;
    if (!Array.isArray(current) || current.length > max ||
      current.some((item) => normalize([item] as never[]).length !== 1)) {
      throw new Error(`settings.${key} 字段无效`);
    }
  };
  validateNormalizedArray("outcomeBaselines", 64, normalizeOutcomeBaselines);
  validateNormalizedArray("outcomeProblemSessions", 100, normalizeProblemSessions);
  const pageOrder = settings.pageOrder;
  if (pageOrder !== undefined && (!Array.isArray(pageOrder) || !pageOrder.every((item) => DEFAULT_PAGE_ORDER.includes(item as PageId)))) {
    throw new Error("settings.pageOrder 含无效页签");
  }
  const snippets = settings.promptSnippets;
  if (snippets !== undefined && (!Array.isArray(snippets) || !snippets.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const snippet = item as Record<string, unknown>;
    return typeof snippet.id === "string"
      && (version < 9 || snippet.id.length > 0)
      && ["label", "text"].every((key) => typeof snippet[key] === "string")
      && (version < 9 || typeof snippet.groupId === "string");
  }))) {
    throw new Error("settings.promptSnippets 字段无效");
  }
  const promptGroups = settings.promptGroups;
  if (promptGroups !== undefined && (!Array.isArray(promptGroups) || !promptGroups.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const group = item as Record<string, unknown>;
    return typeof group.id === "string"
      && group.id.length > 0
      && typeof group.name === "string"
      && typeof group.order === "number"
      && Number.isFinite(group.order);
  }))) {
    throw new Error("settings.promptGroups 字段无效");
  }
  const profiles = settings.targetProfiles;
  if (profiles !== undefined && (!Array.isArray(profiles) || !profiles.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const profile = item as Record<string, unknown>;
    return typeof profile.id === "string"
      && profile.id.length > 0
      && typeof profile.name === "string"
      && Array.isArray(profile.bundleIds)
      && profile.bundleIds.every((bundleId) => typeof bundleId === "string")
      && typeof profile.promptGroupId === "string"
      && ["plain", "code"].includes(String(profile.defaultFormat))
      && ["never", "confirm", "allow"].includes(String(profile.enterPolicy))
      && ["requireRedaction", "confirmRaw", "allowRaw"].includes(String(profile.privacyPolicy))
      && typeof profile.keepPanel === "boolean";
  }))) {
    throw new Error("settings.targetProfiles 字段无效");
  }
  if (settings.defaultTargetProfileId !== undefined
    && typeof settings.defaultTargetProfileId !== "string") {
    throw new Error("settings.defaultTargetProfileId 字段无效");
  }
  const secretKeys = settings.secretKeys;
  if (
    secretKeys !== undefined &&
    (!Array.isArray(secretKeys) ||
      !secretKeys.every((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return false;
        }
        const key = item as Record<string, unknown>;
        return (
          typeof key.id === "string" &&
          key.id.length > 0 &&
          typeof key.label === "string" &&
          typeof key.passphrase === "string" &&
          (key.note === undefined || typeof key.note === "string") &&
          typeof key.createdAtMs === "number" &&
          typeof key.updatedAtMs === "number"
        );
      }))
  ) {
    throw new Error("settings.secretKeys 字段无效");
  }
  const aliasEntities = settings.aliasEntities;
  if (aliasEntities !== undefined) {
    if (!Array.isArray(aliasEntities) || !aliasEntities.every(isAliasEntityRecordValid)) {
      throw new Error("settings.aliasEntities 字段无效");
    }
    const originals = new Set<string>();
    const placeholders = new Set<string>();
    for (const item of aliasEntities as AliasEntity[]) {
      if (originals.has(item.originalText) || placeholders.has(item.placeholder)) {
        throw new Error("settings.aliasEntities 含重复原文或占位符");
      }
      originals.add(item.originalText);
      placeholders.add(item.placeholder);
    }
  }
  const aliasCustomCategories = settings.aliasCustomCategories;
  if (aliasCustomCategories !== undefined) {
    if (!Array.isArray(aliasCustomCategories) ||
      !aliasCustomCategories.every(isAliasCategoryRecordValid)) {
      throw new Error("settings.aliasCustomCategories 字段无效");
    }
    const codes = new Set(
      (aliasCustomCategories as AliasCategoryDefinition[]).map((item) => item.code)
    );
    if (codes.size !== aliasCustomCategories.length) {
      throw new Error("settings.aliasCustomCategories 含重复类别码");
    }
  }
  if (settings.aliasNextNumberByCategory !== undefined &&
    !isAliasCounterRecordValid(settings.aliasNextNumberByCategory)) {
    throw new Error("settings.aliasNextNumberByCategory 字段无效");
  }
  const menu = settings.contextMenu;
  const menuIds = new Set(CONTEXT_MENU_REGISTRY.map((item) => item.id));
  if (menu !== undefined && (!Array.isArray(menu) || !menu.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return typeof entry.id === "string" && menuIds.has(entry.id as ContextMenuItemId) && typeof entry.on === "boolean";
  }))) {
    throw new Error("settings.contextMenu 字段无效");
  }
  const onboarding = settings.onboarding;
  const onboardingValid = (() => {
    if (onboarding === undefined) return true;
    if (!onboarding || typeof onboarding !== "object" || Array.isArray(onboarding)) {
      return false;
    }
    const value = onboarding as unknown as Record<string, unknown>;
    if (!["captured", "sent", "done", "rehearsalActive"].every((key) =>
      value[key] === undefined || typeof value[key] === "boolean"
    )) return false;
    if (
      value.onboardingVersion !== undefined &&
      value.onboardingVersion !== ONBOARDING_VERSION
    ) return false;
    if (
      value.rehearsalStep !== undefined &&
      !["permissions", "capture", "target", "firewall", "delivery", "complete"]
        .includes(String(value.rehearsalStep))
    ) return false;
    if (
      value.rehearsalNoteId !== undefined &&
      value.rehearsalNoteId !== null &&
      typeof value.rehearsalNoteId !== "string"
    ) return false;
    const optionalTimes = [
      "rehearsalStartedAtMs",
      "rehearsalPausedAtMs",
      "rehearsalCompletedAtMs",
      "rehearsalDeferredAtMs",
      "permissionsCompletedAtMs",
      "recoveryTutorialCompletedAtMs",
      "activationStartedAtMs",
    ];
    if (!optionalTimes.every((key) =>
      value[key] === undefined ||
      value[key] === null ||
      (typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        (value[key] as number) >= 0)
    )) return false;
    return value.activationWithin60s === undefined ||
      value.activationWithin60s === null ||
      typeof value.activationWithin60s === "boolean";
  })();
  if (!onboardingValid) {
    throw new Error("settings.onboarding 字段无效");
  }
  const duePresets = settings.duePresets;
  if (duePresets !== undefined && (!Array.isArray(duePresets) || !duePresets.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const preset = item as Record<string, unknown>;
    if (typeof preset.id !== "string" || !["relative", "today", "tomorrow", "weekday"].includes(String(preset.kind))) return false;
    const numeric = (key: string) => typeof preset[key] === "number" && Number.isFinite(preset[key]);
    return preset.kind === "relative" ? numeric("minutes") : numeric("hour") && numeric("minute") && (preset.kind !== "weekday" || numeric("weekday"));
  }))) {
    throw new Error("settings.duePresets 字段无效");
  }
}

function finiteNumberOrDefault(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} 必须是非负有限数字`);
  }
  return value;
}

function nullableTimeOrDefault(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return finiteNumberOrDefault(value, 0, field);
}

/**
 * v8 允许重复或空 snippet id；v9 必须唯一。迁移只重编号冲突项，绝不丢模板，
 * 因而数量、正文与数组顺序保持不变，且重复执行会得到同一结果。
 */
function migrateLegacyPromptSnippets(
  snippets: PromptSnippet[]
): PromptSnippet[] {
  const used = new Set<string>();
  return snippets.map((snippet, index) => {
    let id = snippet.id;
    if (!id || used.has(id)) {
      const base = id || "legacy-snippet";
      let suffix = index + 1;
      do {
        id = `${base}-migrated-${suffix}`;
        suffix += 1;
      } while (used.has(id));
    }
    used.add(id);
    return { ...snippet, id, groupId: GENERAL_PROMPT_GROUP_ID };
  });
}

function normalizeNoteTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) {
    throw new Error("note.tags 必须是字符串数组");
  }
  return sanitizeNoteTags(value);
}

function normalizeNoteProvenance(value: unknown): NoteProvenance | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("note.provenance 必须是对象");
  }
  const provenance = value as Record<string, unknown>;
  if (
    provenance.kind !== "deliveryResult" ||
    typeof provenance.deliveryId !== "string" ||
    !provenance.deliveryId ||
    typeof provenance.sourceBundle !== "string" ||
    !provenance.sourceBundle ||
    typeof provenance.capturedAtMs !== "number" ||
    !Number.isFinite(provenance.capturedAtMs) ||
    provenance.capturedAtMs < 0 ||
    !Array.isArray(provenance.sourceItemIds) ||
    !provenance.sourceItemIds.length ||
    !provenance.sourceItemIds.every((id) => typeof id === "string" && !!id)
  ) {
    throw new Error("note.provenance 字段无效");
  }
  return {
    ...(provenance as unknown as NoteProvenance),
    kind: "deliveryResult",
    deliveryId: provenance.deliveryId,
    capturedAtMs: provenance.capturedAtMs,
    sourceBundle: provenance.sourceBundle,
    sourceItemIds: [...new Set(provenance.sourceItemIds)],
  };
}

function noteContentPatch(blocks: unknown): Pick<
  Note,
  | "contentBlocks"
  | "text"
  | "imageFile"
  | "attachments"
  | "imageW"
  | "imageH"
> {
  const projected = projectNoteContent(blocks);
  return {
    contentBlocks: projected.contentBlocks,
    text: projected.text,
    imageFile: projected.imageFile,
    attachments: projected.attachments,
    imageW: projected.imageW,
    imageH: projected.imageH,
  };
}

/**
 * 秘文卡元数据归一：kind=secret 恒有合法 meta，非 secret 卡剥除杂散 meta。
 * 兼容读取历史键名 secret（早期实现曾用该键；正式落盘键为 secretMeta）。
 */
function normalizeSecretMeta(kind: NoteKind, meta: unknown): SecretMeta | undefined {
  if (kind !== "secret") return undefined;
  const m = (meta && typeof meta === "object" ? meta : {}) as Record<
    string,
    unknown
  >;
  const direction = m.direction === "out" ? "out" : "in";
  const keyId = typeof m.keyId === "string" ? m.keyId : null;
  const keyLabel = typeof m.keyLabel === "string" ? m.keyLabel : undefined;
  return { keyId, keyLabel, direction };
}

function normalizeNoteRecord(
  note: Note,
  sectionIds: Set<string>,
  preferContentBlocks = true
): Note {
  const kind = note.kind ?? "text";
  if (!(["text", "image", "link", "secret"] as const).includes(kind)) {
    throw new Error(`note.kind 无效：${String(note.kind)}`);
  }
  if (note.done !== undefined && typeof note.done !== "boolean") {
    throw new Error("note.done 必须是 boolean");
  }
  // v15 及更早版本中的同名未知字段没有契约，迁移时只从当时权威的旧字段
  // 建块；v16/导入的新卡只信 contentBlocks，随后统一反投影旧字段。
  const blocks = preferContentBlocks
    ? noteContentBlocks(note)
    : noteContentBlocks({ ...note, contentBlocks: undefined });
  // 剥除早期实现的历史键 secret：其内容已并入下方 secretMeta，且该裸键名会触发
  // 备份导出黑名单（backup.rs），绝不能随 ...rest 再次落盘。
  const { secret: _legacySecret, ...rest } = note as Note & { secret?: unknown };
  return {
    ...rest,
    kind,
    ...noteContentPatch(blocks),
    sectionId:
      typeof note.sectionId === "string" && sectionIds.has(note.sectionId)
        ? note.sectionId
        : INBOX_ID,
    done: note.done ?? false,
    createdAt: finiteNumberOrDefault(note.createdAt, 0, "note.createdAt"),
    updatedAt:
      note.updatedAt === undefined
        ? undefined
        : finiteNumberOrDefault(note.updatedAt, 0, "note.updatedAt"),
    tags: normalizeNoteTags(note.tags),
    provenance: normalizeNoteProvenance(note.provenance),
    secretMeta: normalizeSecretMeta(
      kind,
      note.secretMeta ?? (note as { secret?: unknown }).secret
    ),
  };
}

function normalizeTaskRecord(task: Task, sectionIds: Set<string>): Task {
  const status = task.status ?? "todo";
  const priority = task.priority ?? "none";
  if (!(["todo", "doing", "done"] as const).includes(status)) {
    throw new Error(`task.status 无效：${String(task.status)}`);
  }
  if (!(["none", "low", "mid", "high"] as const).includes(priority)) {
    throw new Error(`task.priority 无效：${String(task.priority)}`);
  }
  if (task.kind !== undefined && task.kind !== "spark") {
    throw new Error(`task.kind 无效：${String(task.kind)}`);
  }
  const checklist = dedupeById<ChecklistItem>(task.checklist).map((item) => {
    if (item.done !== undefined && typeof item.done !== "boolean") {
      throw new Error("checklist.done 必须是 boolean");
    }
    return {
      ...item,
      text: typeof item.text === "string" ? item.text : "",
      done: item.done ?? false,
    };
  });
  return {
    ...task,
    text: typeof task.text === "string" ? task.text : "",
    status,
    priority,
    dueAt: nullableTimeOrDefault(task.dueAt, "task.dueAt"),
    remindedAt: nullableTimeOrDefault(task.remindedAt, "task.remindedAt"),
    createdAt: finiteNumberOrDefault(task.createdAt, 0, "task.createdAt"),
    checklist: checklist.length ? checklist : undefined,
    sectionId:
      task.sectionId && sectionIds.has(task.sectionId) ? task.sectionId : undefined,
  };
}

const BILL_KINDS = ["subscription", "creditCard"] as const;
const BILL_CYCLES = ["weekly", "monthly", "quarterly", "semiannual", "yearly"] as const;
const BILL_STATUSES = ["active", "paused", "canceled"] as const;

function normalizeReminderOffsets(value: unknown): ReminderOffsetDays[] {
  if (!Array.isArray(value)) return [];
  const out: ReminderOffsetDays[] = [];
  for (const item of value) {
    if (
      (BILL_REMINDER_OFFSET_OPTIONS as number[]).includes(item as number) &&
      !out.includes(item as ReminderOffsetDays)
    ) {
      out.push(item as ReminderOffsetDays);
    }
  }
  return out;
}

function normalizeBillRecord(bill: Bill): Bill {
  if (!(BILL_KINDS as readonly string[]).includes(bill.kind)) {
    throw new Error(`bill.kind 无效：${String(bill.kind)}`);
  }
  if (!(BILL_CYCLES as readonly string[]).includes(bill.cycle)) {
    throw new Error(`bill.cycle 无效：${String(bill.cycle)}`);
  }
  const status = bill.status ?? "active";
  if (!(BILL_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`bill.status 无效：${String(bill.status)}`);
  }
  if (
    bill.amount !== null &&
    bill.amount !== undefined &&
    (typeof bill.amount !== "number" || !Number.isFinite(bill.amount))
  ) {
    throw new Error("bill.amount 必须是有限数字或 null");
  }
  const nextDueAt = finiteNumberOrDefault(bill.nextDueAt, 0, "bill.nextDueAt");
  const remindedRaw = bill.remindedFor;
  const remindedFor =
    remindedRaw &&
    typeof remindedRaw === "object" &&
    typeof remindedRaw.dueAt === "number" &&
    remindedRaw.dueAt === nextDueAt
      ? { dueAt: nextDueAt, offsets: normalizeReminderOffsets(remindedRaw.offsets) }
      : { dueAt: nextDueAt, offsets: [] as ReminderOffsetDays[] };
  const history = dedupeById<BillPaymentEvent>(bill.history)
    .map((ev) => ({
      id: ev.id,
      periodDueAt: finiteNumberOrDefault(ev.periodDueAt, 0, "bill.history.periodDueAt"),
      amount: finiteNumberOrDefault(ev.amount, 0, "bill.history.amount"),
      paidAt: finiteNumberOrDefault(ev.paidAt, 0, "bill.history.paidAt"),
      method: ev.method === "manual" ? ("manual" as const) : ("auto" as const),
    }))
    .slice(-BILL_HISTORY_MAX);
  return {
    ...bill,
    name: typeof bill.name === "string" ? bill.name : "",
    fallbackColor:
      typeof bill.fallbackColor === "string" && bill.fallbackColor
        ? bill.fallbackColor
        : billFallbackColor(typeof bill.name === "string" ? bill.name : ""),
    amount: bill.amount ?? null,
    nextDueAt,
    status,
    reminderOffsets: normalizeReminderOffsets(bill.reminderOffsets),
    remindedFor,
    history,
    createdAt: finiteNumberOrDefault(bill.createdAt, 0, "bill.createdAt"),
  };
}

/** Zustand persist v1-v18 向前迁移；未知字段保留，旧版本重复记录按首项去重。 */
export function migratePersistedState(
  persisted: unknown,
  version: number
): Partial<NotesState> {
  if (version > STORE_VERSION) {
    throw new Error(`store schema ${version} 高于当前支持的 ${STORE_VERSION}`);
  }
  if (persisted !== undefined && persisted !== null && (typeof persisted !== "object" || Array.isArray(persisted))) {
    throw new Error("持久化 state 必须是对象");
  }
  const p = (persisted && typeof persisted === "object"
    ? { ...(persisted as Partial<NotesState>) }
    : {}) as Partial<NotesState>;
  for (const key of ["sections", "notes", "taskSections", "tasks", "bills"] as const) {
    if (p[key] !== undefined && !Array.isArray(p[key])) {
      throw new Error(`${key} 必须是数组`);
    }
  }
  if (version >= 9) assertCurrentSchemaHasUniqueIds(p);
  validateSettingsShape(p.settings, version);
  if (
    p.settings &&
    (p.settings as unknown as Record<string, unknown>).clipCardTemplate === "banner"
  ) {
    p.settings = { ...p.settings, clipCardTemplate: "condensed" };
  }
  if (version < 5 && p.settings?.companionApps) {
    p.settings = {
      ...p.settings,
      companionApps: [
        ...new Set([...DEFAULT_COMPANION_APPS, ...p.settings.companionApps]),
      ],
    };
  }
  if (version < 6 && p.settings) {
    p.settings = {
      ...p.settings,
      excludedApps: [
        ...new Set([
          ...DEFAULT_EXCLUDED_APPS,
          ...(p.settings.excludedApps ?? []),
        ]),
      ],
    };
  }
  if (version < 7 && p.settings?.promptSnippets) {
    const fresh = DEFAULT_PROMPT_SNIPPETS.find((item) => item.id === "optimize-prompt");
    if (fresh && !p.settings.promptSnippets.some((snippet) => snippet.id === fresh.id)) {
      p.settings = {
        ...p.settings,
        promptSnippets: [...p.settings.promptSnippets, fresh],
      };
    }
  }
  if (version < 9 && p.settings) {
    const legacyAutoEnter = p.settings.autoEnter === true;
    p.settings = {
      ...p.settings,
      // 保留字段仅为旧备份兼容；实际发送从 v9 起只读取 Profile。
      autoEnter: false,
      promptGroups: createDefaultPromptGroups(),
      promptSnippets: migrateLegacyPromptSnippets(
        p.settings.promptSnippets ?? DEFAULT_PROMPT_SNIPPETS
      ),
      targetProfiles: createDefaultTargetProfiles(legacyAutoEnter),
      defaultTargetProfileId: SAFETY_PROFILE_ID,
    };
  }
  if (version < 10 && p.settings) {
    p.settings = {
      ...p.settings,
      firewallEnabled: true,
      firewallDisabledWarnCategories: [],
    };
  }
  if (version < 13 && p.settings) {
    p.settings = {
      ...p.settings,
      outcomeMetricsEnabled: true,
      outcomeRetentionDays: 30,
      outcomeMetricsEpoch: 0,
      outcomeBaselines: [],
      outcomeProblemSessions: [],
    };
  }
  if (version < 14 && p.settings) {
    p.settings = {
      ...p.settings,
      onboarding: onboardingStateFromPersisted(p.settings.onboarding),
    };
  }
  if (version < 15 && p.settings) {
    p.settings = {
      ...p.settings,
      // 词典为空时功能天然惰性，开关默认开启不改变旧用户任何可见行为
      aliasEntitiesEnabled: true,
      aliasEntities: [],
      aliasCustomCategories: [],
      aliasNextNumberByCategory: {},
      aliasAutoRestoreOnCapture: true,
    };
  }
  if (version < 17) {
    // v16 及更早的数据都属于既有用户：迁移时直接标记已处理，绝不能因升级
    // 强制打开面板或改写其伴随偏好。没有 settings 的旧 envelope 也同样保护。
    p.settings = {
      ...(p.settings ?? {}),
      initialPanelSetupDone: true,
    } as Settings;
  }
  if (version < 18 && p.settings) {
    p.settings = {
      ...p.settings,
      // 秘文默认关闭，不改变旧用户任何可见行为（页签隐藏、捕获不识别）
      secretEnabled: false,
      secretKeys: [],
      secretDefaultKeyId: null,
      secretRevealTimeoutMs: 8000,
    };
  }
  if (version < 19) {
    // v19 新增账单域（订阅/信用卡）：旧数据补空数组与账单相关设置默认值
    p.bills = [];
    p.settings = {
      ...(p.settings ?? {}),
      currencySymbol: "¥",
      billDefaultReminderOffsets: [3, 1],
    } as Settings;
  }
  const sections = dedupeById<Section>(p.sections).map((section) => ({
    ...section,
    name: typeof section.name === "string" ? section.name : "未命名分组",
  }));
  if (!sections.some((section) => section.id === INBOX_ID)) {
    sections.unshift({ id: INBOX_ID, name: "收件箱" });
  }
  const sectionIds = new Set(sections.map((section) => section.id));
  const notes = dedupeById<Note>(p.notes).map((note) =>
    normalizeNoteRecord(note, sectionIds, version >= 16)
  );
  const taskSections = dedupeById<TaskSection>(p.taskSections).map((section) => ({
    ...section,
    name: typeof section.name === "string" ? section.name : "未命名分组",
  }));
  if (!taskSections.some((section) => section.id === TASK_INBOX_ID)) {
    taskSections.unshift({ id: TASK_INBOX_ID, name: "收集箱" });
  }
  const taskSectionIds = new Set(taskSections.map((section) => section.id));
  const tasks = dedupeById<Task>(p.tasks).map((task) =>
    normalizeTaskRecord(task, taskSectionIds)
  );
  const bills = dedupeById<Bill>(p.bills).map((bill) => normalizeBillRecord(bill));
  return { ...p, sections, notes, taskSections, tasks, bills };
}

function normalizedPersistentState(
  persisted: Partial<NotesState>
): PersistentNotesState {
  const mergedSettings = {
    ...defaultSettings(),
    ...(persisted.settings ?? {}),
    onboarding: onboardingStateFromPersisted(persisted.settings?.onboarding),
    pageOrder: normalizePageOrder(persisted.settings?.pageOrder),
    contextMenu: normalizeContextMenu(persisted.settings?.contextMenu),
  };
  const settings = repairSettingsTargetProfiles(mergedSettings);
  return {
    sections: persisted.sections?.length ? persisted.sections : defaultSections(),
    notes: persisted.notes ?? [],
    tasks: persisted.tasks ?? [],
    taskSections: persisted.taskSections?.length
      ? persisted.taskSections
      : defaultTaskSections(),
    bills: persisted.bills ?? [],
    settings,
  };
}

export function decodePersistedState(raw: string): PersistentNotesState {
  const envelope: unknown = JSON.parse(raw);
  if (!envelope || typeof envelope !== "object") {
    throw new Error("持久化 envelope 无效");
  }
  const version = (envelope as { version?: unknown }).version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("持久化 envelope 缺少整数 version");
  }
  const migrated = migratePersistedState(
    (envelope as { state?: unknown }).state,
    version
  );
  return normalizedPersistentState(migrated);
}

/**
 * persist merge：Zustand 只在 version 变化时调用 migrate；同版本备份也可能
 * 缺字段，merge 每次都走同一 decoder，保证重启后仍得到稳定默认值并拒绝坏
 * 类型。水合完成前已捕获的新卡片保留在列表顶部——收件箱最新在上，且这些
 * 卡片必然比磁盘上的所有记录都新。
 */
export function mergePersistedNotesState(
  persisted: unknown,
  current: NotesState
): NotesState {
  const migrated = migratePersistedState(persisted, STORE_VERSION);
  const p = normalizedPersistentState(migrated);
  const merged = { ...current, ...p };
  if (!merged.sections?.length) merged.sections = defaultSections();
  if (!merged.taskSections?.length) merged.taskSections = defaultTaskSections();
  // settings 深合并：老版本数据缺新字段时回填默认值
  merged.settings = repairSettingsTargetProfiles({
    ...defaultSettings(),
    ...(p.settings ?? {}),
    onboarding: onboardingStateFromPersisted(p.settings?.onboarding),
    // 页签顺序单独归一化：缺项/重复/未知值都会让整页无法访问
    pageOrder: normalizePageOrder(p.settings?.pageOrder),
  });
  const persistedIds = new Set(merged.notes.map((n) => n.id));
  const early = current.notes.filter((n) => !persistedIds.has(n.id));
  if (early.length) merged.notes = [...early, ...merged.notes];
  return merged;
}

export function persistentStateOf(state: NotesState): PersistentNotesState {
  return {
    sections: state.sections,
    notes: state.notes,
    tasks: state.tasks,
    taskSections: state.taskSections,
    bills: state.bills,
    settings: state.settings,
  };
}

export function serializePersistentState(state: NotesState): string {
  return JSON.stringify({ state: persistentStateOf(state), version: STORE_VERSION });
}

type AddNoteContentOptions = {
  contentBlocks?: NoteContentBlock[];
  imageFile?: string;
  attachments?: string[];
  imageW?: number;
  imageH?: number;
};

function contentBlocksForAdd(
  text: string,
  opts: AddNoteContentOptions | undefined
): NoteContentBlock[] {
  if (opts?.contentBlocks !== undefined) {
    return normalizeNoteContentBlocks(opts.contentBlocks);
  }
  const blocks: NoteContentBlock[] = [];
  const trimmed = text.trim();
  if (trimmed) blocks.push({ type: "text", text: trimmed });
  const files = [opts?.imageFile, ...(opts?.attachments ?? [])].filter(
    (file): file is string => typeof file === "string" && !!file
  );
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    const main = file === opts?.imageFile;
    blocks.push({
      type: "image",
      file,
      ...(main && opts?.imageW !== undefined ? { width: opts.imageW } : {}),
      ...(main && opts?.imageH !== undefined ? { height: opts.imageH } : {}),
    });
  }
  return normalizeNoteContentBlocks(blocks);
}

/** 剪贴记录按来源时间降序插入，异步图片本地化完成顺序不影响原始顺序。 */
function insertClipboardNoteByTime(notes: Note[], note: Note): Note[] {
  const before = notes.findIndex(
    (item) => item.sectionId === CLIPBOARD_ID && item.createdAt <= note.createdAt
  );
  if (before >= 0) return [...notes.slice(0, before), note, ...notes.slice(before)];
  let last = -1;
  notes.forEach((item, index) => {
    if (item.sectionId === CLIPBOARD_ID) last = index;
  });
  if (last >= 0) return [...notes.slice(0, last + 1), note, ...notes.slice(last + 1)];
  return [note, ...notes];
}

export const useNotesStore = create<NotesState>()(
  persist(
    (set, get) => ({
      sections: defaultSections(),
      notes: [],
      tasks: [],
      taskSections: defaultTaskSections(),
      bills: [],
      checkedIds: [],
      settings: defaultSettings(),
      undoStack: [],

      addNote: (text, opts) => {
        const blocks = contentBlocksForAdd(text, opts);
        const content = projectNoteContent(blocks);
        const trimmed = content.text.trim();
        if (!trimmed && content.imageFiles.length === 0) return { result: "empty" };
        const createdAt = finiteNumberOrDefault(
          opts?.createdAt,
          Date.now(),
          "note.createdAt"
        );
        // 去重（覆盖已完成卡片，避免发送后再捕获同一内容又新建）：
        // - 文本：内容完全相同；图片：附件哈希文件名相同（像素内容哈希命名）
        // - 只在目标域内查重：剪贴板历史与笔记互不冲突——复制过的内容
        //   仍可捕获为笔记（转正意图），捕获过的内容复制时也照常记录历史
        const targetClip = opts?.sectionId === CLIPBOARD_ID;
        const inScope = (n: Note) =>
          (n.sectionId === CLIPBOARD_ID) === targetClip;
        const primaryImage = content.imageFile;
        const dup = opts?.contentBlocks !== undefined
          ? get().notes.find(
              (n) =>
                inScope(n) &&
                JSON.stringify(noteContentBlocks(n)) === JSON.stringify(blocks)
            )
          : opts?.kind === "image"
            ? primaryImage
              ? get().notes.find((n) => inScope(n) && n.imageFile === primaryImage)
              : undefined
            : opts?.attachments?.length || opts?.imageFile
              ? // 图文组合卡：同文不同图是合法新卡，不按文本查重
                undefined
              : get().notes.find(
                  (n) => inScope(n) && n.kind !== "image" && n.text === trimmed
                );
        if (dup) return { result: "duplicate", id: dup.id };

        const sections = get().sections;
        // 默认落点绝不能是剪贴板历史组：分组排序可能把隐藏的剪贴板组顶到
        // 首位，导致双击捕获「消失」进剪贴页（现网踩坑 2026-08）
        const sectionId =
          opts?.sectionId && sections.some((s) => s.id === opts.sectionId)
            ? opts.sectionId
            : (sections.find((s) => s.id !== CLIPBOARD_ID)?.id ?? INBOX_ID);
        const note: Note = {
          id: crypto.randomUUID(),
          ...noteContentPatch(blocks),
          sectionId,
          done: false,
          createdAt,
          sourceApp: opts?.sourceApp,
          sourceBundle: opts?.sourceBundle,
          kind:
            opts?.kind ??
            (content.imageFiles.length > 0
              ? trimmed
                ? "text"
                : "image"
              : detectLink(trimmed)
                ? "link"
                : "text"),
          url:
            opts?.kind === "image" || content.imageFiles.length > 0
              ? undefined
              : detectLink(trimmed),
          codeLang:
            opts?.kind === "image" ||
            content.imageFiles.length > 0 ||
            detectLink(trimmed)
              ? undefined
              : detectCode(trimmed),
        };
        // 最新的卡片置顶（收件箱语义：新内容在最上面）
        set({
          notes: targetClip
            ? insertClipboardNoteByTime(get().notes, note)
            : [note, ...get().notes],
        });
        return { result: "added", id: note.id };
      },

      addClipNote: (text, opts) => {
        // 首次收集自动建组，插在收件箱之后（首位是 addNote 的默认落点，不占用）
        if (!get().sections.some((s) => s.id === CLIPBOARD_ID)) {
          const [first, ...rest] = get().sections;
          const clip: Section = { id: CLIPBOARD_ID, name: "剪贴板" };
          set({ sections: first ? [first, clip, ...rest] : [clip] });
        }
        // 数量不设上限：历史规模由「保留时长」滑杆与手动删除历史控制
        const res = get().addNote(text, { ...opts, sectionId: CLIPBOARD_ID });
        // 重复复制＝再次使用：把已有卡提升到历史最新（Paste 行为），
        // 刷新时间与来源。否则重复内容毫无可见反馈，像「没收集到」
        if (res.result === "duplicate" && res.id) {
          const notes = get().notes;
          const idx = notes.findIndex((n) => n.id === res.id);
          if (idx >= 0) {
            const existing = notes[idx];
            const bumpedAt = finiteNumberOrDefault(
              opts?.createdAt,
              Date.now(),
              "note.createdAt"
            );
            // 手势：短窗内二次复制同一内容 = 用户明显想留住它 → 自动置顶。
            // 新旧时间戳此处现成可比；调用方凭 autoKept 弹可撤销气泡
            const autoKeep =
              get().settings.clipDoubleCopyKeep &&
              !existing.keep &&
              bumpedAt - existing.createdAt <= CLIP_DOUBLE_COPY_KEEP_WINDOW_MS &&
              bumpedAt >= existing.createdAt;
            const bumped: Note = {
              ...existing,
              createdAt: bumpedAt,
              sourceApp: opts?.sourceApp ?? existing.sourceApp,
              sourceBundle: opts?.sourceBundle ?? existing.sourceBundle,
              ...(autoKeep ? { keep: true } : {}),
            };
            set({ notes: insertClipboardNoteByTime(
              notes.filter((n) => n.id !== res.id),
              bumped
            ) });
            if (autoKeep) {
              const trimmed = existing.text.trim();
              const preview = trimmed
                ? [...trimmed].slice(0, 20).join("")
                : "图片";
              return { orphanImages: [], autoKept: { id: existing.id, preview } };
            }
          }
        }
        return { orphanImages: [] };
      },

      addSecretNote: (envelope, meta, opts) => {
        const trimmed = envelope.trim();
        if (!trimmed) return { result: "empty" };
        // 首次收发自动建「秘文」分组，插在收件箱之后（与剪贴板同款）
        if (!get().sections.some((s) => s.id === SECRET_ID)) {
          const [first, ...rest] = get().sections;
          const sec: Section = { id: SECRET_ID, name: "秘文" };
          set({ sections: first ? [first, sec, ...rest] : [sec] });
        }
        // 去重：同一中文密文信封重复捕获（域=秘文组）视为重复
        const dup = get().notes.find(
          (n) => n.sectionId === SECRET_ID && n.text === trimmed
        );
        if (dup) return { result: "duplicate", id: dup.id };
        const note: Note = {
          id: crypto.randomUUID(),
          ...noteContentPatch(contentBlocksForAdd(trimmed, undefined)),
          kind: "secret",
          sectionId: SECRET_ID,
          done: false,
          createdAt: finiteNumberOrDefault(
            opts?.createdAt,
            Date.now(),
            "note.createdAt"
          ),
          sourceApp: opts?.sourceApp,
          sourceBundle: opts?.sourceBundle,
          secretMeta: meta,
        };
        set({ notes: [note, ...get().notes] });
        return { result: "added", id: note.id };
      },

      setSecretMeta: (id, meta) => {
        set({
          notes: get().notes.map((n) =>
            n.id === id && n.kind === "secret"
              ? {
                  ...n,
                  secretMeta: {
                    ...(n.secretMeta ?? { keyId: null, direction: "in" }),
                    ...meta,
                  },
                }
              : n
          ),
        });
      },

      clearClipHistory: () => {
        const targets = get().notes.filter(
          (n) => n.sectionId === CLIPBOARD_ID && !n.keep
        );
        if (!targets.length) return { removed: 0, orphanImages: [] };
        get().snapshot(`清空剪贴板历史 ${targets.length} 条`);
        const drop = new Set(targets.map((n) => n.id));
        const survivors = get().notes.filter((n) => !drop.has(n.id));
        const stillUsed = new Set(survivors.flatMap(noteImages));
        set({
          notes: survivors,
          checkedIds: get().checkedIds.filter((id) => !drop.has(id)),
        });
        return {
          removed: targets.length,
          orphanImages: [...new Set(targets.flatMap(noteImages))].filter(
            (f) => !stillUsed.has(f)
          ),
        };
      },

      pruneClipHistory: () => {
        const days = get().settings.clipRetentionDays;
        if (!days) return [];
        const cutoff = Date.now() - days * 86_400_000;
        const evicted = get().notes.filter(
          (n) => n.sectionId === CLIPBOARD_ID && !n.keep && n.createdAt < cutoff
        );
        if (!evicted.length) return [];
        const drop = new Set(evicted.map((n) => n.id));
        const survivors = get().notes.filter((n) => !drop.has(n.id));
        const stillUsed = new Set(survivors.flatMap(noteImages));
        set({
          notes: survivors,
          checkedIds: get().checkedIds.filter((id) => !drop.has(id)),
        });
        return [...new Set(evicted.flatMap(noteImages))].filter(
          (f) => !stillUsed.has(f)
        );
      },

      updateNoteText: (id, text, imageFiles) => {
        const trimmed = text.trim();
        const editedAt = Date.now();
        set({
          notes: get().notes.map((n) => {
            if (n.id !== id) return n;
            const replacesImages = imageFiles !== undefined;
            const currentBlocks = noteContentBlocks(n);
            const files = replacesImages
              ? [...new Set(imageFiles.filter(Boolean))]
              : noteImages(n);
            const hasImages = files.length > 0;
            // 空文本：纯文本卡回退旧值（防误清空成无内容卡）；带图卡的文字
            // 只是备注，允许清空（图片本身就是内容）
            const t = trimmed || (hasImages ? "" : n.text);
            const blocks = replaceNoteTextProjection(currentBlocks, t, imageFiles);
            const contentPatch = noteContentPatch(blocks);
            const normalized = normalizeNoteContent(contentPatch.text, hasImages);
            if (normalized.url) {
              // 编辑为/仍为纯链接：URL 变化时清掉旧简介，等待重抓
              const same = normalized.url === n.url;
              return {
                ...n,
                ...contentPatch,
                kind: "link" as const,
                url: normalized.url,
                codeLang: undefined,
                linkTitle: same ? n.linkTitle : undefined,
                linkIcon: same ? n.linkIcon : undefined,
                updatedAt: editedAt,
              };
            }
            return {
              ...n,
              ...contentPatch,
              kind: replacesImages
                ? normalized.kind
                : n.kind === "link"
                  ? ("text" as const)
                  : n.kind,
              url: undefined,
              linkTitle: undefined,
              linkIcon: undefined,
              codeLang: normalized.codeLang ?? undefined,
              updatedAt: editedAt,
            };
          }),
        });
      },

      updateNoteContent: (id, blocks) => {
        const contentPatch = noteContentPatch(blocks);
        const hasImages = !!contentPatch.imageFile;
        if (!contentPatch.text.trim() && !hasImages) return;
        const normalized = normalizeNoteContent(contentPatch.text, hasImages);
        set({
          notes: get().notes.map((note) => {
            if (note.id !== id) return note;
            const sameUrl = normalized.url === note.url;
            return {
              ...note,
              ...contentPatch,
              kind: normalized.kind,
              url: normalized.url ?? undefined,
              codeLang: normalized.codeLang ?? undefined,
              linkTitle: sameUrl ? note.linkTitle : undefined,
              linkIcon: sameUrl ? note.linkIcon : undefined,
              updatedAt: Date.now(),
            };
          }),
        });
      },

      removeNoteImage: (id, file) => {
        const note = get().notes.find((n) => n.id === id);
        if (!note || !noteImages(note).includes(file)) {
          return { noteDeleted: false };
        }
        const nextBlocks = noteContentBlocks(note).filter(
          (block) => block.type !== "image" || block.file !== file
        );
        const nextContent = noteContentPatch(nextBlocks);
        const rest = nextContent.imageFile
          ? [nextContent.imageFile, ...(nextContent.attachments ?? [])]
          : [];
        get().snapshot("移除图片");
        if (!rest.length) {
          // 一张不剩：还有真实文字就退化为纯文本卡，否则整张卡没内容了 → 删除
          if (imageCaption(note)) {
            set({
              notes: get().notes.map((n) =>
                n.id === id
                  ? {
                      ...n,
                      ...nextContent,
                      kind: "text" as const,
                      updatedAt: Date.now(),
                    }
                  : n
              ),
            });
            return { noteDeleted: false };
          }
          set({
            notes: get().notes.filter((n) => n.id !== id),
            checkedIds: get().checkedIds.filter((c) => c !== id),
          });
          return { noteDeleted: true };
        }
        // 主图被移除时由后续首个图片块顶上；每个块自己的尺寸元数据跟图走。
        set({
          notes: get().notes.map((n) =>
            n.id === id
              ? {
                  ...n,
                  ...nextContent,
                  updatedAt: Date.now(),
                }
              : n
          ),
        });
        return { noteDeleted: false };
      },

      updateNoteTitle: (id, title) => {
        const trimmed = title.trim();
        set({
          notes: get().notes.map((n) =>
            n.id === id && n.title !== (trimmed || undefined)
              ? { ...n, title: trimmed || undefined, updatedAt: Date.now() }
              : n
          ),
        });
      },

      setNoteTags: (id, tags) => {
        set({
          notes: get().notes.map((n) =>
            n.id === id ? { ...n, tags: sanitizeNoteTags(tags) } : n
          ),
        });
      },

      addNoteTags: (ids, tags) => {
        if (!ids.length || !tags.length) return;
        const target = new Set(ids);
        set({
          notes: get().notes.map((n) =>
            target.has(n.id)
              ? { ...n, tags: sanitizeNoteTags([...(n.tags ?? []), ...tags]) }
              : n
          ),
        });
      },

      setNoteProvenance: (id, provenance) => {
        const notes = get().notes;
        const index = notes.findIndex((note) => note.id === id);
        if (index < 0) return false;
        const normalized = normalizeNoteProvenance(provenance);
        if (
          JSON.stringify(notes[index].provenance) === JSON.stringify(normalized)
        ) return true;
        const next = [...notes];
        next[index] = { ...notes[index], provenance: normalized };
        set({ notes: next });
        return true;
      },

      setLinkMeta: (id, meta) => {
        set({
          notes: get().notes.map((n) =>
            n.id === id && n.kind === "link"
              ? {
                  ...n,
                  linkTitle: meta.title ?? n.linkTitle,
                  linkIcon: meta.icon ?? n.linkIcon,
                }
              : n
          ),
        });
      },

      deleteNotes: (ids, undoLabel) => {
        if (!ids.length) return;
        get().snapshot(undoLabel ?? `删除 ${ids.length} 条`);
        const drop = new Set(ids);
        set({
          notes: get().notes.filter((n) => !drop.has(n.id)),
          checkedIds: get().checkedIds.filter((id) => !drop.has(id)),
        });
      },

      setDone: (ids, done) => {
        const target = new Set(ids);
        set({
          notes: get().notes.map((n) => (target.has(n.id) ? { ...n, done } : n)),
        });
      },

      toggleDone: (id) => {
        set({
          notes: get().notes.map((n) => (n.id === id ? { ...n, done: !n.done } : n)),
        });
      },

      toggleNoteKeep: (id) => {
        set({
          notes: get().notes.map((n) =>
            n.id === id ? { ...n, keep: !n.keep } : n
          ),
        });
      },

      toggleSectionKeep: (id) => {
        set({
          sections: get().sections.map((s) =>
            s.id === id ? { ...s, keepAfterSend: !s.keepAfterSend } : s
          ),
        });
      },

      clearDone: () => {
        const doneNotes = get().notes.filter((n) => n.done);
        if (!doneNotes.length) return 0;
        get().snapshot(`清理已完成 ${doneNotes.length} 条`);
        set({
          notes: get().notes.filter((n) => !n.done),
          checkedIds: get().checkedIds.filter(
            (id) => !doneNotes.some((n) => n.id === id)
          ),
        });
        return doneNotes.length;
      },

      toggleChecked: (id) => {
        const checked = get().checkedIds;
        set({
          checkedIds: checked.includes(id)
            ? checked.filter((c) => c !== id)
            : [...checked, id],
        });
      },

      setChecked: (ids) => set({ checkedIds: ids }),
      clearChecked: () => set({ checkedIds: [] }),

      mergeNotes: (ids) => {
        if (ids.length < 2) return;
        const pick = new Set(ids);
        const notes = get().notes;
        const ordered = notes.filter((n) => pick.has(n.id));
        if (ordered.length < 2) return;
        get().snapshot(`合并 ${ordered.length} 条`);

        // 列表新卡置顶，合并内容按列表底→顶（＝捕获先后）拼接：连续复制的
        // 有序内容合并后保持原始阅读顺序；合并卡位置与身份仍留在最上面那张。
        const sources = [...ordered].reverse();
        // 各来源卡的块保持原有文档顺序；图片卡自动占位文字不是真实正文，
        // 合并时仍剔除。不同来源的正文兼容投影维持旧版空行分隔语义。
        const sourceBlocks = sources.map((note) => {
          const keepText = note.kind !== "image" || imageCaption(note).length > 0;
          return noteContentBlocks(note).filter(
            (block) => keepText || block.type !== "text"
          );
        });
        const textSourceIndexes = sourceBlocks.flatMap((blocks, index) =>
          blocks.some((block) => block.type === "text") ? [index] : []
        );
        const lastTextSource = textSourceIndexes.at(-1);
        let mergedBlocks = sourceBlocks.flatMap((blocks, index) =>
          lastTextSource !== undefined &&
          index !== lastTextSource &&
          blocks.some((block) => block.type === "text")
            ? [...blocks, { type: "text", text: "\n\n" } satisfies NoteContentBlock]
            : blocks
        );
        const hasRichLayout = sources.some(
          (note, index) =>
            JSON.stringify(sourceBlocks[index]) !==
            JSON.stringify(
              noteContentBlocks({ ...note, contentBlocks: undefined }).filter(
                (block) =>
                  note.kind !== "image" ||
                  imageCaption(note).length > 0 ||
                  block.type !== "text"
              )
            )
        );
        if (!hasRichLayout) {
          // 旧组合卡只为首个来源卡（按合并内容序）的主图保留宽高；其余附件
          // 从未持久化尺寸。保持该兼容行为，富文档布局则保留每个图片块自己的元数据。
          let firstImage = true;
          const legacyDimensionFile = sources[0].imageFile;
          mergedBlocks = mergedBlocks.map((block) => {
            if (block.type !== "image") return block;
            const keepDimensions = firstImage && block.file === legacyDimensionFile;
            firstImage = false;
            if (keepDimensions) return block;
            const { width: _width, height: _height, ...withoutDimensions } = block;
            return withoutDimensions;
          });
        }
        const mergedContent = noteContentPatch(mergedBlocks);
        const images = [
          mergedContent.imageFile,
          ...(mergedContent.attachments ?? []),
        ].filter((file): file is string => !!file);
        const textParts = sources
          .filter((n) => n.kind !== "image" || imageCaption(n).length > 0)
          .map((n) => n.text);
        const first = ordered[0];
        const mergedTags = sanitizeNoteTags(
          sources.flatMap((n) => n.tags ?? [])
        );
        const mergedText = textParts.length
          ? mergedContent.text
          : `图片 ${images.length} 张`;
        // 纯图片卡继续保留旧占位投影；占位也写入块，避免兼容字段成为第二真源。
        const content = textParts.length
          ? mergedContent
          : noteContentPatch([
              { type: "text", text: mergedText },
              ...mergedBlocks,
            ]);
        // 剪贴板域=历史记录，合并不消费原卡：产出一张新组合卡置顶
        if (ordered.every((n) => n.sectionId === CLIPBOARD_ID)) {
          const combo: Note = {
            id: crypto.randomUUID(),
            ...content,
            sectionId: CLIPBOARD_ID,
            done: false,
            createdAt: Date.now(),
            kind: textParts.length ? "text" : "image",
            codeLang: textParts.length ? detectCode(mergedText) : undefined,
            tags: mergedTags,
          };
          set({ notes: [combo, ...notes], checkedIds: [combo.id] });
          return;
        }
        const merged: Note = {
          ...first,
          ...content,
          kind: textParts.length ? "text" : "image",
          codeLang: textParts.length ? detectCode(mergedText) : undefined,
          url: undefined,
          tags: mergedTags,
          updatedAt: Date.now(),
        };
        const rest = new Set(ordered.slice(1).map((n) => n.id));
        set({
          notes: notes
            .filter((n) => !rest.has(n.id))
            .map((n) => (n.id === first.id ? merged : n)),
          checkedIds: [first.id],
        });
      },

      moveNotes: (ids, sectionId) => {
        if (!get().sections.some((s) => s.id === sectionId)) return;
        const target = new Set(ids);
        set({
          notes: get().notes.map((n) =>
            target.has(n.id) ? { ...n, sectionId } : n
          ),
        });
      },

      reorderNotes: (activeId, overId) => {
        const notes = [...get().notes];
        const from = notes.findIndex((n) => n.id === activeId);
        const to = notes.findIndex((n) => n.id === overId);
        if (from < 0 || to < 0 || from === to) return;
        const [moved] = notes.splice(from, 1);
        notes.splice(to, 0, moved);
        set({ notes });
      },

      addSection: (name) => {
        const sections = get().sections;
        const finalName = name?.trim() || `新分组 ${sections.length}`;
        set({
          sections: [...sections, { id: crypto.randomUUID(), name: finalName }],
        });
      },

      renameSection: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set({
          sections: get().sections.map((s) => (s.id === id ? { ...s, name: trimmed } : s)),
        });
      },

      setSectionColor: (id, color) => {
        set({
          sections: get().sections.map((s) => (s.id === id ? { ...s, color } : s)),
        });
      },

      deleteSection: (id) => {
        if (id === INBOX_ID) return;
        get().snapshot("删除分组");
        set({
          sections: get().sections.filter((s) => s.id !== id),
          notes: get().notes.map((n) => (n.sectionId === id ? { ...n, sectionId: INBOX_ID } : n)),
        });
      },

      moveSection: (id, dir) => {
        const sections = [...get().sections];
        const from = sections.findIndex((s) => s.id === id);
        if (from < 0) return;
        // 剪贴板历史组在笔记页不可见：相邻交换必须跳过它，
        // 否则出现「按了上/下移但看不见变化」的隐形换位
        let to = from + dir;
        while (sections[to]?.id === CLIPBOARD_ID) to += dir;
        if (to < 0 || to >= sections.length) return;
        const [moved] = sections.splice(from, 1);
        sections.splice(to, 0, moved);
        set({ sections });
      },

      reorderSections: (activeId, overId) => {
        const sections = [...get().sections];
        const from = sections.findIndex((s) => s.id === activeId);
        const to = sections.findIndex((s) => s.id === overId);
        if (from < 0 || to < 0 || from === to) return;
        const [moved] = sections.splice(from, 1);
        sections.splice(to, 0, moved);
        set({ sections });
      },

      toggleSectionCollapsed: (id) => {
        set({
          sections: get().sections.map((s) =>
            s.id === id ? { ...s, collapsed: !s.collapsed } : s
          ),
        });
      },

      // ===== 任务 =====

      addTask: (text, opts) => {
        const trimmed = text.trim();
        if (!trimmed) return { result: "empty" };
        // 刻意不去重：同一句待办（如「回复邮件」）重复出现是正常需求
        const task: Task = {
          id: crypto.randomUUID(),
          text: trimmed,
          status: "todo",
          priority: "none",
          dueAt: null,
          createdAt: Date.now(),
          remindedAt: null,
          kind: opts?.kind,
          sectionId:
            opts?.sectionId &&
            get().taskSections.some((s) => s.id === opts.sectionId)
              ? opts.sectionId
              : undefined,
        };
        set({ tasks: [task, ...get().tasks] });
        return { result: "added", id: task.id };
      },

      sparkToTask: (id) => {
        set({
          tasks: get().tasks.map((t) =>
            t.id === id && t.kind === "spark"
              ? { ...t, kind: undefined, status: "todo" }
              : t
          ),
        });
      },

      moveTasksToSection: (ids, sectionId) => {
        if (!get().taskSections.some((s) => s.id === sectionId)) return;
        const picked = new Set(ids);
        set({
          tasks: get().tasks.map((t) =>
            picked.has(t.id)
              ? { ...t, sectionId: sectionId === TASK_INBOX_ID ? undefined : sectionId }
              : t
          ),
        });
      },

      reorderTasks: (activeId, overId) => {
        const tasks = [...get().tasks];
        const from = tasks.findIndex((t) => t.id === activeId);
        const to = tasks.findIndex((t) => t.id === overId);
        if (from < 0 || to < 0 || from === to) return;
        const [moved] = tasks.splice(from, 1);
        tasks.splice(to, 0, moved);
        set({ tasks });
      },

      addTaskSection: (name) => {
        const section: TaskSection = {
          id: crypto.randomUUID(),
          name: name?.trim() || `分组 ${get().taskSections.length}`,
        };
        set({ taskSections: [...get().taskSections, section] });
      },

      renameTaskSection: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set({
          taskSections: get().taskSections.map((s) =>
            s.id === id ? { ...s, name: trimmed } : s
          ),
        });
      },

      deleteTaskSection: (id) => {
        if (id === TASK_INBOX_ID) return;
        get().snapshot("删除任务分组");
        set({
          taskSections: get().taskSections.filter((s) => s.id !== id),
          tasks: get().tasks.map((t) =>
            t.sectionId === id ? { ...t, sectionId: undefined } : t
          ),
        });
      },

      moveTaskSection: (id, dir) => {
        const list = [...get().taskSections];
        const from = list.findIndex((s) => s.id === id);
        const to = from + dir;
        if (from < 0 || to < 0 || to >= list.length) return;
        const [moved] = list.splice(from, 1);
        list.splice(to, 0, moved);
        set({ taskSections: list });
      },

      toggleTaskSectionCollapsed: (id) => {
        set({
          taskSections: get().taskSections.map((s) =>
            s.id === id ? { ...s, collapsed: !s.collapsed } : s
          ),
        });
      },

      updateTaskText: (id, text) => {
        const trimmed = text.trim();
        set({
          tasks: get().tasks.map((t) =>
            t.id === id ? { ...t, text: trimmed || t.text } : t
          ),
        });
      },

      cycleTaskStatus: (id) => {
        const next: Record<TaskStatus, TaskStatus> = {
          todo: "doing",
          doing: "done",
          done: "todo",
        };
        set({
          tasks: get().tasks.map((t) =>
            t.id === id ? { ...t, status: next[t.status] } : t
          ),
        });
      },

      toggleTaskDone: (id) => {
        set({
          tasks: get().tasks.map((t) =>
            t.id === id
              ? { ...t, status: t.status === "done" ? "todo" : "done" }
              : t
          ),
        });
      },

      setTaskStatus: (id, status) => {
        set({
          tasks: get().tasks.map((t) => (t.id === id ? { ...t, status } : t)),
        });
      },

      setTaskPriority: (id, priority) => {
        set({
          tasks: get().tasks.map((t) => (t.id === id ? { ...t, priority } : t)),
        });
      },

      cycleTaskPriority: (id) => {
        const next: Record<TaskPriority, TaskPriority> = {
          none: "low",
          low: "mid",
          mid: "high",
          high: "none",
        };
        set({
          tasks: get().tasks.map((t) =>
            t.id === id ? { ...t, priority: next[t.priority] } : t
          ),
        });
      },

      setTaskDue: (id, dueAt) => {
        set({
          tasks: get().tasks.map((t) =>
            t.id === id ? { ...t, dueAt, remindedAt: null } : t
          ),
        });
      },

      markTasksReminded: (ids) => {
        const picked = new Set(ids);
        const at = Date.now();
        set({
          tasks: get().tasks.map((t) =>
            picked.has(t.id) ? { ...t, remindedAt: at } : t
          ),
        });
      },

      updateTaskNote: (id, note) => {
        const trimmed = note.trim();
        set({
          tasks: get().tasks.map((t) =>
            t.id === id ? { ...t, note: trimmed || undefined } : t
          ),
        });
      },

      addChecklistItem: (taskId, text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const item: ChecklistItem = {
          id: crypto.randomUUID(),
          text: trimmed,
          done: false,
        };
        set({
          tasks: get().tasks.map((t) =>
            t.id === taskId
              ? { ...t, checklist: [...(t.checklist ?? []), item] }
              : t
          ),
        });
      },

      toggleChecklistItem: (taskId, itemId) => {
        set({
          tasks: get().tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  checklist: (t.checklist ?? []).map((c) =>
                    c.id === itemId ? { ...c, done: !c.done } : c
                  ),
                }
              : t
          ),
        });
      },

      updateChecklistItem: (taskId, itemId, text) => {
        const trimmed = text.trim();
        set({
          tasks: get().tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  checklist: trimmed
                    ? (t.checklist ?? []).map((c) =>
                        c.id === itemId ? { ...c, text: trimmed } : c
                      )
                    : // 清空文本 = 删除该项（Apple 提醒事项同款）
                      (t.checklist ?? []).filter((c) => c.id !== itemId),
                }
              : t
          ),
        });
      },

      deleteChecklistItem: (taskId, itemId) => {
        set({
          tasks: get().tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  checklist: (t.checklist ?? []).filter((c) => c.id !== itemId),
                }
              : t
          ),
        });
      },

      deleteTasks: (ids, undoLabel) => {
        if (!ids.length) return;
        get().snapshot(undoLabel ?? `删除 ${ids.length} 个任务`);
        const drop = new Set(ids);
        set({ tasks: get().tasks.filter((t) => !drop.has(t.id)) });
      },

      clearDoneTasks: () => {
        const done = get().tasks.filter((t) => t.status === "done");
        if (!done.length) return 0;
        get().snapshot(`清理已完成任务 ${done.length} 个`);
        set({ tasks: get().tasks.filter((t) => t.status !== "done") });
        return done.length;
      },

      convertNoteToTask: (noteId) => {
        const note = get().notes.find((n) => n.id === noteId);
        if (!note) return false;
        // 任务没有图片语义：图片卡与图文组合卡不可转
        if (note.kind === "image" || noteImages(note).length > 0) return false;
        // 必须一次快照 + 一次 set 原子完成，复用 addTask+deleteNotes 会产生
        // 两次快照，撤销只能回滚一半（笔记回来了、任务还在）
        get().snapshot("转为任务");
        const task: Task = {
          id: crypto.randomUUID(),
          text: note.text,
          status: "todo",
          priority: "none",
          dueAt: null,
          createdAt: Date.now(),
          remindedAt: null,
        };
        set({
          tasks: [task, ...get().tasks],
          notes: get().notes.filter((n) => n.id !== noteId),
          checkedIds: get().checkedIds.filter((id) => id !== noteId),
        });
        return true;
      },

      convertNoteToTaskSmart: (noteId, title, checklist) => {
        const note = get().notes.find((n) => n.id === noteId);
        if (!note) return false;
        if (note.kind === "image" || noteImages(note).length > 0) return false;
        get().snapshot("AI 转为任务");
        const items = checklist.map((t) => t.trim()).filter(Boolean);
        const task: Task = {
          id: crypto.randomUUID(),
          text: title.trim() || note.text,
          status: "todo",
          priority: "none",
          dueAt: null,
          createdAt: Date.now(),
          remindedAt: null,
          checklist: items.length
            ? items.map((text) => ({
                id: crypto.randomUUID(),
                text,
                done: false,
              }))
            : undefined,
        };
        set({
          tasks: [task, ...get().tasks],
          notes: get().notes.filter((n) => n.id !== noteId),
          checkedIds: get().checkedIds.filter((id) => id !== noteId),
        });
        return true;
      },

      addBill: (input) => {
        const bill: Bill = {
          id: crypto.randomUUID(),
          kind: input.kind,
          name: input.name.trim(),
          iconFile: input.iconFile,
          fallbackColor: input.fallbackColor,
          amount: input.amount,
          cycle: input.cycle,
          nextDueAt: input.nextDueAt,
          status: "active",
          reminderOffsets:
            input.reminderOffsets ?? [...get().settings.billDefaultReminderOffsets],
          remindedFor: { dueAt: input.nextDueAt, offsets: [] },
          history: [],
          note: input.note,
          createdAt: Date.now(),
          catalogId: input.catalogId,
        };
        set({ bills: [bill, ...get().bills] });
        return bill.id;
      },

      updateBill: (id, patch) => {
        set({
          bills: get().bills.map((b) => {
            if (b.id !== id) return b;
            const next = { ...b, ...patch };
            // 改到期日 = 换账期：当期已提醒档随之作废，对新日期重新提醒
            if (patch.nextDueAt !== undefined && patch.nextDueAt !== b.nextDueAt) {
              next.remindedFor = { dueAt: patch.nextDueAt, offsets: [] };
            }
            return next;
          }),
        });
      },

      deleteBill: (id) => {
        const bill = get().bills.find((b) => b.id === id);
        if (!bill) return;
        get().snapshot(`删除「${bill.name}」`);
        set({ bills: get().bills.filter((b) => b.id !== id) });
      },

      markBillPaid: (id, amount) => {
        set({
          bills: get().bills.map((b) => {
            if (b.id !== id) return b;
            const nextDueAt = advanceCycle(b.nextDueAt, b.cycle);
            const event: BillPaymentEvent = {
              id: crypto.randomUUID(),
              periodDueAt: b.nextDueAt,
              amount,
              paidAt: Date.now(),
              method: "manual",
            };
            return {
              ...b,
              // 本期实付回写为下期默认金额（信用卡每期可变的主路径）
              amount,
              nextDueAt,
              remindedFor: { dueAt: nextDueAt, offsets: [] },
              history: [...b.history, event].slice(-BILL_HISTORY_MAX),
            };
          }),
        });
      },

      rollBillsIfDue: (now) => {
        let changed = false;
        const bills = get().bills.map((b) => {
          if (b.kind !== "subscription" || b.status !== "active") return b;
          if (b.nextDueAt > now) return b;
          changed = true;
          let due = b.nextDueAt;
          const events: BillPaymentEvent[] = [];
          // 应用长期未开可能跨多期；auto 记账 paidAt 用账期本身，入正确历史月份
          while (due <= now) {
            events.push({
              id: crypto.randomUUID(),
              periodDueAt: due,
              amount: b.amount ?? 0,
              paidAt: due,
              method: "auto",
            });
            due = advanceCycle(due, b.cycle);
          }
          return {
            ...b,
            nextDueAt: due,
            remindedFor: { dueAt: due, offsets: [] as ReminderOffsetDays[] },
            history: [...b.history, ...events].slice(-BILL_HISTORY_MAX),
          };
        });
        if (changed) set({ bills });
      },

      markBillsReminded: (hits) => {
        if (!hits.length) return;
        const byBill = new Map<string, ReminderOffsetDays[]>();
        for (const hit of hits) {
          const list = byBill.get(hit.billId) ?? [];
          if (!list.includes(hit.offset)) list.push(hit.offset);
          byBill.set(hit.billId, list);
        }
        set({
          bills: get().bills.map((b) => {
            const offsets = byBill.get(b.id);
            if (!offsets) return b;
            const base =
              b.remindedFor.dueAt === b.nextDueAt ? b.remindedFor.offsets : [];
            return {
              ...b,
              remindedFor: {
                dueAt: b.nextDueAt,
                offsets: [...new Set([...base, ...offsets])],
              },
            };
          }),
        });
      },

      setSettings: (patch) =>
        set({
          settings: repairSettingsTargetProfiles({
            ...get().settings,
            ...patch,
          }),
        }),

      markOnboarding: (patch) => {
        const current = onboardingStateFromPersisted(get().settings.onboarding);
        const next = onboardingStateFromPersisted({ ...current, ...patch });
        set({ settings: { ...get().settings, onboarding: next } });
      },

      transitionOnboarding: (event) => {
        const current = onboardingStateFromPersisted(get().settings.onboarding);
        set({
          settings: {
            ...get().settings,
            onboarding: onboardingAfter(current, event),
          },
        });
      },

      snapshot: (label) => {
        const stack = [
          ...get().undoStack,
          {
            label,
            sections: structuredClone(get().sections),
            notes: structuredClone(get().notes),
            tasks: structuredClone(get().tasks),
            taskSections: structuredClone(get().taskSections),
            bills: structuredClone(get().bills),
          },
        ];
        while (stack.length > UNDO_DEPTH) stack.shift();
        set({ undoStack: stack });
      },

      undo: () => {
        const stack = [...get().undoStack];
        const entry = stack.pop();
        if (!entry) return null;
        set({
          undoStack: stack,
          sections: entry.sections,
          notes: entry.notes,
          tasks: entry.tasks,
          taskSections: entry.taskSections,
          // 旧撤销条目（无 bills 字段）不回滚账单域，保持当前值
          ...(entry.bills ? { bills: entry.bills } : {}),
          checkedIds: [],
        });
        return entry.label;
      },

      importMerge: (data) => {
        get().snapshot("导入合并");
        const state = get();
        const sectionIds = new Set(state.sections.map((s) => s.id));
        let skippedDuplicates = 0;
        const newSections: Section[] = [];
        for (const section of data.sections ?? []) {
          if (
            !section ||
            typeof section.id !== "string" ||
            !section.id ||
            typeof section.name !== "string"
          )
            continue;
          if (sectionIds.has(section.id)) {
            skippedDuplicates += 1;
            continue;
          }
          sectionIds.add(section.id);
          newSections.push(section);
        }
        const allSections = [...state.sections, ...newSections];
        const allSectionIds = new Set(allSections.map((s) => s.id));
        const noteIds = new Set(state.notes.map((n) => n.id));
        const newNotes: Note[] = [];
        for (const note of data.notes ?? []) {
          if (
            !note ||
            typeof note.id !== "string" ||
            !note.id ||
            typeof note.text !== "string"
          )
            continue;
          if (noteIds.has(note.id)) {
            skippedDuplicates += 1;
            continue;
          }
          noteIds.add(note.id);
          newNotes.push(normalizeNoteRecord(note, allSectionIds));
        }
        const taskSecIds = new Set(state.taskSections.map((s) => s.id));
        const newTaskSections: TaskSection[] = [];
        for (const section of data.taskSections ?? []) {
          if (
            !section ||
            typeof section.id !== "string" ||
            !section.id ||
            typeof section.name !== "string"
          )
            continue;
          if (taskSecIds.has(section.id)) {
            skippedDuplicates += 1;
            continue;
          }
          taskSecIds.add(section.id);
          newTaskSections.push(section);
        }
        const allTaskSections = [...state.taskSections, ...newTaskSections];
        const allTaskSecIds = new Set(allTaskSections.map((s) => s.id));
        const taskIds = new Set(state.tasks.map((t) => t.id));
        const newTasks: Task[] = [];
        for (const task of data.tasks ?? []) {
          if (
            !task ||
            typeof task.id !== "string" ||
            !task.id ||
            typeof task.text !== "string"
          )
            continue;
          if (taskIds.has(task.id)) {
            skippedDuplicates += 1;
            continue;
          }
          taskIds.add(task.id);
          newTasks.push(normalizeTaskRecord(task, allTaskSecIds));
        }
        const billIds = new Set(state.bills.map((b) => b.id));
        const newBills: Bill[] = [];
        for (const bill of data.bills ?? []) {
          if (
            !bill ||
            typeof bill.id !== "string" ||
            !bill.id ||
            typeof bill.name !== "string"
          )
            continue;
          if (billIds.has(bill.id)) {
            skippedDuplicates += 1;
            continue;
          }
          billIds.add(bill.id);
          newBills.push(normalizeBillRecord(bill));
        }
        set({
          sections: allSections,
          notes: [...state.notes, ...newNotes],
          tasks: [...state.tasks, ...newTasks],
          taskSections: allTaskSections,
          bills: [...state.bills, ...newBills],
        });
        return {
          notes: newNotes.length,
          tasks: newTasks.length,
          bills: newBills.length,
          skippedDuplicates,
        };
      },
    }),
    {
      name: "toskr",
      version: STORE_VERSION,
      storage: createJSONStorage(() => tauriStateStorage),
      // main WebView 先查询 Native journal/status，再决定续接事务或水合。
      // 禁止模块加载时的自动水合与 pending rollback 交错。
      skipHydration: true,
      migrate: migratePersistedState,
      partialize: persistentStateOf,
      merge: mergePersistedNotesState,
    }
  )
);

/** 目录切换/完整恢复专用：替换持久域，绝不与旧目录内存记录合并。 */
export function replaceNotesStoreFromPersisted(raw: string): void {
  const next = decodePersistedState(raw);
  useNotesStore.setState({
    ...next,
    checkedIds: [],
    undoStack: [],
  });
}

/** 回滚专用：磁盘仍是事务前 A 时恢复 selection/undo；外部已变 B 时清空旧上下文。 */
export function restoreNotesStoreAfterRollback(
  snapshot: NotesStoreSnapshot,
  raw: string
): void {
  const restored = decodePersistedState(raw);
  const snapshotPersistent: PersistentNotesState = {
    sections: snapshot.sections,
    notes: snapshot.notes,
    tasks: snapshot.tasks,
    taskSections: snapshot.taskSections,
    bills: snapshot.bills,
    settings: snapshot.settings,
  };
  if (JSON.stringify(restored) === JSON.stringify(snapshotPersistent)) {
    restoreNotesStoreSnapshot(snapshot);
    return;
  }
  useNotesStore.setState({
    ...restored,
    checkedIds: [],
    undoStack: [],
  });
}

export function captureNotesStoreSnapshot(): NotesStoreSnapshot {
  const state = useNotesStore.getState();
  return structuredClone({
    ...persistentStateOf(state),
    checkedIds: state.checkedIds,
    undoStack: state.undoStack,
  });
}

export function restoreNotesStoreSnapshot(snapshot: NotesStoreSnapshot): void {
  useNotesStore.setState(structuredClone(snapshot));
}

/**
 * 发送成功后应标记完成的卡片：排除「常用」卡、「发送后保留」分组内的卡，
 * 以及剪贴板历史（流水记录发送后仍是历史，没有"完成"语义）。
 */
export function doneIdsAfterSend(
  state: Pick<NotesState, "notes" | "sections">,
  sentIds: string[]
): string[] {
  const keepSecs = new Set(
    state.sections.filter((s) => s.keepAfterSend).map((s) => s.id)
  );
  const picked = new Set(sentIds);
  return state.notes
    .filter(
      (n) =>
        picked.has(n.id) &&
        !n.keep &&
        !keepSecs.has(n.sectionId) &&
        n.sectionId !== CLIPBOARD_ID
    )
    .map((n) => n.id);
}

/** 卡片携带的全部图片（主图 + 附件，已去重）。 */
export function noteImages(note: Note): string[] {
  return [
    ...new Set(
      noteContentBlocks(note).flatMap((block) =>
        block.type === "image" ? [block.file] : []
      )
    ),
  ];
}

/** 按列表展示顺序返回勾选的笔记。 */
export function orderedCheckedNotes(state: Pick<NotesState, "notes" | "checkedIds">): Note[] {
  const checked = new Set(state.checkedIds);
  return state.notes.filter((n) => checked.has(n.id));
}
