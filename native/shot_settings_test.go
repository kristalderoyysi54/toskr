package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// 区域截图总开关与「截图时隐藏 Toskr」（同 Tauri）：关掉后快捷键页不出截图相关行、截图入口不动作、托盘键变化；
// 隐藏自身默认关，可写回。
func TestScreenshotEnableAndHideSelf(t *testing.T) {
	a, _ := testApp(t)
	if a.store.Settings().ScreenshotOff || a.store.Settings().ShotHideSelf {
		t.Fatal("默认：截图开、不隐藏自身")
	}
	a.openSettingsState()
	a.setPage = 1 // 快捷键
	st := ui.NewTester(a.settingsView, 1040, 900)
	st.Frame()
	if !st.HasText("截图时隐藏 Toskr") || !st.HasText("截图快捷键：⌃⌥A，点击录制") {
		t.Fatalf("开启时应有截图相关行 %v", st.Texts())
	}
	key := a.trayKey()
	a.setScreenshotEnabled(false)
	st.Frame()
	if !a.store.Settings().ScreenshotOff || st.HasText("截图时隐藏 Toskr") || strings.Contains(strings.Join(st.Texts(), "|"), "截图快捷键") {
		t.Fatalf("关闭后应隐藏截图相关行 %v", st.Texts())
	}
	if a.trayKey() == key {
		t.Fatal("托盘应随开关重建")
	}
	a.screenshot()
	if a.shot != nil || a.hudKind == "warn" {
		t.Fatal("关闭时截图入口不动作")
	}
	a.setScreenshotEnabled(true)
	a.setPage = 4 // 更多功能
	st.Frame()
	if !st.HasText("区域截图") || !st.HasText("菜单栏图标或快捷键截图；需要「屏幕录制」权限") {
		t.Fatalf("更多功能应有区域截图开关 %v", st.Texts())
	}
	// 按页名跳转
	a.setJump = "权限"
	st.Frame()
	if a.setPage == 4 || a.setJump != "" {
		t.Fatal("应跳到权限页")
	}
}
