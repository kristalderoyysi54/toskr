import {
  PLACEHOLDER_NAME_PATTERN,
  PLACEHOLDER_PATTERN,
  nonOverlappingFindings,
  replaceFirewallFindings,
  type PlaceholderMatch,
} from "./firewall";

/** 类别码用作占位符 [CODE_NN] 的 CODE 段。 */
export interface AliasCategoryDefinition {
  code: string;
  label: string;
}

/** 预置类别（硬编码，不入 Settings，不可删改）。 */
export const ALIAS_PRESET_CATEGORIES: readonly AliasCategoryDefinition[] = [
  { code: "USER", label: "用户" },
  { code: "MERCHANT", label: "商户" },
  { code: "ORDER", label: "订单" },
  { code: "PROJECT", label: "项目" },
  { code: "CONTACT", label: "联系方式" },
];

/** 与隐私正则的建议占位符前缀（privacy.rs placeholder()）一致，自定义类别禁用，防恢复时撞号。 */
export const RESERVED_ALIAS_CATEGORY_CODES: readonly string[] = [
  "PRIVATE_KEY",
  "AUTHORIZATION",
  "API_KEY",
  "DATABASE_URL",
  "EMAIL",
  "PHONE",
  "NATIONAL_ID",
  "BANK_CARD",
  "IP_ADDRESS",
  "COOKIE",
  "SESSION",
];

export const ALIAS_CATEGORY_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,15}$/;

/** 词典条目；placeholder 创建时一次性分配、永不改变，删除不回收编号。 */
export interface AliasEntity {
  id: string;
  category: string;
  /** 精确匹配串（大小写敏感），词典内唯一。 */
  originalText: string;
  placeholder: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AliasCandidate extends PlaceholderMatch {
  entityId: string;
  originalText: string;
}

/** finalText 中仍处占位符状态的词典项出现（带鲜活 UTF-16 偏移）。 */
export interface AliasOccurrence {
  startUtf16: number;
  endUtf16: number;
  placeholder: string;
  originalText: string;
  entityId: string;
  category: string;
  categoryLabel: string;
}

export function categoryLabelOf(
  code: string,
  custom: readonly AliasCategoryDefinition[]
): string {
  return (
    ALIAS_PRESET_CATEGORIES.find((item) => item.code === code)?.label ??
    custom.find((item) => item.code === code)?.label ??
    code
  );
}

export function isValidAliasCategoryCode(code: string): boolean {
  return (
    ALIAS_CATEGORY_CODE_PATTERN.test(code) &&
    !RESERVED_ALIAS_CATEGORY_CODES.includes(code)
  );
}

/**
 * 词典扫描：精确子串匹配 + 既有占位符保护区 + 长词优先重叠裁决。
 * 正文里已经是 [CODE_NN] 形态的片段（无论来源）永不二次匹配。
 */
export function scanAliasEntities(
  text: string,
  dictionary: readonly AliasEntity[]
): AliasCandidate[] {
  if (!text || dictionary.length === 0) return [];
  const exclusions: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    exclusions.push([match.index, match.index + match[0].length]);
  }
  const overlapsExclusion = (start: number, end: number) =>
    exclusions.some(([from, to]) => start < to && end > from);
  const candidates: AliasCandidate[] = [];
  for (const entity of dictionary) {
    const source = entity.originalText;
    if (!source || !entity.placeholder) continue;
    let cursor = 0;
    while (cursor <= text.length - source.length) {
      const index = text.indexOf(source, cursor);
      if (index === -1) break;
      const end = index + source.length;
      cursor = end;
      if (overlapsExclusion(index, end)) continue;
      candidates.push({
        id: `${entity.id}:${index}:${end}`,
        entityId: entity.id,
        originalText: source,
        category: entity.category,
        // 常量哨兵：候选间恒平局，nonOverlappingFindings 退化为跨度长者优先（张三丰 胜 张三）
        severity: "info",
        startUtf16: index,
        endUtf16: end,
        suggestedPlaceholder: entity.placeholder,
      });
    }
  }
  return nonOverlappingFindings(text, candidates);
}

/** 自动替换全部词典命中；占位符来自条目固定值，不做动态编号。 */
export function applyAliasEntities(
  text: string,
  dictionary: readonly AliasEntity[]
): { text: string; redactionMap: Record<string, string>; replacedCount: number } {
  const matches = scanAliasEntities(text, dictionary);
  if (matches.length === 0) return { text, redactionMap: {}, replacedCount: 0 };
  const seed: Record<string, string> = {};
  for (const match of matches) seed[match.originalText] = match.suggestedPlaceholder;
  const result = replaceFirewallFindings(text, matches, seed);
  return {
    text: result.text,
    redactionMap: result.redactionMap,
    replacedCount: result.replacedFindingIds.length,
  };
}

/**
 * 反向恢复：文本中词典已知的占位符 → 原文；未知占位符（含正则来源）原样保留。
 * 不依赖发送会话与 deliveryId，重启后仍可用。
 */
