package store

import (
	"slices"
	"time"

	"github.com/toskr/native/internal/secretcodec"
)

// Secret 是「内容 → 秘文」的一张卡（对应 Tauri kind="secret" 的 Note）：
// Text 存密文信封原文，明文永不落盘，解密只在内存。KeyID 为空 = 收到但本机没有匹配密钥。
type Secret struct {
	ID        string    `json:"id"`
	Text      string    `json:"text"`
	KeyID     string    `json:"keyId,omitempty"`
	KeyLabel  string    `json:"keyLabel,omitempty"`
	Direction string    `json:"direction"` // in | out
	SourceApp string    `json:"sourceApp,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// SecretKey 是与对方约定的共享密钥（同 Tauri settings.secretKeys；随加密数据文件保存）。
type SecretKey struct {
	ID         string    `json:"id"`
	Label      string    `json:"label"`
	Passphrase string    `json:"passphrase"`
	Note       string    `json:"note,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

func (s *Store) Secrets() []Secret { s.mu.Lock(); defer s.mu.Unlock(); return slices.Clone(s.secrets) }

// AddSecret 收进一张秘文卡；同一信封（跨格式指纹相同）已在则返回 "duplicate"，空文本 "empty"。
func (s *Store) AddSecret(sec Secret) (Secret, string) {
	fp, ok := secretcodec.Fingerprint(sec.Text)
	if !ok {
		return Secret{}, "empty"
	}
	result := "added"
	_ = s.mutate(func() bool {
		for _, x := range s.secrets {
			if f, _ := secretcodec.Fingerprint(x.Text); f == fp {
				sec, result = x, "duplicate"
				return false
			}
		}
		sec.ID = newID()
		if sec.CreatedAt.IsZero() {
			sec.CreatedAt = time.Now()
		}
		if sec.Direction == "" {
			sec.Direction = "in"
		}
		s.secrets = slices.Insert(s.secrets, 0, sec)
		return true
	})
	return sec, result
}

func (s *Store) DeleteSecret(id string) (removed Secret, pos int, ok bool) {
	_ = s.mutate(func() bool {
		pos = slices.IndexFunc(s.secrets, func(x Secret) bool { return x.ID == id })
		if pos < 0 {
			return false
		}
		removed, ok = s.secrets[pos], true
		s.secrets = slices.Delete(s.secrets, pos, pos+1)
		return true
	})
	return
}

func (s *Store) RestoreSecret(sec Secret, pos int) error {
	return s.mutate(func() bool {
		if slices.ContainsFunc(s.secrets, func(x Secret) bool { return x.ID == sec.ID }) {
			return false
		}
		s.secrets = slices.Insert(s.secrets, min(max(pos, 0), len(s.secrets)), sec)
		return true
	})
}

// SetSecretKey 解密命中后回写命中密钥（锁定卡在补了密钥后变为可读）。
func (s *Store) SetSecretKey(id, keyID, keyLabel string) error {
	return s.mutate(func() bool {
		i := slices.IndexFunc(s.secrets, func(x Secret) bool { return x.ID == id })
		if i < 0 || (s.secrets[i].KeyID == keyID && s.secrets[i].KeyLabel == keyLabel) {
			return false
		}
		s.secrets[i].KeyID, s.secrets[i].KeyLabel = keyID, keyLabel
		return true
	})
}

// CodecKeys 把设置里的共享密钥转成解码器入参。
func CodecKeys(keys []SecretKey) []secretcodec.Key {
	out := make([]secretcodec.Key, len(keys))
	for i, k := range keys {
		out[i] = secretcodec.Key{ID: k.ID, Label: k.Label, Passphrase: k.Passphrase}
	}
	return out
}
