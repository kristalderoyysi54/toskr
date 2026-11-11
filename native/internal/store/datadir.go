package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// 数据目录切换与定期自动备份（同 Tauri storage.rs 切换数据目录 / commands.rs run_auto_backup）。
// 数据目录由数据文件、media/、recovery/ 与 IM 消息账本组成；诊断日志与目录指针始终留在默认目录。

// dirEntries 是迁移时要复制的数据目录成员。
var dirEntries = []string{DataFile, "media", "recovery", "toskr-im-message-watch.jsonl"}

// DirInfo 是数据目录预检结果。
type DirInfo struct {
	HasData             bool      // 有数据文件且能用本机密钥解开
	Notes, Tasks, Media int       // 笔记 / 任务 / 媒体文件数
	ModAt               time.Time // 数据文件最后写入
	Stray               bool      // 没有数据文件却有 media/ 等残留——不能当空目录迁入
}

// InspectDir 只读预检 dir：不存在或不是目录报错；数据文件解不开（别的钥匙串 / 损坏）报错。
func InspectDir(dir string, key []byte) (DirInfo, error) {
	var info DirInfo
	fi, err := os.Stat(dir)
	if err != nil {
		return info, err
	}
	if !fi.IsDir() {
		return info, errors.New("不是文件夹")
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "media"))
	info.Media = len(entries)
	df, err := os.Stat(filepath.Join(dir, DataFile))
	if errors.Is(err, os.ErrNotExist) {
		info.Stray = info.Media > 0
		return info, nil
	}
	if err != nil {
		return info, err
	}
	s, err := OpenDir(dir, key)
	if err != nil {
		return info, fmt.Errorf("无法读取该目录的数据（%w）：可能来自另一台电脑的钥匙串或已损坏", err)
	}
	info.HasData, info.ModAt = true, df.ModTime()
	info.Notes, info.Tasks = len(s.notes), len(s.tasks)
	return info, nil
}

// SameOrNested：两个目录相同或互相包含（迁移会递归复制自己）。
func SameOrNested(a, b string) bool {
	clean := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			p = r
		} else if r, err := filepath.EvalSymlinks(filepath.Dir(p)); err == nil { // 还不存在的子目录：按父目录解析
			p = filepath.Join(r, filepath.Base(p))
		}
		return filepath.Clean(p) + string(filepath.Separator)
	}
	x, y := clean(a), clean(b)
	return strings.HasPrefix(x, y) || strings.HasPrefix(y, x)
}

