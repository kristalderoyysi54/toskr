package secretcodec

import "encoding/hex"

// 高层管线（对应 secret.ts）：明文 ↔ 指定格式密文，以及「识别 + 逐密钥试解」。

// Style 密文外观；不进入加密信封，也不参与密钥派生。
type Style string

const (
	StyleClassic Style = "classic"
	StyleCode    Style = "code"
	StyleLog     Style = "log"
	StyleQuote   Style = "quote"
)

// StyleOption 设置页/撰写页共用的格式文案。
type StyleOption struct {
	Value      Style
	Label      string
	ShortLabel string
}

// StyleOptions 权威顺序与文案，同 SECRET_CIPHER_STYLE_OPTIONS。
var StyleOptions = []StyleOption{
	{StyleClassic, "中文文本", "中文"},
	{StyleCode, "代码（随机语言）", "代码"},
	{StyleLog, "日志记录", "日志"},
	{StyleQuote, "英文引用", "引用"},
}

// NormalizeStyle 未知/缺省值回落 classic。
func NormalizeStyle(s string) Style {
	for _, o := range StyleOptions {
		if string(o.Value) == s {
			return o.Value
		}
	}
	return StyleClassic
}

// Key 共享密钥。
type Key struct {
	ID, Label, Passphrase string
}

// OpenResult Status 取 "plaintext" | "locked" | "not-secret"；仅 plaintext 时其余字段有值。
type OpenResult struct {
	Status                     string
	Plaintext, KeyID, KeyLabel string
}

// envelopeBytes 信封字节数 = 固定开销 + UTF-16 明文 2B/code unit。
func envelopeBytes(plaintext string) int {
	return minEnvelopeLen + utf16Len(plaintext)*2
}

// Seal 明文 + 口令 + 格式 → 秘文文本（= sealSecret）。
func Seal(plaintext, passphrase string, style Style) (string, error) {
	ok, err := appearanceLengthSupported(envelopeBytes(plaintext), style)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", errTooLong
	}
	b, err := encryptToBytes(plaintext, passphrase)
	if err != nil {
		return "", err
	}
	return encodeAppearance(b, style)
}

// Open 自动识别格式后逐密钥试解，GCM 首个通过者命中（= openSecret）。
func Open(text string, keys []Key) OpenResult {
	_, b := decodeAppearance(text)
	if b == nil {
		return OpenResult{Status: "not-secret"}
	}
	for _, k := range keys {
		if p, err := decryptFromBytes(b, k.Passphrase); err == nil {
			return OpenResult{Status: "plaintext", Plaintext: p, KeyID: k.ID, KeyLabel: k.Label}
		}
	}
	return OpenResult{Status: "locked"}
}

// IsEnvelope 同步判断是否为可解析的秘文信封（= isSecretEnvelope）。
func IsEnvelope(text string) bool {
	_, b := decodeAppearance(text)
	return b != nil
}

// Fingerprint 信封字节 hex，跨格式/换行规范化稳定（= secretEnvelopeFingerprint）。
func Fingerprint(text string) (string, bool) {
	_, b := decodeAppearance(text)
	if b == nil {
		return "", false
	}
	return hex.EncodeToString(b), true
}

// EstimateLength 密文字数（UTF-16 code unit）估算；未知格式返回 -1（TS 版抛错）。
func EstimateLength(plaintext string, style Style) int {
	n, err := estimateAppearanceLength(envelopeBytes(plaintext), style)
	if err != nil {
		return -1
	}
	return n
}

// LengthSupported 输出是否落在接收端共同上限内；未知格式返回 false（TS 版抛错）。
func LengthSupported(plaintext string, style Style) bool {
	ok, _ := appearanceLengthSupported(envelopeBytes(plaintext), style)
	return ok
}
