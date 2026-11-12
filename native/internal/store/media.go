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
// MediaStats：笔记与账单引用的媒体数、带图笔记数，以及其中文件已不在磁盘上的引用数（诊断用）。
func (s *Store) MediaStats() (refs, notes, missing int) {
	s.mu.Lock()
	used := map[string]bool{}
	for _, n := range s.notes {
		fs := n.MediaFiles()
		if len(fs) > 0 {
			notes++
		}
		for _, f := range fs {
			used[f] = true
		}
	}
	for _, b := range s.bills {
		if b.IconFile != "" {
			used[b.IconFile] = true
		}
	}
	for _, m := range s.messages { // IM 消息里的图片
		for _, f := range m.Images {
			used[f] = true
		}
		for _, x := range m.Context {
			for _, f := range x.Images {
				used[f] = true
			}
		}
	}
	s.mu.Unlock()
	for f := range used {
		if _, err := os.Stat(filepath.Join(s.mediaDir(), f)); err != nil {
			missing++
		}
	}
	return len(used), notes, missing
}

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
	for _, m := range s.messages { // IM 消息里的图片
		for _, f := range m.Images {
			used[f] = true
		}
		for _, x := range m.Context {
			for _, f := range x.Images {
				used[f] = true
			}
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
