export const MAX_CUSTOM_SENSITIVE_FIELDS = 32;
export const MAX_CUSTOM_SENSITIVE_FIELD_LENGTH = 64;

const FIELD_NAME = /^[A-Za-z0-9\p{Script=Han}_.-]+$/u;
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

export function customSensitiveFieldIssue(value: string, existing: readonly string[] = []): string | null {
  const field = value.trim();
  if (!field) return "请填写字段名，不需要填写密钥值";
  if ([...field].length > MAX_CUSTOM_SENSITIVE_FIELD_LENGTH) return "字段名最多 64 个字符";
  if (!FIELD_NAME.test(field)) return "仅支持汉字、英文字母、数字、下划线、点和短横线，不含空格";
  if (existing.some((item) => asciiLower(item) === asciiLower(field))) return "这个字段已经添加（英文不区分大小写）";
  if (existing.length >= MAX_CUSTOM_SENSITIVE_FIELDS) return "最多添加 32 个敏感字段";
  return null;
}

export function normalizeCustomSensitiveFields(value: unknown): string[] {
  const result: string[] = [];
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (typeof item === "string" && !customSensitiveFieldIssue(item, result)) result.push(item.trim());
  }
  return result;
}

export function isCustomSensitiveFieldsValid(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item === item.trim())
    && normalizeCustomSensitiveFields(value).length === value.length;
}
