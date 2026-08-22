/**
 * 秘文文本编码层：同一份 AES-GCM envelope bytes 可渲染为多种独立文本协议。
 *
 * classic 是已经发布的中文码本，必须永久保持原样。code / log / quote 各自
 * 携带原始信封字节，不再包裹中文密文；接收方按严格格式自动识别，无需预选类型。
 * 风格不进入加密信封，也不参与密钥派生。
 */

import { decodeToBytes, encodeBytes, looksLikeSecret } from "./chineseCodec";
import { CRYPTO_CONSTANTS } from "./crypto";

export const SECRET_CIPHER_STYLES = [
  "classic",
  "code",
  "log",
  "quote",
] as const;

export type SecretCipherStyle = (typeof SECRET_CIPHER_STYLES)[number];

/** 协议权威顺序及短文案，供设置页/撰写页复用，避免各入口各写一套。 */
export const SECRET_CIPHER_STYLE_OPTIONS: readonly Readonly<{
  value: SecretCipherStyle;
  label: string;
  shortLabel: string;
}>[] = [
  { value: "classic", label: "中文文本", shortLabel: "中文" },
  { value: "code", label: "代码（随机语言）", shortLabel: "代码" },
  { value: "log", label: "日志记录", shortLabel: "日志" },
  { value: "quote", label: "英文引用", shortLabel: "引用" },
];

/** 未知/历史缺省值统一回落 classic，供持久化 schema 边界使用。 */
export function normalizeSecretCipherStyle(value: unknown): SecretCipherStyle {
  return typeof value === "string" &&
    (SECRET_CIPHER_STYLES as readonly string[]).includes(value)
    ? (value as SecretCipherStyle)
    : "classic";
}

export interface DecodedSecretAppearance {
  style: SecretCipherStyle;
  bytes: Uint8Array;
}

/** 编解码共同硬上限；编码端也必须拒绝生成接收端不会识别的文本。 */
export const MAX_SECRET_APPEARANCE_CHARS = 1_000_000;

function isEnvelopeCandidate(bytes: Uint8Array | null): bytes is Uint8Array {
  if (!bytes || bytes.length < CRYPTO_CONSTANTS.MIN_ENVELOPE_LEN) return false;
  const { MAGIC } = CRYPTO_CONSTANTS;
  return bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1];
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

type CodeLanguage = "javascript" | "python" | "go" | "rust";

const CODE_LANGUAGES: readonly CodeLanguage[] = [
  "javascript",
  "python",
  "go",
  "rust",
];

/**
 * salt 的首字节来自 Web Crypto 随机源；据此稳定选型，避免同一信封重显时跳语言。
 * 每次重新加密都会产生新 salt，因此四种语言会自然随机分布。
 */
function codeLanguageFor(bytes: Uint8Array): CodeLanguage {
  const randomSaltByte = bytes[CRYPTO_CONSTANTS.MAGIC.length + 1] ?? 0;
  return CODE_LANGUAGES[randomSaltByte % CODE_LANGUAGES.length];
}

function renderCode(hex: string, language: CodeLanguage): string {
  switch (language) {
    case "javascript":
      return `const cacheSnapshot = "${hex}";\nexport default cacheSnapshot;`;
    case "python":
      return `CACHE_SNAPSHOT = bytes.fromhex(\n    "${hex}"\n)`;
    case "go":
      return `package cache\n\nimport "encoding/hex"\n\nvar cacheSnapshot, _ = hex.DecodeString("${hex}")`;
    case "rust":
      return `pub const CACHE_SNAPSHOT: &str =\n    "${hex}";`;
  }
}

function encodeCode(bytes: Uint8Array): string {
  return renderCode(bytesToHex(bytes), codeLanguageFor(bytes));
}

const CODE_PATTERNS: readonly Readonly<{
  language: CodeLanguage;
  pattern: RegExp;
}>[] = [
  {
    language: "javascript",
    pattern: /^const cacheSnapshot = "([0-9a-f]+)";\nexport default cacheSnapshot;$/,
  },
  {
    language: "python",
    pattern: /^CACHE_SNAPSHOT = bytes\.fromhex\(\n    "([0-9a-f]+)"\n\)$/,
  },
  {
    language: "go",
    pattern: /^package cache\n\nimport "encoding\/hex"\n\nvar cacheSnapshot, _ = hex\.DecodeString\("([0-9a-f]+)"\)$/,
  },
  {
    language: "rust",
    pattern: /^pub const CACHE_SNAPSHOT: &str =\n    "([0-9a-f]+)";$/,
  },
];

