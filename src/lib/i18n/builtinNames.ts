import { t, type MessageKey } from "./index";

/**
 * 内置对象的默认名在数据里存中文（旧数据、备份、测试都依赖它），显示时按 id 识别并翻译。
 * 只有「id 是内置 + 名字仍是出厂中文」才翻译；用户改过名就原样显示。
 * id 与 notesStore / targetProfiles 中的常量一致，这里写字面量以免 i18n 反向依赖 store。
 */
const BUILTIN_SECTION_NAMES: Record<string, MessageKey> = {
  inbox: "收件箱",
  "task-inbox": "收集箱",
  clipboard: "剪贴板",
  secret: "秘文",
};

const BUILTIN_PROFILE_NAMES: Record<string, MessageKey> = {
  "default-safe": "稳妥发送",
  "terminal-safe": "终端（安全）",
};

const BUILTIN_PROMPT_GROUP_NAMES: Record<string, MessageKey> = {
  general: "通用",
};

function builtin(table: Record<string, MessageKey>, item: { id: string; name: string }): string {
  const key = table[item.id];
  return key !== undefined && item.name === key ? t(key) : item.name;
}

/** 笔记 / 任务分组的显示名。 */
export function sectionName(section: { id: string; name: string }): string {
  if (section.name === "未命名分组") return t("未命名分组");
  return builtin(BUILTIN_SECTION_NAMES, section);
}

/** 发送方案的显示名。 */
export function profileName(profile: { id: string; name: string }): string {
  return builtin(BUILTIN_PROFILE_NAMES, profile);
}

/** 提示词组的显示名。 */
export function promptGroupName(group: { id: string; name: string }): string {
  return builtin(BUILTIN_PROMPT_GROUP_NAMES, group);
}

/** 新建空白笔记时写入的占位正文，中英文都视为占位（空白草稿回收按此判断）。 */
export function isNewNotePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "新笔记" || trimmed === t("新笔记");
}
