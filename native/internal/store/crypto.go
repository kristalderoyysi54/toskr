package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
)

// 信封格式与 Rust 版 data_crypto 一致：TSK1 | version(1) | nonce(12) | ciphertext+tag。
// AAD 写入用途，防止拿 A 文件密文覆盖 B 文件仍能解开。格式发布即冻结。
var (
	magic          = []byte("TSK1")
	ErrKey         = errors.New("数据密钥不可用")
	ErrCorrupt     = errors.New("密文损坏或用途不匹配")
	envelopeVer    = byte(1)
	envelopeHeader = len(magic) + 1 + 12
)

// Purpose 是 AAD 用途标签。
type Purpose string

const (
	PurposeData     Purpose = "data"
	PurposeRecovery Purpose = "recovery"
)

func Sealed(b []byte) bool { return len(b) >= 4 && string(b[:4]) == string(magic) }

func Seal(key []byte, p Purpose, plain []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	out := make([]byte, envelopeHeader, envelopeHeader+len(plain)+gcm.Overhead())
	copy(out, magic)
	out[4] = envelopeVer
	if _, err := rand.Read(out[5:envelopeHeader]); err != nil {
		return nil, err
	}
	return gcm.Seal(out, out[5:envelopeHeader], plain, []byte(p)), nil
}

func Open(key []byte, p Purpose, sealed []byte) ([]byte, error) {
	if !Sealed(sealed) || len(sealed) < envelopeHeader+16 || sealed[4] != envelopeVer {
		return nil, ErrCorrupt
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, sealed[5:envelopeHeader], sealed[envelopeHeader:], []byte(p))
	if err != nil {
		return nil, ErrCorrupt
	}
	return plain, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, ErrKey
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrKey
	}
	return cipher.NewGCM(block)
}
