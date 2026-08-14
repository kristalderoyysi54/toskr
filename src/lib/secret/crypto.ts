/**
 * 秘文本地加解密：Web Crypto（crypto.subtle），零第三方依赖。
 * PBKDF2-SHA256 派生 → AES-256-GCM 认证加密。每条消息随机 salt/iv，
 * 故同明文两次密文不同；用错密钥时 GCM 认证失败即解不开（信封不泄露密钥线索）。
 * 明文按 UTF-16LE 编码（中文 2 字节/字，密文比 UTF-8 短约 1/3）。
 *
 * 信封字节布局（明文永不落盘，仅密文信封入库）：
 *   magic 2B | version 1B | salt 16B | iv 12B | 密文（含 16B GCM tag）
 *
 * ⚠️ 发布后冻结：magic/version/迭代次数/布局一经用户产生密文即不可变更，
 *   否则存量密文永久无法解密。改动必须升 version 并保留旧版解码分支。
 */

/** 信封魔数：值本身任意，选 [0x86,0x17] 是因为经中文码本恰好渲染成「话说」开头（见 chineseCodec）。 */
const MAGIC = Uint8Array.of(0x86, 0x17);
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
/** magic + version + salt + iv。 */
const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN;
/** GCM 认证标签长度（附在密文尾部）。 */
const GCM_TAG_LEN = 16;
/** 合法信封最小字节数（空明文 = 仅 tag）。 */
const MIN_ENVELOPE_LEN = HEADER_LEN + GCM_TAG_LEN;
/** PBKDF2 迭代次数：抬高离线爆破成本，同时单次派生仍在交互可接受范围。 */
const PBKDF2_ITERATIONS = 150_000;

export const CRYPTO_CONSTANTS = {
  MAGIC,
  VERSION,
  SALT_LEN,
  IV_LEN,
  HEADER_LEN,
  MIN_ENVELOPE_LEN,
  PBKDF2_ITERATIONS,
} as const;

/**
 * subtle.* 形参要求 BufferSource（= ArrayBufferView<ArrayBuffer>）。TS 6.0 起
 * Uint8Array 默认 <ArrayBufferLike>（含 SharedArrayBuffer），直传不兼容；此处收窄。
 * 运行时始终是普通 ArrayBuffer 支持的视图，转换安全。
 */
const buf = (u: Uint8Array): BufferSource => u as BufferSource;

/** 运行环境是否具备 Web Crypto 子集（WKWebView/Node 均原生支持）。 */
export function hasWebCrypto(): boolean {
  return (
    typeof crypto !== "undefined" &&
    !!crypto.subtle &&
    typeof crypto.subtle.encrypt === "function"
  );
}

/** JS 字符串 → UTF-16LE 字节（按 code unit，代理对完整保留）。 */
function utf16leEncode(text: string): Uint8Array {
  const buf = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    buf[i * 2] = code & 0xff;
    buf[i * 2 + 1] = code >>> 8;
  }
  return buf;
}

/** UTF-16LE 字节 → JS 字符串（奇数尾字节忽略；正常解密后长度必为偶数）。 */
function utf16leDecode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  }
  return out;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    buf(new TextEncoder().encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: buf(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** 明文 + 口令 → 密文信封字节。 */
export async function encryptToBytes(
  plaintext: string,
  passphrase: string
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(passphrase, salt);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(iv) },
      key,
      buf(utf16leEncode(plaintext))
    )
  );
  const out = new Uint8Array(HEADER_LEN + cipher.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(salt, MAGIC.length + 1);
  out.set(iv, MAGIC.length + 1 + SALT_LEN);
  out.set(cipher, HEADER_LEN);
  return out;
}

/** 密文信封字节 + 口令 → 明文。头部非法或认证失败均抛错。 */
export async function decryptFromBytes(
  bytes: Uint8Array,
  passphrase: string
): Promise<string> {
  if (bytes.length < MIN_ENVELOPE_LEN) throw new Error("密文过短");
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) {
    throw new Error("非秘文信封");
  }
  if (bytes[MAGIC.length] !== VERSION) throw new Error("秘文版本不支持");
  const salt = bytes.slice(MAGIC.length + 1, MAGIC.length + 1 + SALT_LEN);
  const iv = bytes.slice(MAGIC.length + 1 + SALT_LEN, HEADER_LEN);
  const cipher = bytes.slice(HEADER_LEN);
  const key = await deriveKey(passphrase, salt);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(cipher))
  );
  return utf16leDecode(plain);
}
