package main

import (
	"testing"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/macos"
)

// 同 Tauri start_companion_tracker：前台切到列表里的另一个应用换目标；列表外 / 自己 / 同一个不换。
func TestCompanionSwitch(t *testing.T) {
	list := []string{"com.term", "com.code"}
	cases := []struct {
		front macos.FrontApp
		want  int32
	}{
		{macos.FrontApp{PID: 20, BundleID: "com.code"}, 20},
		{macos.FrontApp{PID: 30, BundleID: "com.chrome"}, 10},
		{macos.FrontApp{PID: 99, BundleID: "com.code"}, 10}, // 自己
		{macos.FrontApp{}, 10},
	}
	for _, c := range cases {
		if got := companionSwitch(10, c.front, 99, list); got != c.want {
			t.Fatalf("%+v → %d，应为 %d", c.front, got, c.want)
		}
	}
}

// 目标窗口移动 / 缩放后重新计算的停靠位跟着走（右侧、左侧、贴满屏时收进内侧）。
func TestCompanionFollowsFrame(t *testing.T) {
	wa := mygo.Rectangle{X: 0, Y: 25, Width: 1440, Height: 875}
	a := dockBeside(macos.Rect{X: 100, Y: 60, W: 800, H: 700}, wa, 380, false, 6)
	b := dockBeside(macos.Rect{X: 200, Y: 120, W: 800, H: 600}, wa, 380, false, 6)
	if b.X-a.X != 100 || b.Y != 120 || b.Height != 600 {
		t.Fatalf("窗口移动后面板应跟随 %+v → %+v", a, b)
	}
}