const FENCE_LANGUAGES: Readonly<Record<string, CodeLanguage>> = {
  javascript: "javascript",
  js: "javascript",
  python: "python",
  py: "python",
  go: "go",
  rust: "rust",
};

function decodeCode(text: string): Uint8Array | null {
  let source = text;
  let fencedLanguage: CodeLanguage | undefined;
  const fence = /^```(javascript|js|python|py|go|rust)\n([\s\S]+)\n```$/.exec(text);
  if (fence) {
    fencedLanguage = FENCE_LANGUAGES[fence[1]];
    source = fence[2];
  } else if (text.startsWith("```")) {
    return null;
  }
  for (const { language, pattern } of CODE_PATTERNS) {
    if (fencedLanguage && fencedLanguage !== language) continue;
    const match = pattern.exec(source);
    if (match) return hexToBytes(match[1]);
  }
  return null;
}

const LOG_HEX_CHUNK_LENGTH = 64;
const LOG_LINE_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) INFO cache\.restore trace=([0-9a-f]{8}) chunk=(\d+)\/(\d+) payload=([0-9a-f]{2,64})$/;
const LOG_EPOCH_MS = Date.UTC(2024, 0, 1);
const LOG_SPAN_SECONDS = 6 * 365 * 24 * 60 * 60;

function logTimestampFor(bytes: Uint8Array): string {
  let seed = 0;
  for (let i = 7; i < 11; i++) seed = seed * 256 + (bytes[i] ?? 0);
  return new Date(
    LOG_EPOCH_MS + (seed % LOG_SPAN_SECONDS) * 1_000
  ).toISOString();
}

function logTraceFor(bytes: Uint8Array): string {
  return bytesToHex(bytes.slice(3, 7)).padEnd(8, "0");
}

function encodeLog(bytes: Uint8Array): string {
  const hex = bytesToHex(bytes);
  const chunks = hex.match(new RegExp(`.{1,${LOG_HEX_CHUNK_LENGTH}}`, "g")) ?? [];
  const timestamp = logTimestampFor(bytes);
  const trace = logTraceFor(bytes);
  return chunks
    .map(
      (chunk, index) =>
        `${timestamp} INFO cache.restore trace=${trace} chunk=${index + 1}/${chunks.length} payload=${chunk}`
    )
    .join("\n");
}

function decodeLog(text: string): Uint8Array | null {
  const lines = text.split("\n");
  if (lines.length === 0) return null;

  let timestamp = "";
  let trace = "";
  let payload = "";
  for (let i = 0; i < lines.length; i++) {
    const match = LOG_LINE_PATTERN.exec(lines[i]);
    if (!match) return null;
    const [, lineTimestamp, lineTrace, chunkIndex, chunkTotal, chunk] = match;
    if (
      Number.isNaN(Date.parse(lineTimestamp)) ||
      new Date(lineTimestamp).toISOString() !== lineTimestamp ||
      Number(chunkIndex) !== i + 1 ||
      Number(chunkTotal) !== lines.length ||
      (i < lines.length - 1 && chunk.length !== LOG_HEX_CHUNK_LENGTH) ||
      chunk.length % 2 !== 0
    ) {
      return null;
    }
    if (i === 0) {
      timestamp = lineTimestamp;
      trace = lineTrace;
    } else if (lineTimestamp !== timestamp || lineTrace !== trace) {
      return null;
    }
    payload += chunk;
  }
  const bytes = hexToBytes(payload);
  if (!bytes || logTraceFor(bytes) !== trace) return null;
  return bytes;
}

/**
 * quote 协议的冻结 64-word 码本：索引就是 6-bit token（0..63）。
 * 发布后不可重排；英文短词使 Markdown 引用不包含中文信封、hex 或 Base64 长串。
 */
const QUOTE_WORDS = [
  "after", "again", "air", "along", "among", "and", "away", "back",
  "before", "below", "beyond", "blue", "bright", "but", "calm", "clear",
  "close", "dark", "day", "deep", "down", "each", "east", "even",
  "far", "field", "first", "for", "from", "green", "here", "high",
  "home", "into", "last", "light", "long", "low", "near", "night",
  "north", "now", "old", "once", "only", "over", "past", "quiet",
  "river", "road", "sea", "sky", "soft", "still", "stone", "sun",
  "there", "through", "time", "tree", "under", "water", "west", "wind",
] as const;