export function restoreAliases(
  text: string,
  dictionary: readonly AliasEntity[]
): { text: string; restoredCount: number } {
  if (!text || dictionary.length === 0) return { text, restoredCount: 0 };
  let restored = text;
  let restoredCount = 0;
  const entries = dictionary
    .filter((entity) => entity.placeholder && entity.originalText)
    .sort(
      (left, right) =>
        right.placeholder.length - left.placeholder.length ||
        left.placeholder.localeCompare(right.placeholder)
    );
  for (const entity of entries) {
    const pieces = restored.split(entity.placeholder);
    if (pieces.length === 1) continue;
    restoredCount += pieces.length - 1;
    restored = pieces.join(entity.originalText);
  }
  return { text: restored, restoredCount };
}

/** 供 UI 现读现算：逐处列出可恢复的词典占位符（预检还原 / 卡片徽标共用）。 */
export function activeAliasOccurrences(
  text: string,
  dictionary: readonly AliasEntity[],
  customCategories: readonly AliasCategoryDefinition[] = []
): AliasOccurrence[] {
  if (!text || dictionary.length === 0) return [];
  const byPlaceholder = new Map<string, AliasEntity>();
  for (const entity of dictionary) {
    if (entity.placeholder && entity.originalText) {
      byPlaceholder.set(entity.placeholder, entity);
    }
  }
  if (byPlaceholder.size === 0) return [];
  const occurrences: AliasOccurrence[] = [];
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const entity = byPlaceholder.get(match[0]);
    if (!entity) continue;
    occurrences.push({
      startUtf16: match.index,
      endUtf16: match.index + match[0].length,
      placeholder: entity.placeholder,
      originalText: entity.originalText,
      entityId: entity.id,
      category: entity.category,
      categoryLabel: categoryLabelOf(entity.category, customCategories),
    });
  }
  return occurrences;
}

/** 创建条目时取号；计数器只增不减（删除条目不回收编号，防旧回复被错误恢复）。 */
export function allocateAliasPlaceholder(
  code: string,
  counters: Readonly<Record<string, number>>
): { placeholder: string; nextCounters: Record<string, number> } {
  const current = counters[code];
  const number =
    typeof current === "number" && Number.isSafeInteger(current) && current >= 1
      ? current
      : 1;
  return {
    placeholder: `[${code}_${String(number).padStart(2, "0")}]`,
    nextCounters: { ...counters, [code]: number + 1 },
  };
}

/** 「自动生成」类别推断：给快捷入口一个聪明默认值，用户可随时改。 */
export function suggestAliasCategory(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes("@")) return "CONTACT";
  if (/^\+?[\d\s\-()]{7,}$/.test(trimmed)) return "CONTACT";
  if (/^[A-Z0-9][A-Z0-9\-_#/]{3,}$/i.test(trimmed) && /\d/.test(trimmed)) {
    return "ORDER";
  }
  return "USER";
}

/** 原文合法性判定（CRUD 表单与持久化校验共用）；返回 null 表示可用。 */
export function aliasOriginalTextIssue(
  originalText: string,
  dictionary: readonly AliasEntity[],
  editingId: string | null = null
): string | null {
  const trimmed = originalText.trim();
  if (!trimmed) return "原文不能为空";
  if (trimmed !== originalText) return "原文首尾不能是空白字符";
  // PLACEHOLDER_PATTERN 带 /g，用 matchAll（内部克隆正则）避免 lastIndex 污染
  if (!originalText.matchAll(PLACEHOLDER_PATTERN).next().done) {
    return "原文不能包含占位符形态的文字";
  }
  if (
    dictionary.some(
      (entity) => entity.id !== editingId && entity.originalText === originalText
    )
  ) {
    return "该原文已存在于词典";
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 持久化形状校验（validateSettingsShape / 备份恢复共用）。 */
export function isAliasEntityRecordValid(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.category === "string" &&
    ALIAS_CATEGORY_CODE_PATTERN.test(value.category) &&
    typeof value.originalText === "string" &&
    value.originalText.length > 0 &&
    typeof value.placeholder === "string" &&
    PLACEHOLDER_NAME_PATTERN.test(value.placeholder) &&
    typeof value.createdAtMs === "number" &&
    Number.isFinite(value.createdAtMs) &&
    typeof value.updatedAtMs === "number" &&
    Number.isFinite(value.updatedAtMs)
  );
}

export function isAliasCategoryRecordValid(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    isValidAliasCategoryCode(value.code) &&
    !ALIAS_PRESET_CATEGORIES.some((preset) => preset.code === value.code) &&
    typeof value.label === "string" &&
    value.label.length > 0
  );
}

export function isAliasCounterRecordValid(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(
    ([code, count]) =>
      ALIAS_CATEGORY_CODE_PATTERN.test(code) &&
      typeof count === "number" &&
      Number.isSafeInteger(count) &&
      count >= 1
  );
}
