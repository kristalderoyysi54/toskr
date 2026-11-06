package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// 权限横幅（同 Tauri permissionGuard）：未授权 → 辅助功能横幅；「被拦截」只认铁证——
// 重启后没人打字不报；系统输入监控查询连续 2 次为否，或面板收到按键而监听连续 4 次无事件，才报。
func TestPermissionBanner(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 6, 13, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	a.permAX = false
	tt.Frame()
	if !tt.HasText("需要「辅助功能」权限") || !tt.HasText("打开辅助功能设置") {
		t.Fatalf("未授权应提示 %v", tt.Texts())
	}

	// 重启后长时间没人打字：不误报
	a.permAX, a.tapErr, a.tapStarted = true, "", now.Add(-time.Minute)
	for range 10 {
		a.permTick(true)
	}
	tt.Frame()
	if tt.HasText("需要「辅助功能」权限") || tt.HasText("键盘事件被系统拦截") {
		t.Fatal("没人打字不应报被拦截")
	}

	// 面板自己看到键盘活动（按住修饰键 / 输入区打字）而监听仍无事件，满 4 次才报
	tt.HoldModifiers(ui.Shift)
	tt.Frame()
	tt.HoldModifiers(0)
	if !a.permKeySeen {
		t.Fatal("修饰键应记为证据")
	}
	a.permKeySeen = false
	a.draft = "有人在打字"
	tt.Frame()
	if !a.permKeySeen {
		t.Fatal("输入区文字变化应记为证据")
	}
	a.permStuck = 0
	for range 3 {
		a.permTick(true)
	}
	tt.Frame()
	if tt.HasText("键盘事件被系统拦截") {
		t.Fatal("不足 4 次不报")
	}
	a.permTick(true)
	tt.Frame()
	for _, s := range []string{"键盘事件被系统拦截", "重置授权", "打开设置", "重启"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q：%v", s, tt.Texts())
		}
	}
	a.tapReceiving.Store(true)
	a.permTick(true)
	tt.Frame()
	if tt.HasText("键盘事件被系统拦截") || a.permKeySeen {
		t.Fatal("收到事件后横幅消失、证据清零")
	}

	// 系统查询输入监控连续 2 次为否：直接报
	a.tapReceiving.Store(false)
	a.permTick(false)
	if a.permState() == "stuck" {
		t.Fatal("1 次为否不报")
	}
	a.permTick(false)
	if a.permState() != "stuck" {
		t.Fatal("连续 2 次为否应报")
	}

	a.tapErr = "创建失败"
	if a.permState() != "ax" {
		t.Fatal("监听没建起来也按未授权引导")
	}
}
