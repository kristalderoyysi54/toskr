package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCopyToAndInspectDir(t *testing.T) {
	src := t.TempDir()
	s, _ := OpenDir(src, key)
	s.Add(Note{Section: SectionInbox, Text: "迁移我"})
	s.AddTask(Task{Text: "任务一"})
	if _, err := s.SaveImage([]byte("png-bytes")); err != nil {
		t.Fatal(err)
	}
	empty := t.TempDir()
	if info, err := InspectDir(empty, key); err != nil || info.HasData || info.Stray {
		t.Fatalf("空目录应可迁入：%+v %v", info, err)
	}
	info, err := s.CopyTo(empty)
	if err != nil || !info.HasData || info.Notes != len(s.Notes()) || info.Tasks != 1 || info.Media != 1 {
		t.Fatalf("%+v %v", info, err)
	}
	if _, err := s.CopyTo(empty); err == nil {
		t.Fatal("目标已有数据文件时不能再迁入")
	}
	if _, err := InspectDir(empty, []byte("0123456789abcdef0123456789abcdef")); err == nil {
		t.Fatal("别的密钥解不开应报错")
	}
	stray := t.TempDir()
	os.MkdirAll(filepath.Join(stray, "media"), 0o700)
	os.WriteFile(filepath.Join(stray, "media", "x"), []byte("1"), 0o600)
	if info, _ := InspectDir(stray, key); !info.Stray {
		t.Fatal("只有 media 没有数据文件应判为残留")
	}
	if !SameOrNested(src, filepath.Join(src, "sub")) || SameOrNested(src, empty) {
		t.Fatal("嵌套判断")
	}
}

func TestAutoBackupScheduleAndPrune(t *testing.T) {
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.Local)
	st := Settings{}
	if !AutoBackupDue(st, now, time.Time{}) {
		t.Fatal("从未备份应到期")
	}
	st.AutoBackupAt = now.Add(-time.Hour)
	if AutoBackupDue(st, now, time.Time{}) {
		t.Fatal("1 小时前刚备份过")
	}
	st.AutoBackupAt = now.Add(-25 * time.Hour)
	if !AutoBackupDue(st, now, time.Time{}) || AutoBackupDue(st, now, now.Add(-time.Hour)) {
		t.Fatal("满 24 小时到期；失败后 6 小时内不重试")
	}
	if st.AutoBackupOff = true; AutoBackupDue(st, now, time.Time{}) {
		t.Fatal("关了不备份")
	}
	if (Settings{AutoBackupKeep: 5}).BackupKeep() != 7 || (Settings{AutoBackupKeep: 14}).BackupKeep() != 14 {
		t.Fatal("保留份数只认 3/7/14/30")
	}
	dir := t.TempDir()
	for i := range 5 {
		os.WriteFile(filepath.Join(dir, AutoBackupName(now.Add(time.Duration(i)*time.Hour))), nil, 0o600)
	}
	os.WriteFile(filepath.Join(dir, "Toskr-自动备份-20260101-000000.toskr-backup"), nil, 0o600) // Tauri 的，不碰
	os.WriteFile(filepath.Join(dir, "我的文件.txt"), nil, 0o600)
	if n, err := PruneAutoBackups(dir, 3); err != nil || n != 2 {
		t.Fatal(n, err)
	}
	left, _ := os.ReadDir(dir)
	if len(left) != 5 {
		t.Fatalf("应剩 3 份自动备份 + 2 个别的文件：%v", left)
	}
	if _, err := os.Stat(filepath.Join(dir, AutoBackupName(now))); err == nil {
		t.Fatal("最旧的应被删")
	}
}

func TestReplaceFromBackup(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), key)
	s.Add(Note{Section: SectionInbox, Text: "备份里的"})
	path := filepath.Join(t.TempDir(), "b.toskr-backup")
	if _, err := s.ExportBackup(path); err != nil {
		t.Fatal(err)
	}
	s.Add(Note{Section: SectionInbox, Text: "备份之后加的"})
	p, err := s.InspectBackup(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ReplaceFromBackup(p); err != nil {
		t.Fatal(err)
	}
	for _, n := range s.Notes() {
		if n.Text == "备份之后加的" {
			t.Fatal("整份恢复应替换掉备份之后的数据")
		}
	}
	if len(s.RecoveryPoints()) == 0 {
		t.Fatal("恢复前应写恢复点")
	}
}
