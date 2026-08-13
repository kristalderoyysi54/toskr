import { emitTo, listen } from "@tauri-apps/api/event";

import {
  ALIAS_PRESET_CATEGORIES,
  aliasOriginalTextIssue,
  allocateAliasPlaceholder,
  type AliasCategoryDefinition,
} from "@/lib/delivery/aliasEntities";
import { applySettingsPatch } from "@/lib/settingsSync";
import { tip } from "@/lib/tip";
import { useNotesStore } from "@/store/notesStore";

/** 详情窗等非主窗口发起「加入化名词典」的语义事件；主面板统一取号写入。 */
export const ALIAS_QUICK_ADD_EVENT = "toskr://alias-quick-add";

export type AliasQuickAddPayload = { originalText: string; category: string };

/** 快捷加入可选类别 = 预置 + 用户自定义（不含新建自定义码的重流程）。 */
export function aliasQuickAddCategories(
  custom: readonly AliasCategoryDefinition[]
): AliasCategoryDefinition[] {
  const presetCodes = new Set(ALIAS_PRESET_CATEGORIES.map((item) => item.code));
  return [
    ...ALIAS_PRESET_CATEGORIES,
    ...custom.filter((item) => !presetCodes.has(item.code)),
  ];
}

function quickEntityId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `alias-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 主面板执行：校验 → 取号 → 写入词典，HUD 即时回执。
 * 词典写入必须在主面板原子完成（取号依赖最新计数器），非主窗口走事件转发。
 */
export function addAliasEntityFromText(
  originalText: string,
  category: string
): boolean {
  const settings = useNotesStore.getState().settings;
  const trimmed = originalText.trim();
  const issue = aliasOriginalTextIssue(trimmed, settings.aliasEntities);
  if (issue) {
    tip("warn", `无法加入词典：${issue}`);
    return false;
  }
  const known = aliasQuickAddCategories(settings.aliasCustomCategories).some(
    (item) => item.code === category
  );
  if (!known) {
    tip("warn", "无法加入词典：类别无效");
    return false;
  }
  const allocated = allocateAliasPlaceholder(
    category,
    settings.aliasNextNumberByCategory
  );
  const now = Date.now();
  applySettingsPatch({
    aliasEntities: [
      ...settings.aliasEntities,
      {
        id: quickEntityId(),
        category,
        originalText: trimmed,
        placeholder: allocated.placeholder,
        createdAtMs: now,
        updatedAtMs: now,
      },
    ],
    aliasNextNumberByCategory: allocated.nextCounters,
  });
  const preview = trimmed.length > 12 ? `${trimmed.slice(0, 12)}…` : trimmed;
  tip(
    "added",
    settings.aliasEntitiesEnabled
      ? `已加入化名词典：${preview} → ${allocated.placeholder}`
      : `已加入词典（${allocated.placeholder}）；可逆化名总开关当前关闭`
  );
  return true;
}

/** 主面板挂载：接收非主窗口的快捷加入请求。 */
export function registerAliasQuickAddListener(): Promise<() => void> {
  return listen<AliasQuickAddPayload>(ALIAS_QUICK_ADD_EVENT, (event) => {
    addAliasEntityFromText(event.payload.originalText, event.payload.category);
  });
}

/** 非主窗口调用：转发到主面板执行（HUD 回执全局可见）。 */
export function requestAliasQuickAdd(payload: AliasQuickAddPayload): void {
  void emitTo("main", ALIAS_QUICK_ADD_EVENT, payload);
}

