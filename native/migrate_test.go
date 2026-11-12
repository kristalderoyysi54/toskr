package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func init() { // 视图测试默认「没有旧版」：不读本机真实 Tauri 目录 / 进程 / 启动项
	legacyDataDir = func() string { return "" }
	legacyPIDs = func() []int32 { return nil }
	legacyTerminate = func(int32) bool { return true }
	legacyAgentPath = func() string { return "" }
}

func fakeLegacy(t *testing.T) (dir, agent string) {
	t.Helper()
	dir, agent = t.TempDir(), filepath.Join(t.TempDir(), "Toskr.plist")
	_ = os.WriteFile(filepath.Join(dir, "toskr-data.json"), []byte("{}"), 0o600)
	_ = os.WriteFile(agent, []byte("<string>/Applications/Toskr.app/Contents/MacOS/toskr</string>"), 0o600)
	oldD, oldA := legacyDataDir, legacyAgentPath
	legacyDataDir, legacyAgentPath = func() string { return dir }, func() string { return agent }
	t.Cleanup(func() { legacyDataDir, legacyAgentPath = oldD, oldA })
	return
}

// 检测到旧版数据：唤出面板先弹向导；「稍后」本次进程不再弹；「不再提示」记 dismissed。
func TestMigrateWizardOpenLaterNever(t *testing.T) {
	fakeLegacy(t)
	a, tt := testApp(t, "原有")
	a.maybeOpenMigrate()
	tt.Frame()
	if !tt.HasText("把旧版的数据搬到新版") || !tt.HasText("导入旧版数据") {
		t.Fatalf("应弹迁移向导 %v", tt.Texts())
	}
	mustClick(t, tt, "稍后")
	a.maybeOpenMigrate()
	tt.Frame()
	if a.migrate != nil || tt.HasText("把旧版的数据搬到新版") {
		t.Fatal("选「稍后」后本次不应再弹")
	}
	a.migrateLater = false
	a.maybeOpenMigrate()
	tt.Frame()
	mustClick(t, tt, "不再提示")
	if a.store.Settings().TauriMigration != "dismissed" {
		t.Fatal("不再提示应记 dismissed")
	}
	a.migrateLater = false
	if a.maybeOpenMigrate(); a.migrate != nil {
		t.Fatal("dismissed 后不应再弹")
	}
}

// 没有旧版数据不弹；导入失败留在第一步、显示原因、按钮变「重试导入」，不记完成。
func TestMigrateWizardImportFails(t *testing.T) {
	a, tt := testApp(t)
	if a.maybeOpenMigrate(); a.migrate != nil {
		t.Fatal("无旧版数据不应弹")
	}
	fakeLegacy(t)
	old := tauriKey
	tauriKey = func() ([]byte, error) { return nil, errors.New("没有取得钥匙串授权") }
	t.Cleanup(func() { tauriKey = old })
	a.maybeOpenMigrate()
	tt.Frame()
	mustClick(t, tt, "导入旧版数据")
	for i := 0; i < 50 && a.tauriImporting; i++ {
		tt.Frame()
	}
	tt.Frame()
	if !tt.HasText("导入失败：没有取得钥匙串授权") || !tt.HasText("重试导入") || a.store.Settings().TauriMigration != "" {
		t.Fatalf("失败态不对 %v mark=%q", tt.Texts(), a.store.Settings().TauriMigration)
	}
}

// 交接：旧版在运行 → 「退出旧版」逐个请求退出；开机启动项 → 移进数据目录（可恢复）；「开始使用新版」收起。
func TestMigrateWizardHandoff(t *testing.T) {
	_, agent := fakeLegacy(t)
	running := []int32{4242}
	var quit []int32
	oldP, oldT := legacyPIDs, legacyTerminate
	legacyPIDs = func() []int32 { return running }
	legacyTerminate = func(p int32) bool { quit = append(quit, p); running = nil; return true }
	t.Cleanup(func() { legacyPIDs, legacyTerminate = oldP, oldT })
	a, tt := testApp(t)
	a.migrate = &migrateState{step: 2, result: "已从 Tauri 版导入：笔记 3"}
	tt.Frame()
	for _, s := range []string{"数据已搬到新版", "已从 Tauri 版导入：笔记 3", "旧版仍在运行", "旧版开着开机启动", "停用旧版"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q %v", s, tt.Texts())
		}
	}
	mustClick(t, tt, "退出旧版")
	tt.Frame()
	if len(quit) != 1 || quit[0] != 4242 || !tt.HasText("已退出") {
		t.Fatalf("退出旧版 quit=%v %v", quit, tt.Texts())
	}
	mustClick(t, tt, "关闭")
	tt.Frame()
	if _, err := os.Stat(agent); !os.IsNotExist(err) {
		t.Fatal("启动项应移走")
	}
	if _, err := os.Stat(filepath.Join(a.store.Dir(), "legacy-autostart-Toskr.plist")); err != nil || !tt.HasText("已关闭") {
		t.Fatalf("启动项应移进数据目录 %v", err)
	}
	mustClick(t, tt, "开始使用新版")
	if a.migrate != nil {
		t.Fatal("应收起向导")
	}
}