const QUOTE_WORD_INDEX = new Map<string, number>(
  QUOTE_WORDS.map((word, index) => [word, index])
);
const QUOTE_WORDS_PER_LINE = 12;
const QUOTE_AVERAGE_WORD_LENGTH =
  QUOTE_WORDS.reduce((sum, word) => sum + word.length, 0) / QUOTE_WORDS.length;

function bytesToSixBitTokens(bytes: Uint8Array): number[] {
  const tokens: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      tokens.push((buffer >>> bits) & 0x3f);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) tokens.push((buffer << (6 - bits)) & 0x3f);
  return tokens;
}

function sixBitTokensToBytes(tokens: readonly number[]): Uint8Array | null {
  if (tokens.length === 0 || tokens.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const token of tokens) {
    if (!Number.isInteger(token) || token < 0 || token > 0x3f) return null;
    buffer = (buffer << 6) | token;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  // 最后不足一字节的补零位必须仍为零，否则不是本编码器产生的规范文本。
  if (buffer !== 0) return null;
  return Uint8Array.from(bytes);
}

function encodeQuote(bytes: Uint8Array): string {
  const words = bytesToSixBitTokens(bytes).map((token) => QUOTE_WORDS[token]);
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += QUOTE_WORDS_PER_LINE) {
    const chunk = words.slice(i, i + QUOTE_WORDS_PER_LINE).join(" ");
    const first = i === 0 ? '"' : "";
    const last = i + QUOTE_WORDS_PER_LINE >= words.length;
    lines.push(`> ${first}${chunk}${last ? '."' : ","}`);
  }
  return [...lines, ">", "> — Field Notes"].join("\n");
}

function decodeQuote(text: string): Uint8Array | null {
  const lines = text.split("\n");
  if (
    lines.length < 3 ||
    lines.at(-2) !== ">" ||
    lines.at(-1) !== "> — Field Notes"
  ) {
    return null;
  }
  const bodyLines = lines.slice(0, -2);
  const words: string[] = [];
  let closingQuote = '"';
  for (let i = 0; i < bodyLines.length; i++) {
    let line = bodyLines[i];
    if (!line.startsWith("> ")) return null;
    line = line.slice(2);
    if (i === 0) {
      if (line.startsWith('"')) {
        closingQuote = '"';
      } else if (line.startsWith("“")) {
        closingQuote = "”";
      } else {
        return null;
      }
      line = line.slice(1);
    }
    const last = i === bodyLines.length - 1;
    if (last) {
      if (!line.endsWith(`.${closingQuote}`)) return null;
      line = line.slice(0, -2);
    } else {
      if (!line.endsWith(",")) return null;
      line = line.slice(0, -1);
    }
    const lineWords = line.split(" ");
    if (
      lineWords.length === 0 ||
      lineWords.length > QUOTE_WORDS_PER_LINE ||
      (!last && lineWords.length !== QUOTE_WORDS_PER_LINE)
    ) {
      return null;
    }
    words.push(...lineWords);
  }
  const tokens: number[] = [];
  for (const word of words) {
    const token = QUOTE_WORD_INDEX.get(word);
    if (token === undefined) return null;
    tokens.push(token);
  }
  return sixBitTokensToBytes(tokens);
}

/** 给撰写页使用的文本长度近似；code 取四种语言模板上界。 */
export function estimateSecretAppearanceLength(
  byteLength: number,
  style: SecretCipherStyle
): number {
  const bytes = Math.max(0, Math.floor(byteLength));
  if (style === "classic") return bytes + Math.round(bytes / 6) + 3;
  if (style === "code") {
    const overhead = Math.max(
      ...CODE_LANGUAGES.map((language) => renderCode("", language).length)
    );
    return bytes * 2 + overhead;
  }
  if (style === "log") {
    const hexLength = bytes * 2;
    const chunks = Math.max(1, Math.ceil(hexLength / LOG_HEX_CHUNK_LENGTH));
    const totalDigits = String(chunks).length;
    let length = hexLength + Math.max(0, chunks - 1);
    for (let i = 1; i <= chunks; i++) {
      length +=
        24 +
        " INFO cache.restore trace=".length +
        8 +
        " chunk=".length +
        String(i).length +
        1 +
        totalDigits +
        " payload=".length;
    }
    return length;
  }
  if (style === "quote") {
    const tokens = Math.ceil((bytes * 8) / 6);
    const lines = Math.max(1, Math.ceil(tokens / QUOTE_WORDS_PER_LINE));
    return Math.round(tokens * QUOTE_AVERAGE_WORD_LENGTH) + tokens + lines * 3 + 19;
  }
  throw new Error("不支持的秘文格式");
}

