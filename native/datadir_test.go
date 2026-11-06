package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// 切换数据目录：预检空目录 → 迁移 + 写指针 → 启动解析到新目录；指针目录不在了退回默认目录并提示。
func TestDataDirSwitch(t *testing.T) {
	def := t.TempDir()
	defaultDir = func() string { return def }
	t.Cleanup(func() { defaultDir = dataDir })
	a, _ := testApp(t, "要迁移的笔记")
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 4000)
	a.setJump = "数据与备份"
	set.Frame()
	set.Frame()
	for _, s := range []string{"数据目录", "更改…", "定期自动备份", "立即备份", "备份位置", "保留份数", "7 份"} {
		if !set.HasText(s) {
			t.Fatalf("缺 %q：%v", s, set.Texts())
		}
	}
	if _, err := a.planDataDir(a.store.Dir()); err == nil {
		t.Fatal("当前目录不能再选")
	}
	target := t.TempDir()
	a.previewDataDir(target)
	if a.dirPlan == nil || a.dirPlan.load {
		t.Fatalf("空目录应是迁移计划：%+v", a.dirPlan)
	}
	set.Frame()
	if !set.HasText("迁移当前数据到新目录") || !set.HasText("迁移并重启") {
		t.Fatal(set.Texts())
	}
	if err := a.applyDataDir(a.dirPlan); err != nil {
		t.Fatal(err)
	}
	if dir, missing := activeDataDir(); dir != filepath.Clean(target) || missing != "" {
		t.Fatalf("指针应指向新目录：%s %s", dir, missing)
	}
	// 再预检同一目录：已有数据 → 加载计划
	a2, _ := testApp(t)
	if p, err := a2.planDataDir(target); err != nil || !p.load || p.info.Notes != len(a.store.Notes()) {
		t.Fatalf("%+v %v", p, err)
	}
	os.RemoveAll(target)
	if dir, missing := activeDataDir(); dir != def || missing != filepath.Clean(target) {
		t.Fatalf("目录不在了应退回默认：%s %s", dir, missing)
	}
	a.dataDirMissing = target
	set.Frame()
	if !set.HasText("自定义数据目录不可用") || !set.HasText("改用默认目录") {
		t.Fatal(set.Texts())
	}
	set.Click("改用默认目录")
	if _, err := os.Stat(filepath.Join(def, dataDirPointer)); !os.IsNotExist(err) {
		t.Fatal("改用默认目录应删除指针")
	}
}

func TestAutoBackupRun(t *testing.T) {
	a, _ := testApp(t, "备份我")
	dir := t.TempDir()
	st := a.store.Settings()
	st.AutoBackupDir, st.AutoBackupKeep = dir, 3
	_ = a.store.SetSettings(st)
	now := time.Now()
	for i := range 5 {
		a.runAutoBackup(true, now.Add(time.Duration(i)*time.Second))
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 3 {
		t.Fatalf("保留 3 份：%v", files)
	}
	if got := a.store.Settings().AutoBackupAt; !got.Equal(now.Add(4 * time.Second)) {
		t.Fatalf("记下上次备份时间：%v", got)
	}
	a.runAutoBackup(false, now.Add(time.Hour)) // 未满 24 小时不备份
	if files, _ = os.ReadDir(dir); len(files) != 3 {
		t.Fatal("未到期不应备份")
	}
	if _, err := a.store.InspectBackup(filepath.Join(dir, files[2].Name())); err != nil {
		t.Fatalf("自动备份应能预检导入：%v", err)
	}
}
