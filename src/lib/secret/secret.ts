/**
 * 秘文高层管线：明文 ↔ 中文密文串，以及「识别 + 逐密钥试解」。
 * 组合 crypto（本地 AES-GCM）与 chineseCodec（中文码本）两层；上层只用本文件。
 */

import {
  CRYPTO_CONSTANTS,
  decryptFromBytes,
  encryptToBytes,
  hasWebCrypto,
} from "./crypto";
import { decodeToBytes, encodeBytes, looksLikeSecret } from "./chineseCodec";

export type SecretDirection = "in" | "out";

/** 共享密钥（明文随本地设置保存；威胁模型见设置页说明：防 IM/网络/肩窥，不防本地取证）。 */
export interface SecretKey {
  id: string;
  /** 给谁/场景名，便于记忆与卡片展示。 */
  label: string;
  /** 双方约定的共享密钥（中文/字符皆可）。 */
  passphrase: string;
  /** 备注：何时/因何/与谁设置。 */
  note?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** 秘文 Note 的元数据（明文永不落盘；text 存中文密文信封）。 */
export interface SecretMeta {
  /** 命中/使用的密钥 id；null = 收到但无匹配密钥（锁定卡）。 */
  keyId: string | null;
  /** 冗余保存命中密钥的展示名（密钥被删后卡片仍可标注）。 */
  keyLabel?: string;
  direction: SecretDirection;
}

export type OpenResult =
  | { status: "plaintext"; plaintext: string; keyId: string; keyLabel: string }
  | { status: "locked" }
  | { status: "not-secret" };

export { hasWebCrypto };

/**
 * 同步判断文本是否为可解析的秘文信封（「」边界 + 足够字节 + 魔数前缀）。
 * 捕获路由用它作零成本决策：命中才走异步试解，未命中的普通文本照常入普通笔记。
 */
export function isSecretEnvelope(text: string): boolean {
  if (!looksLikeSecret(text, CRYPTO_CONSTANTS.MIN_ENVELOPE_LEN)) return false;
  const bytes = decodeToBytes(text);
  if (!bytes) return false;
  const { MAGIC } = CRYPTO_CONSTANTS;
  return bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1];
}

/**
 * 估算密文总字数（含标点/引号），供撰写时预览「发出去大概多长」。
 * 字节 = 信封开销 + UTF-16 明文 2B/字；标点约每 6 字一个；「」+ 末尾。共 3。
 * 与实测偏差 ±2 字左右，仅作提示不作契约。
 */
export function estimateCipherLength(plaintext: string): number {
  const bytes = CRYPTO_CONSTANTS.MIN_ENVELOPE_LEN + plaintext.length * 2;
  return bytes + Math.round(bytes / 6) + 3;
}

/** 明文 + 密钥 → 中文密文串。 */
export async function sealToChinese(
  plaintext: string,
  passphrase: string
): Promise<string> {
  const bytes = await encryptToBytes(plaintext, passphrase);
  return encodeBytes(bytes);
}

/**
 * 中文密文串 + 全部可用密钥 → 逐个试解（GCM 首个通过者即命中，信封不泄露 keyId）。
 * 非秘文 → not-secret；是秘文但无密钥可解 → locked。
 */
export async function openFromChinese(
  text: string,
  keys: readonly SecretKey[]
): Promise<OpenResult> {
  if (!isSecretEnvelope(text)) return { status: "not-secret" };
  const bytes = decodeToBytes(text);
  if (!bytes) return { status: "not-secret" };
  for (const key of keys) {
    try {
      const plaintext = await decryptFromBytes(bytes, key.passphrase);
      return {
        status: "plaintext",
        plaintext,
        keyId: key.id,
        keyLabel: key.label,
      };
    } catch {
      // 认证失败 → 换下一把密钥
    }
  }
  return { status: "locked" };
}
