import { api } from "@/lib/tauri";
import type { PromptGroup, PromptSnippet } from "@/lib/targetProfiles";

export interface PromptTemplatesExport {
  format: "toskr-prompt-templates";
  version: 1;
  groups: PromptGroup[];
  snippets: PromptSnippet[];
}

/** 只导出模板及其引用分组；逐字段复制，避免混入完整设置或其他状态。 */
export function buildPromptTemplatesExport(
  snippets: readonly PromptSnippet[],
  groups: readonly PromptGroup[]
): PromptTemplatesExport {
  const referencedGroupIds = new Set(snippets.map((snippet) => snippet.groupId));
  const exportedGroups = groups
    .filter((group) => referencedGroupIds.has(group.id))
    .map(({ id, name, order }) => ({ id, name, order }));
  if (referencedGroupIds.size !== new Set(exportedGroups.map((group) => group.id)).size) {
    throw new Error("模板引用的分组不存在，请先检查模板分组");
  }
  return {
    format: "toskr-prompt-templates",
    version: 1,
    groups: exportedGroups,
    snippets: snippets.map(({ id, label, text, groupId }) => ({ id, label, text, groupId })),
  };
}

/** 保存当前模板快照；取消不写文件，结果提示由调用界面处理。 */
export async function exportPromptTemplates(
  snippets: readonly PromptSnippet[],
  groups: readonly PromptGroup[]
): Promise<{ path: string; count: number } | null> {
  const payload = buildPromptTemplatesExport(snippets, groups);
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: "toskr-prompt-templates.json",
    filters: [{ name: "Toskr 提示词模板", extensions: ["json"] }],
  });
  if (!path) return null;
  await api.exportPromptTemplates(path, payload);
  return { path, count: payload.snippets.length };
}
