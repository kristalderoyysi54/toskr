/**
 * 秘文高层管线：明文 ↔ 可选格式密文，以及「识别 + 逐密钥试解」。
 * 格式层只编码同一份 AES-GCM 信封字节；接收方无需知道发送方选择的格式。
 */

import {
  CRYPTO_CONSTANTS,
  decryptFromBytes,
  encryptToBytes,
  hasWebCrypto,
} from "./crypto";
import {
  SECRET_CIPHER_STYLES,
  SECRET_CIPHER_STYLE_OPTIONS,
  decodeSecretAppearance,
  encodeSecretAppearance,
  estimateSecretAppearanceLength,
  isSecretAppearanceLengthSupported,
  normalizeSecretCipherStyle,
  type SecretCipherStyle,
} from "./appearanceCodec";

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

/** 秘文 Note 的元数据（明文永不落盘；text 存指定格式的密文信封）。 */
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

export {
  SECRET_CIPHER_STYLES,
  SECRET_CIPHER_STYLE_OPTIONS,
  hasWebCrypto,
  normalizeSecretCipherStyle,
};
export type { SecretCipherStyle };

/**
 * 同步判断文本是否为可解析的秘文信封（已知格式 + 足够字节 + 魔数前缀）。
 * 捕获路由用它作零成本决策：命中才走异步试解，未命中的普通文本照常入普通笔记。
 */
export function isSecretEnvelope(text: string): boolean {
  return decodeSecretAppearance(text) !== null;
}

/**
 * 从真实 envelope bytes 生成稳定指纹；不同格式或换行规范化不影响结果。
 * 指纹不含明文，仅用于瞬时去重判断。
 */
export function secretEnvelopeFingerprint(text: string): string | null {
  const decoded = decodeSecretAppearance(text);
  if (!decoded) return null;
  let hex = "";
  for (const byte of decoded.bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * 估算密文总字数，供撰写时预览「发出去大概多长」。
 * 字节 = 信封开销 + UTF-16 明文 2B/code unit；文本开销由各格式协议统一估算。
 */
export function estimateCipherLength(
  plaintext: string,
  style: SecretCipherStyle = "classic"
): number {
  const bytes = CRYPTO_CONSTANTS.MIN_ENVELOPE_LEN + plaintext.length * 2;
  return estimateSecretAppearanceLength(bytes, style);
}

/** 编码前检查输出是否落在接收端共同上限内。 */
export function isCipherLengthSupported(
  plaintext: string,
  style: SecretCipherStyle = "classic"
): boolean {
  const bytes = CRYPTO_CONSTANTS.MIN_ENVELOPE_LEN + plaintext.length * 2;
  return isSecretAppearanceLengthSupported(bytes, style);
}

/** 明文 + 密钥 + 格式 → 秘文文本。格式不进入 AES-GCM 信封。 */
export async function sealSecret(
  plaintext: string,
  passphrase: string,
  style: SecretCipherStyle
): Promise<string> {
  if (!isCipherLengthSupported(plaintext, style)) {
    throw new Error("秘文内容过长");
  }
  const bytes = await encryptToBytes(plaintext, passphrase);
  return encodeSecretAppearance(bytes, style);
}

/** 明文 + 密钥 → 旧版中文密文串；保留给既有调用方与存量协议。 */
export async function sealToChinese(
  plaintext: string,
  passphrase: string
): Promise<string> {
  return sealSecret(plaintext, passphrase, "classic");
}

/**
 * 任意支持格式的密文 + 全部可用密钥 → 逐个试解（GCM 首个通过者即命中，信封不泄露 keyId）。
 * 非秘文 → not-secret；是秘文但无密钥可解 → locked。
 */
export async function openSecret(
  text: string,
  keys: readonly SecretKey[]
): Promise<OpenResult> {
  const decoded = decodeSecretAppearance(text);
  if (!decoded) return { status: "not-secret" };
  for (const key of keys) {
    try {
      const plaintext = await decryptFromBytes(decoded.bytes, key.passphrase);
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

/** @deprecated 使用 openSecret；保留该别名以兼容既有调用方。 */
export const openFromChinese = openSecret;
