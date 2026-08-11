import type { AiKeyStatus } from "@/lib/tauri";
import type { Settings } from "@/store/notesStore";

type LegacySettings = Settings & { aiApiKey?: unknown };

export function legacyAiApiKey(settings: Settings): string | null {
  const value = (settings as LegacySettings).aiApiKey;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 只移除历史 secret；未知设置必须原样保留以满足向前兼容。 */
export function withoutLegacyAiApiKey(settings: Settings): Settings {
  const { aiApiKey: _legacy, ...safe } = settings as LegacySettings;
  return safe as Settings;
}

export async function migrateLegacyAiApiKey(
  settings: Settings,
  dependencies: {
    setAiApiKey: (
      key: string,
      overwriteExisting: boolean
    ) => Promise<AiKeyStatus>;
    commit: (safeSettings: Settings) => void;
  }
): Promise<"none" | "migrated" | "failed"> {
  const key = legacyAiApiKey(settings);
  if (!key) return "none";
  try {
    const status = await dependencies.setAiApiKey(key, false);
    if (!status.configured) return "failed";
    dependencies.commit(withoutLegacyAiApiKey(settings));
    return "migrated";
  } catch {
    // 调用方仅显示通用告警；错误对象和日志都不接触 secret。
    return "failed";
  }
}