// CopyTo 把当前数据落盘后完整复制到 dst（dst 里不能已有数据文件），再从 dst 重新读一遍核对条数。
// 原目录保持不动。
func (s *Store) CopyTo(dst string) (DirInfo, error) {
	if err := s.Flush(); err != nil {
		return DirInfo{}, err
	}
	if _, err := os.Stat(filepath.Join(dst, DataFile)); err == nil {
		return DirInfo{}, errors.New("目标目录已有数据文件")
	}
	s.writeMu.Lock() // 复制期间不让后台落盘改写数据文件
	err := func() error {
		for _, name := range dirEntries {
			if err := copyTree(filepath.Join(s.dir, name), filepath.Join(dst, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
		return nil
	}()
	s.writeMu.Unlock()
	if err != nil {
		return DirInfo{}, err
	}
	info, err := InspectDir(dst, s.key)
	if err != nil {
		return info, err
	}
	s.mu.Lock()
	notes, tasks := len(s.notes), len(s.tasks)
	s.mu.Unlock()
	if !info.HasData || info.Notes != notes || info.Tasks != tasks {
		return info, fmt.Errorf("复制后核对不一致：笔记 %d/%d、任务 %d/%d", info.Notes, notes, info.Tasks, tasks)
	}
	return info, nil
}

func copyTree(src, dst string) error {
	fi, err := os.Stat(src)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return copyFile(src, dst)
	}
	if err := os.MkdirAll(dst, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") { // 半写的临时文件
			continue
		}
		if err := copyTree(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp-" + newID()
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

// 定期自动备份：每 24 小时一份加密完整备份（含媒体），保留最近 N 份；失败 6 小时后再试。
const (
	AutoBackupInterval = 24 * time.Hour
	AutoBackupRetry    = 6 * time.Hour
	autoBackupPrefix   = "Toskr-Native-自动备份-" // 与 Tauri 的「Toskr-自动备份-」错开，同目录也不会互删
	autoBackupSuffix   = ".toskr-backup"
)

var AutoBackupKeepOptions = []int{3, 7, 14, 30}

func (st Settings) BackupKeep() int {
	if slices.Contains(AutoBackupKeepOptions, st.AutoBackupKeep) {
		return st.AutoBackupKeep
	}
	return 7
}

// AutoBackupDue 同 Tauri autoBackupDue：开着、不在失败冷却期、距上次满 24 小时（或上次时间在未来——改过系统时钟）。
func AutoBackupDue(st Settings, now, lastFail time.Time) bool {
	if st.AutoBackupOff {
		return false
	}
	if !lastFail.IsZero() && now.Sub(lastFail) < AutoBackupRetry {
		return false
	}
	last := st.AutoBackupAt
	return last.IsZero() || now.Sub(last) >= AutoBackupInterval || last.After(now)
}

// AutoBackupName：Toskr-Native-自动备份-YYYYMMDD-HHMMSS.toskr-backup（本地时间，按名排序即时间序）。
func AutoBackupName(t time.Time) string {
	return autoBackupPrefix + t.Format("20060102-150405") + autoBackupSuffix
}

func IsAutoBackupName(name string) bool {
	stamp, ok := strings.CutPrefix(name, autoBackupPrefix)
	if !ok {
		return false
	}
	if stamp, ok = strings.CutSuffix(stamp, autoBackupSuffix); !ok || len(stamp) != 15 {
		return false
	}
	_, err := time.Parse("20060102-150405", stamp)
	return err == nil
}

// PruneAutoBackups 删掉 dir 里超出 keep 份的最旧自动备份；别的文件一概不碰。
func PruneAutoBackups(dir string, keep int) (int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	var names []string
	for _, e := range entries {
		if e.Type().IsRegular() && IsAutoBackupName(e.Name()) {
			names = append(names, e.Name())
		}
	}
	slices.Sort(names)
	n := 0
	for _, name := range names[:max(0, len(names)-max(1, keep))] {
		if os.Remove(filepath.Join(dir, name)) == nil {
			n++
		}
	}
	return n, nil
}

// ReplaceFromBackup 整份恢复（同 Tauri 完整备份导入）：先写恢复点，再用备份内容替换全部数据；设置保留本机。
func (s *Store) ReplaceFromBackup(p *Preview) error {
	if err := s.Flush(); err != nil {
		return err
	}
	if _, err := s.WriteRecoveryPoint("pre-restore", time.Now()); err != nil {
		return fmt.Errorf("恢复点写入失败，已中止恢复：%w", err)
	}
	for _, img := range p.media {
		if _, err := s.SaveImage(img); err != nil {
			return err
		}
	}
	sn := p.snap
	if err := s.mutate(func() bool {
		s.notes, s.sections, s.tasks, s.taskSections = sn.Notes, sn.Sections, sn.Tasks, sn.TaskSections
		s.bills, s.secrets, s.deliveries, s.outcomes = sn.Bills, sn.Secrets, sn.Deliveries, sn.Outcomes
		s.messages, s.messagesGone = sn.Messages, sn.MessagesGone
		return true
	}); err != nil {
		return err
	}
	s.ensureDefaults()
	return s.Flush()
}

// RekeyTo 把整库（笔记、任务、账单、秘文、发送记录、消息、设置与图片）用另一把密钥 key 写到 dst
// （dst 里不能已有数据文件），再从 dst 用新密钥读回核对。原目录与原密钥下的文件保持不动。
// 用途：迭代期的原生版数据交接给正式版（两者的数据密钥不同，直接复制目录解不开）。恢复点不带过去。
func (s *Store) RekeyTo(dst string, key []byte) (DirInfo, error) {
	if err := s.Flush(); err != nil {
		return DirInfo{}, err
	}
	if len(key) != 32 {
		return DirInfo{}, errors.New("新密钥长度不对")
	}
	if SameOrNested(s.dir, dst) {
		return DirInfo{}, errors.New("目标目录不能与当前数据目录重叠")
	}
	if _, err := os.Stat(filepath.Join(dst, DataFile)); err == nil {
		return DirInfo{}, errors.New("目标目录已有数据文件")
	}
	s.mu.Lock()
	plain, err := json.Marshal(s.snapshotLocked())
	s.mu.Unlock()
	if err != nil {
		return DirInfo{}, err
	}
	var sn snapshot // 经 JSON 深拷贝一份，与本库不共享切片
	if err := json.Unmarshal(plain, &sn); err != nil {
		return DirInfo{}, err
	}
	t, err := OpenDir(dst, key)
	if err != nil {
		return DirInfo{}, err
	}
	entries, _ := os.ReadDir(s.mediaDir())
	for _, e := range entries {
		if e.IsDir() || !mediaName.MatchString(e.Name()) {
			continue
		}
		raw, err := s.LoadImage(e.Name())
		if err != nil {
			continue // 本来就读不出的图：不带过去（引用它的笔记照旧显示缺图）
		}
		name, err := t.SaveImage(raw)
		if err != nil {
			return DirInfo{}, err
		}
		if name != e.Name() {
			return DirInfo{}, fmt.Errorf("图片 %s 重存后文件名变成 %s", e.Name(), name)
		}
	}
	if err := t.mutate(func() bool {
		t.notes, t.sections, t.tasks, t.taskSections = sn.Notes, sn.Sections, sn.Tasks, sn.TaskSections
		t.bills, t.secrets, t.deliveries, t.outcomes = sn.Bills, sn.Secrets, sn.Deliveries, sn.Outcomes
		t.messages, t.messagesGone, t.settings = sn.Messages, sn.MessagesGone, sn.Settings
		return true
	}); err != nil {
		return DirInfo{}, err
	}
	if err := t.Flush(); err != nil {
		return DirInfo{}, err
	}
	const ledger = "toskr-im-message-watch.jsonl" // 消息账本（不加密）
	if err := copyFile(filepath.Join(s.dir, ledger), filepath.Join(dst, ledger)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return DirInfo{}, err
	}
	info, err := InspectDir(dst, key)
	if err != nil {
		return info, err
	}
	if !info.HasData || info.Notes != len(sn.Notes) || info.Tasks != len(sn.Tasks) {
		return info, fmt.Errorf("交接后核对不一致：笔记 %d/%d、任务 %d/%d", info.Notes, len(sn.Notes), info.Tasks, len(sn.Tasks))
	}
	return info, nil
}
