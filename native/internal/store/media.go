package store

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
)

var mediaName = regexp.MustCompile(`^[0-9a-f]{32}\.png$`)

func (s *Store) mediaDir() string { return filepath.Join(s.dir, "media") }

// SaveImage 按内容哈希存图片（同一张图永远同名，天然去重），磁盘上加密。
func (s *Store) SaveImage(png []byte) (string, error) {
	sum := sha256.Sum256(png)
	name := hex.EncodeToString(sum[:16]) + ".png"
	path := filepath.Join(s.mediaDir(), name)
	if _, err := os.Stat(path); err == nil {
		return name, nil
	}
	if err := os.MkdirAll(s.mediaDir(), 0o700); err != nil {
		return "", err
	}
	sealed, err := Seal(s.key, PurposeMedia, png)
	if err != nil {
		return "", err
	}
	return name, atomicWrite(path, sealed)
}

func (s *Store) LoadImage(name string) ([]byte, error) {
	if !mediaName.MatchString(name) {
		return nil, errors.New("非法媒体文件名")
	}
	raw, err := os.ReadFile(filepath.Join(s.mediaDir(), name))
	if err != nil {
		return nil, err
	}
	return Open(s.key, PurposeMedia, raw)
}

// GCMedia 删除不再被任何笔记引用的媒体文件，返回删除数量。
func (s *Store) GCMedia() int {
	s.mu.Lock()
	used := map[string]bool{}
	for _, n := range s.notes {
		for _, f := range n.MediaFiles() {
			used[f] = true
		}
	}
	for _, b := range s.bills {
		if b.IconFile != "" {
			used[b.IconFile] = true
		}
	}
	s.mu.Unlock()
	entries, _ := os.ReadDir(s.mediaDir())
	removed := 0
	for _, e := range entries {
		if mediaName.MatchString(e.Name()) && !used[e.Name()] {
			if os.Remove(filepath.Join(s.mediaDir(), e.Name())) == nil {
				removed++
			}
		}
	}
	return removed
}