/** 按最坏模板计算能否落在共同硬上限内；用于加密前 fail-fast。 */
export function isSecretAppearanceLengthSupported(
  byteLength: number,
  style: SecretCipherStyle
): boolean {
  const bytes = Math.max(0, Math.floor(byteLength));
  if (style === "classic") {
    const maxMarks = Math.ceil(Math.max(0, bytes - 1) / 4);
    return bytes + maxMarks + 3 <= MAX_SECRET_APPEARANCE_CHARS;
  }
  if (style === "code" || style === "log") {
    return estimateSecretAppearanceLength(bytes, style) <=
      MAX_SECRET_APPEARANCE_CHARS;
  }
  if (style === "quote") {
    const tokens = Math.ceil((bytes * 8) / 6);
    const lines = Math.max(1, Math.ceil(tokens / QUOTE_WORDS_PER_LINE));
    const maxWordLength = Math.max(...QUOTE_WORDS.map((word) => word.length));
    const maxLength =
      tokens * maxWordLength +
      Math.max(0, tokens - lines) +
      lines * 4 +
      32;
    return maxLength <= MAX_SECRET_APPEARANCE_CHARS;
  }
  throw new Error("不支持的秘文格式");
}

/** 同一信封字节 → 指定文本协议。 */
export function encodeSecretAppearance(
  bytes: Uint8Array,
  style: SecretCipherStyle
): string {
  let encoded: string;
  if (style === "classic") encoded = encodeBytes(bytes);
  else if (style === "code") encoded = encodeCode(bytes);
  else if (style === "log") encoded = encodeLog(bytes);
  else if (style === "quote") encoded = encodeQuote(bytes);
  else throw new Error("不支持的秘文格式");
  if (encoded.length > MAX_SECRET_APPEARANCE_CHARS) {
    throw new Error("秘文内容过长");
  }
  return encoded;
}

const LEGACY_WRAPPERS: ReadonlyArray<{
  style: Exclude<SecretCipherStyle, "classic">;
  pattern: RegExp;
}> = [
  { style: "code", pattern: /^const cacheSnapshot = "「[\s\S]*」";$/ },
  { style: "log", pattern: /^\[debug\] cache\.snapshot=「[\s\S]*」$/ },
  { style: "quote", pattern: /^> 「[\s\S]*」$/ },
];

function decodeLegacyWrappedClassic(
  text: string
): DecodedSecretAppearance | null {
  for (const { style, pattern } of LEGACY_WRAPPERS) {
    if (!pattern.test(text)) continue;
    if (!looksLikeSecret(text, CRYPTO_CONSTANTS.MIN_ENVELOPE_LEN)) return null;
    const bytes = decodeToBytes(text);
    return isEnvelopeCandidate(bytes) ? { style, bytes } : null;
  }
  return null;
}

/**
 * 自动识别四种当前协议以及上一版“外壳包中文”的短期历史格式。新格式必须完整匹配
 * 权威语法，随后统一校验最小信封长度与 magic；普通代码/日志/引用 fail-closed。
 */
export function decodeSecretAppearance(
  text: string
): DecodedSecretAppearance | null {
  if (text.length > MAX_SECRET_APPEARANCE_CHARS) return null;
  const normalized = text.trim().replace(/\r\n/g, "\n");
  const decoders: ReadonlyArray<{
    style: Exclude<SecretCipherStyle, "classic">;
    decode: (value: string) => Uint8Array | null;
  }> = [
    { style: "code", decode: decodeCode },
    { style: "log", decode: decodeLog },
    { style: "quote", decode: decodeQuote },
  ];
  for (const { style, decode } of decoders) {
    const bytes = decode(normalized);
    if (isEnvelopeCandidate(bytes)) return { style, bytes };
  }

  const legacy = decodeLegacyWrappedClassic(normalized);
  if (legacy) return legacy;

  if (!looksLikeSecret(normalized, CRYPTO_CONSTANTS.MIN_ENVELOPE_LEN)) {
    return null;
  }
  const classic = decodeToBytes(normalized);
  return isEnvelopeCandidate(classic) ? { style: "classic", bytes: classic } : null;
}
