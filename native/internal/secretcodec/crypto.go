// Package secretcodec 是 src/lib/secret 秘文管线的 Go 移植，与 TS 版逐字节线兼容。
//
// 信封：magic 2B | version 1B | salt 16B | iv 12B | AES-256-GCM 密文（含 16B tag）；
// 密钥 = PBKDF2-SHA256(UTF-8 口令, salt, 150000)；明文按 UTF-16LE 编码。
// ⚠️ 发布后冻结：常量与布局改动必须升 version 并保留旧版解码分支（同 crypto.ts）。
package secretcodec

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"unicode/utf16"
)

const (
	version          = 1
	saltLen          = 16
	ivLen            = 12
	headerLen        = 2 + 1 + saltLen + ivLen
	gcmTagLen        = 16
	minEnvelopeLen   = headerLen + gcmTagLen
	pbkdf2Iterations = 150_000
	keyLen           = 32
)

// magic 经中文码本恰好渲染成「话说」开头。
var magic = [2]byte{0x86, 0x17}

var (
	errTooShort   = errors.New("密文过短")
	errBadMagic   = errors.New("非秘文信封")
	errBadVersion = errors.New("秘文版本不支持")
)

// utf16Len 等价 JS string.length（UTF-16 code unit 数）。
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// utf16leEncode 按 code unit 输出 UTF-16LE（代理对完整保留）。
func utf16leEncode(s string) []byte {
	units := utf16.Encode([]rune(s))
	out := make([]byte, len(units)*2)
	for i, u := range units {
		out[i*2] = byte(u)
		out[i*2+1] = byte(u >> 8)
	}
	return out
}

// utf16leDecode 忽略奇数尾字节；孤立代理项无法放进 Go string，落为 U+FFFD。
func utf16leDecode(b []byte) string {
	units := make([]uint16, len(b)/2)
	for i := range units {
		units[i] = uint16(b[i*2]) | uint16(b[i*2+1])<<8
	}
	return string(utf16.Decode(units))
}

func newGCM(passphrase string, salt []byte) (cipher.AEAD, error) {
	key, err := pbkdf2.Key(sha256.New, passphrase, salt, pbkdf2Iterations, keyLen)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// encryptWith 用给定 salt/iv 生成信封；仅供 encryptToBytes 与固定向量测试。
func encryptWith(plaintext, passphrase string, salt, iv []byte) ([]byte, error) {
	aead, err := newGCM(passphrase, salt)
	if err != nil {
		return nil, err
	}
	out := make([]byte, headerLen, headerLen+len(plaintext)*4+gcmTagLen)
	out[0], out[1], out[2] = magic[0], magic[1], version
	copy(out[3:], salt)
	copy(out[3+saltLen:], iv)
	return aead.Seal(out, iv, utf16leEncode(plaintext), nil), nil
}

// encryptToBytes 明文 + 口令 → 信封字节（每次随机 salt/iv）。
func encryptToBytes(plaintext, passphrase string) ([]byte, error) {
	var nonce [saltLen + ivLen]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	return encryptWith(plaintext, passphrase, nonce[:saltLen], nonce[saltLen:])
}

// decryptFromBytes 信封字节 + 口令 → 明文；头部非法或认证失败均返回错误。
func decryptFromBytes(b []byte, passphrase string) (string, error) {
	if len(b) < minEnvelopeLen {
		return "", errTooShort
	}
	if b[0] != magic[0] || b[1] != magic[1] {
		return "", errBadMagic
	}
	if b[2] != version {
		return "", errBadVersion
	}
	aead, err := newGCM(passphrase, b[3:3+saltLen])
	if err != nil {
		return "", err
	}
	plain, err := aead.Open(nil, b[3+saltLen:headerLen], b[headerLen:], nil)
	if err != nil {
		return "", err
	}
	return utf16leDecode(plain), nil
}
