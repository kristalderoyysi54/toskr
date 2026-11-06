package store

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
)

const (
	RecoveryKeep   = 8
	recoveryPrefix = "pre-launch-"
)

// Manifest 记录备份的条数与明文哈希（哈希按明文计：重新加密不影响等价性判断）。
type Manifest struct {
	Format    string            `json:"format"`
	CreatedAt time.Time         `json:"createdAt"`
	Counts    map[string]int    `json:"counts"`
	DataSHA   string            `json:"dataSha256"`
	Media     map[string]string `json:"media"` // 文件名 → 明文 sha256
}

func counts(sn snapshot) map[string]int {
	return map[string]int{"notes": len(sn.Notes), "sections": len(sn.Sections), "tasks": len(sn.Tasks),
		"bills": len(sn.Bills), "secrets": len(sn.Secrets)}
}

// ExportBackup 写 .toskr-backup（zip）：manifest.json + data.sealed + media/*.sealed。
// 加密用本机数据密钥（与 Tauri 版一致：换机需同一钥匙串）。
func (s *Store) ExportBackup(path string) (Manifest, error) {
	if err := s.Flush(); err != nil {
		return Manifest{}, err
	}
	s.mu.Lock()
	sn := s.snapshotLocked()
	s.mu.Unlock()
	plain, err := json.Marshal(sn)
	if err != nil {
		return Manifest{}, err
	}
	sum := sha256.Sum256(plain)
	man := Manifest{Format: "toskr-native-backup/1", CreatedAt: time.Now(), Counts: counts(sn), DataSHA: hex.EncodeToString(sum[:]), Media: map[string]string{}}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	sealed, err := Seal(s.key, PurposeBackup, plain)
	if err != nil {
		return Manifest{}, err
	}
	if err := writeZip(zw, "data.sealed", sealed); err != nil {
		return Manifest{}, err
	}
	for _, n := range sn.Notes {
		if n.ImageFile == "" || man.Media[n.ImageFile] != "" {
			continue
		}
		img, err := s.LoadImage(n.ImageFile)
		if err != nil {
			continue // 缺失媒体只在健康检查里报告，不阻断备份
		}
		h := sha256.Sum256(img)
		man.Media[n.ImageFile] = hex.EncodeToString(h[:])
		ms, _ := Seal(s.key, PurposeBackup, img)
		if err := writeZip(zw, "media/"+n.ImageFile+".sealed", ms); err != nil {
			return Manifest{}, err
		}
	}
	mj, _ := json.MarshalIndent(man, "", "  ")
	if err := writeZip(zw, "manifest.json", mj); err != nil {
		return Manifest{}, err
	}
	if err := zw.Close(); err != nil {
		return Manifest{}, err
	}
	return man, atomicWrite(path, buf.Bytes())
}

func writeZip(zw *zip.Writer, name string, data []byte) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

// Preview 是导入预检结果。
type Preview struct {
	Manifest     Manifest
	New, Overlap int // 备份里本机没有的笔记数 / 双方都有的笔记数
	MissingMedia int
	snap         snapshot
	media        map[string][]byte
}

// InspectBackup 校验备份（认证解密 + 明文哈希 + 媒体哈希）并给出合并预览，不改任何数据。
func (s *Store) InspectBackup(path string) (*Preview, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, errors.New("不是有效的备份文件")
	}
	files := map[string][]byte{}
	for _, f := range zr.File {
		if f.UncompressedSize64 > 256<<20 {
			return nil, errors.New("备份内单个文件过大")
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return nil, err
		}
		files[f.Name] = b
	}
	var man Manifest
	if err := json.Unmarshal(files["manifest.json"], &man); err != nil || !strings.HasPrefix(man.Format, "toskr-native-backup/") {
		return nil, errors.New("备份清单缺失或格式不支持")
	}
	plain, err := Open(s.key, PurposeBackup, files["data.sealed"])
	if err != nil {
		return nil, fmt.Errorf("无法解开备份（%w）：需要同一钥匙串的数据密钥", err)
	}
	if sum := sha256.Sum256(plain); hex.EncodeToString(sum[:]) != man.DataSHA {
		return nil, errors.New("备份数据与清单哈希不一致")
	}
	p := &Preview{Manifest: man, media: map[string][]byte{}}
	if err := json.Unmarshal(plain, &p.snap); err != nil {
		return nil, ErrCorrupt
	}
	for name, want := range man.Media {
		mb, err := Open(s.key, PurposeBackup, files["media/"+name+".sealed"])
		if h := sha256.Sum256(mb); err != nil || hex.EncodeToString(h[:]) != want {
			p.MissingMedia++
			continue
		}
		p.media[name] = mb
	}
	s.mu.Lock()
	for _, n := range p.snap.Notes {
		if s.index(n.ID) >= 0 {
			p.Overlap++
		} else {
			p.New++
		}
	}
	s.mu.Unlock()
	return p, nil
}

