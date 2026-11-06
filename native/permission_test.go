package main

import (
	"testing"
	"time"
)

// 权限横幅：未授权 → 辅助功能横幅；建了监听 12 秒仍无按键 → 键盘被拦截横幅；收到按键或观察期内 → 不显示。
func TestPermissionBanner(t *testing.T) {
	a, tt := testApp(t)
	now := time.Date(2026, 11, 6, 13, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	a.permAX = false
	tt.Frame()
	if !tt.HasText("需要「辅助功能」权限") || !tt.HasText("打开辅助功能设置") {
		t.Fatalf("未授权应提示 %v", tt.Texts())
	}
	a.permAX, a.tapErr, a.tapStarted = true, "", now.Add(-5*time.Second)
	tt.Frame()
	if tt.HasText("需要「辅助功能」权限") || tt.HasText("键盘事件被系统拦截") {
		t.Fatal("观察期内不打扰")
	}
	a.tapStarted = now.Add(-13 * time.Second)
	tt.Frame()
	for _, s := range []string{"键盘事件被系统拦截", "一键重置授权", "打开输入监控设置", "重启 Toskr"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q：%v", s, tt.Texts())
		}
	}
	a.tapReceiving.Store(true)
	tt.Frame()
	if tt.HasText("键盘事件被系统拦截") {
		t.Fatal("收到按键后横幅消失")
	}
	a.tapErr = "创建失败"
	if a.permState(now) != "ax" {
		t.Fatal("监听没建起来也按未授权引导")
	}
}
