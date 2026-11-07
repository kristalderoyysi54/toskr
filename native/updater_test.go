package main

import (
	"context"
	"testing"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func stubUpdater(t *testing.T, up *mygo.Update) (checks, installs *int) {
	t.Helper()
	oE, oC, oI, oR, oL := updaterEnabled, updaterCheck, updateInstall, relaunch, openLink
	t.Cleanup(func() { updaterEnabled, updaterCheck, updateInstall, relaunch, openLink = oE, oC, oI, oR, oL })
	var c, i int
	updaterEnabled = func() bool { return true }
	updaterCheck = func(context.Context) (*mygo.Update, error) { c++; return up, nil }
	updateInstall = func(_ context.Context, _ *mygo.Update, p func(int64, int64)) error {
		i++
		if p != nil {
			p(50, 100)
		}
		return nil
	}
	relaunch = func() {}
	return &c, &i
}

// 同 Tauri silentUpdateFlow：发现新版弹可点气泡、亮「更新」；同一版本只处理一次；关掉自动检查不查。
func TestSilentUpdateNotifiesOnce(t *testing.T) {
	a, tt := testApp(t)
	checks, installs := stubUpdater(t, &mygo.Update{Version: "9.9.9"})
	a.silentUpdate()
	if a.upd.avail == nil || a.hudText != "发现新版本 v9.9.9 · 点击查看" || !a.hudActionable() || *installs != 0 {
		t.Fatalf("hud=%q avail=%v", a.hudText, a.upd.avail)
	}
	tt.Frame()
	if !tt.HasText("更新") {
		t.Fatal("标题栏应亮「更新」")
	}
	a.hudOpen() // 点气泡 → 面板内更新对话框
	tt.Frame()
	if !a.upd.dialogOpen || !tt.HasText("软件更新") || !tt.HasText("v9.9.9") {
		t.Fatalf("应打开更新对话框 %v", tt.Texts())
	}
	if err := tt.Click("立即下载"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { tt.Frame(); return *installs == 1 })
	a.upd.dialogOpen = false
	a.hudText = ""
	a.silentUpdate()
	if a.hudText != "" {
		t.Fatal("同一版本不应重复提醒")
	}
	st := a.store.Settings()
	off := false
	st.AutoCheckUpdate = &off
	_ = a.store.SetSettings(st)
	n := *checks
	a.silentUpdate()
	if *checks != n {
		t.Fatal("关闭自动检查后不应检查")
	}
}

func TestSilentUpdateAutoInstall(t *testing.T) {
	a, _ := testApp(t)
	_, installs := stubUpdater(t, &mygo.Update{Version: "9.9.9"})
	st := a.store.Settings()
	st.AutoInstallUpdate = true
	_ = a.store.SetSettings(st)
	a.silentUpdate()
	if *installs != 1 || a.hudText != "已更新到 v9.9.9 · 重启应用后生效" || a.upd.avail != nil {
		t.Fatalf("installs=%d hud=%q", *installs, a.hudText)
	}
}

// 设置「关于」：手动检查 → 下载并安装 → 重启；自动检查 / 自动安装开关；链接。
func TestAboutRowsManualInstallAndLinks(t *testing.T) {
	a, _ := testApp(t)
	_, installs := stubUpdater(t, &mygo.Update{Version: "9.9.9", Notes: "修了点东西"})
	var opened string
	openLink = func(u string) { opened = u }
	restarted := false
	relaunch = func() { restarted = true }
	a.openSettingsAt(99, 0) // 夹紧到最后一页「帮助与更新」
	v := ui.NewTester(a.settingsView, 1040, 2400)
	v.Frame()
	for _, s := range []string{"检查更新", "自动检查更新", "自动安装更新", "更新日志", "项目主页", "报告 Bug"} {
		if !v.HasText(s) {
			t.Fatalf("缺 %q %v", s, v.Texts())
		}
	}
	if err := v.Click("检查更新"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { v.Frame(); return a.upd.avail != nil })
	v.Frame()
	if !v.HasText("修了点东西") {
		t.Fatal("应显示本次更新内容")
	}
	if err := v.Click("下载并安装"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return restarted })
	if *installs != 1 {
		t.Fatal("应安装一次")
	}
	if err := v.Click("提 Issue"); err != nil {
		t.Fatal(err)
	}
	if opened != repoURL+"/issues/new" {
		t.Fatalf("%q", opened)
	}
}