// ImportBackup 合并导入：先写恢复点；备份作历史基线，本机同 ID 记录优先，只补本机没有的。
func (s *Store) ImportBackup(p *Preview) (added int, err error) {
	if _, err := s.WriteRecoveryPoint("pre-import", time.Now()); err != nil {
		return 0, fmt.Errorf("恢复点写入失败，已中止导入：%w", err)
	}
	for _, img := range p.media {
		if _, err := s.SaveImage(img); err != nil {
			return 0, err
		}
	}
	err = s.mutate(func() bool {
		mergeByID(&s.notes, p.snap.Notes, func(n Note) string { return n.ID }, &added)
		var dummy int
		mergeByID(&s.sections, p.snap.Sections, func(x Section) string { return x.ID }, &dummy)
		mergeByID(&s.tasks, p.snap.Tasks, func(x Task) string { return x.ID }, &dummy)
		mergeByID(&s.taskSections, p.snap.TaskSections, func(x Section) string { return x.ID }, &dummy)
		mergeByID(&s.bills, p.snap.Bills, func(x Bill) string { return x.ID }, &dummy)
		mergeByID(&s.secrets, p.snap.Secrets, func(x Secret) string { return x.ID }, &dummy)
		mergeByID(&s.deliveries, p.snap.Deliveries, func(x Delivery) string { return x.ID }, &dummy)
		return true
	})
	if err == nil {
		err = s.Flush()
	}
	return added, err
}

func mergeByID[T any](cur *[]T, hist []T, id func(T) string, added *int) {
	have := map[string]bool{}
	for _, x := range *cur {
		have[id(x)] = true
	}
	for _, x := range hist {
		if !have[id(x)] {
			*cur = append(*cur, x)
			*added++
		}
	}
}

// WriteRecoveryPoint 把当前已落盘的数据另存为恢复点（与上一份内容相同则跳过），保留最近 8 份。
func (s *Store) WriteRecoveryPoint(tag string, now time.Time) (string, error) {
	raw, err := os.ReadFile(filepath.Join(s.dir, DataFile))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	plain := raw
	if Sealed(raw) {
		if plain, err = Open(s.key, PurposeData, raw); err != nil {
			return "", err
		}
	}
	dir := filepath.Join(s.dir, "recovery")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	existing := s.RecoveryPoints()
	if n := len(existing); n > 0 {
		if prev, err := os.ReadFile(existing[n-1]); err == nil {
			if old, err := Open(s.key, PurposeRecovery, prev); err == nil && bytes.Equal(old, plain) {
				return "", nil
			}
		}
	}
	sealed, err := Seal(s.key, PurposeRecovery, plain)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, fmt.Sprintf("%s%013d-%s.bak", recoveryPrefix, now.UnixMilli(), tag))
	if err := atomicWrite(path, sealed); err != nil {
		return "", err
	}
	all := append(existing, path)
	for len(all) > RecoveryKeep {
		_ = os.Remove(all[0])
		all = all[1:]
	}
	return path, nil
}

func (s *Store) RecoveryPoints() []string {
	matches, _ := filepath.Glob(filepath.Join(s.dir, "recovery", recoveryPrefix+"*.bak"))
	sort.Strings(matches)
	return matches
}

// RestoreRecoveryPoint 用恢复点替换当前数据（先把当前数据再存一个恢复点）。
func (s *Store) RestoreRecoveryPoint(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	plain, err := Open(s.key, PurposeRecovery, raw)
	if err != nil {
		return err
	}
	var sn snapshot
	if err := json.Unmarshal(plain, &sn); err != nil {
		return ErrCorrupt
	}
	if err := s.Flush(); err != nil {
		return err
	}
	if _, err := s.WriteRecoveryPoint("pre-restore", time.Now()); err != nil {
		return err
	}
	err = s.mutate(func() bool {
		s.notes, s.settings = sn.Notes, mergeSettings(sn.Settings)
		s.sections, s.tasks, s.taskSections, s.bills, s.secrets = sn.Sections, sn.Tasks, sn.TaskSections, sn.Bills, sn.Secrets
		return true
	})
	s.ensureDefaults()
	return err
}

// Health 是数据健康检查：只报告，不自动删改。
type Health struct {
	Notes, MissingMedia, OrphanMedia, OrphanSectionRefs int
}

func (s *Store) CheckHealth() Health {
	s.mu.Lock()
	notes := slices.Clone(s.notes)
	secs := map[string]bool{}
	for _, x := range s.sections {
		secs[x.ID] = true
	}
	s.mu.Unlock()
	h := Health{Notes: len(notes)}
	used := map[string]bool{}
	for _, n := range notes {
		if !secs[n.Section] {
			h.OrphanSectionRefs++
		}
		if n.ImageFile != "" {
			used[n.ImageFile] = true
			if _, err := os.Stat(filepath.Join(s.mediaDir(), n.ImageFile)); err != nil {
				h.MissingMedia++
			}
		}
	}
	entries, _ := os.ReadDir(s.mediaDir())
	for _, e := range entries {
		if mediaName.MatchString(e.Name()) && !used[e.Name()] {
			h.OrphanMedia++
		}
	}
	return h
}
