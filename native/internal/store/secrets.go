package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Secret 是秘文页的一条：明文只在存储加密信封里，界面默认遮罩，显现后自动回遮罩。
type Secret struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"createdAt"`
}

func (s *Store) Secrets() []Secret { s.mu.Lock(); defer s.mu.Unlock(); return slices.Clone(s.secrets) }

func (s *Store) AddSecret(title, body string) Secret {
	sec := Secret{ID: newID(), Title: strings.TrimSpace(title), Body: body, CreatedAt: time.Now()}
	if sec.Title == "" && strings.TrimSpace(body) == "" {
		return Secret{}
	}
	_ = s.mutate(func() bool { s.secrets = slices.Insert(s.secrets, 0, sec); return true })
	return sec
}

func (s *Store) DeleteSecret(id string) bool {
	ok := false
	_ = s.mutate(func() bool {
		i := slices.IndexFunc(s.secrets, func(x Secret) bool { return x.ID == id })
		if i < 0 {
			return false
		}
		s.secrets, ok = slices.Delete(s.secrets, i, i+1), true
		return true
	})
	return ok
}

// ---- 口令封装（发给别人的密文，伪装成一段代码） ----
// 格式：0x86 0x17 0x01 | salt(16) | nonce(12) | ciphertext+tag，PBKDF2-SHA256 20 万轮。
// 外观 = `const cacheSnapshot = "<hex>";`，贴进聊天时看起来像代码片段。

var (
	ErrPassphrase = errors.New("口令错误或密文已损坏")
	ErrNotSealed  = errors.New("没有找到可解密的密文")
	sealMagic     = []byte{0x86, 0x17, 0x01}
	appearanceRe  = regexp.MustCompile(`"([0-9a-f]{90,})"`)
)

const pbkdfIter = 200_000

func passKey(pass string, salt []byte) ([]byte, error) {
	return pbkdf2.Key(sha256.New, pass, salt, pbkdfIter, 32)
}

func SealWithPassphrase(plain, pass string) (string, error) {
	if pass == "" {
		return "", errors.New("口令不能为空")
	}
	salt := make([]byte, 16)
	nonce := make([]byte, 12)
	_, _ = rand.Read(salt)
	_, _ = rand.Read(nonce)
	key, err := passKey(pass, salt)
	if err != nil {
		return "", err
	}
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	out := slices.Concat(sealMagic, salt, nonce, gcm.Seal(nil, nonce, []byte(plain), sealMagic))
	return fmt.Sprintf("const cacheSnapshot = %q;\nexport default cacheSnapshot;", hex.EncodeToString(out)), nil
}

func OpenWithPassphrase(appearance, pass string) (string, error) {
	m := appearanceRe.FindStringSubmatch(appearance)
	if m == nil {
		return "", ErrNotSealed
	}
	raw, err := hex.DecodeString(m[1])
	if err != nil || len(raw) < 3+16+12+16 || string(raw[:3]) != string(sealMagic) {
		return "", ErrNotSealed
	}
	salt, nonce, ct := raw[3:19], raw[19:31], raw[31:]
	key, err := passKey(pass, salt)
	if err != nil {
		return "", err
	}
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, nonce, ct, sealMagic)
	if err != nil {
		return "", ErrPassphrase
	}
	return string(plain), nil
}
