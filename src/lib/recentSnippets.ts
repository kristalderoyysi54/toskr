/** 最近使用的提示词模板（本机偏好，存 localStorage，不进数据文件）。 */
const KEY = "toskr.recentPromptSnippets";
const MAX = 3;

export function recentSnippetIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function recordSnippetUse(id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify([id, ...recentSnippetIds().filter((x) => x !== id)].slice(0, MAX)));
  } catch {
    // 存储不可用时只是不记最近使用
  }
}
