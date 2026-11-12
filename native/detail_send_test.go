package main

import (
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
)

// 详情窗发送下拉：发送方式（去 Markdown）与「发送到…」手动指定目标。
func TestDetailSendToAppAndMode(t *testing.T) {
	a, _ := testApp(t, "**加粗** 正文")
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	orig := runningTargets
	t.Cleanup(func() { runningTargets = orig })
	runningTargets = func() []macos.AppInfo {
		return []macos.AppInfo{{PID: 77, BundleID: "com.apple.Notes", Name: "备忘录", StartedMs: 123}}
	}
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, pinned: true}
	tt := ui.NewTester(a.detailView, 560, 540)
	tt.Frame()
	if err := tt.Click("更多发送选项"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("备忘录"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	submitPending(a)
	waitFor(t, func() bool { return len(sys.sent()) > 0 })
	if a.target.PID != 77 || a.target.Name != "备忘录" || a.targetStarted != 123 {
		t.Fatalf("应改为手动指定的目标 %+v", a.target)
	}
	tt.Frame()
	_ = tt.Click("更多发送选项")
	if err := tt.ChooseMenuItem("去 Markdown 后发送"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	submitPending(a) // 去 Markdown 同 Tauri smart：先进预检
	waitFor(t, func() bool { return len(sys.sent()) > 1 })
	if got := sys.sent()[1]; got != "加粗 正文" {
		t.Fatalf("去 Markdown %q", got)
	}
}

// 发送下拉向窗外展开：选「同时发到…」时光标已离窗，选择仍要送达（离窗那一帧不能先把操作坞收掉）。
func TestDetailFanoutMenuChosenAfterPointerLeft(t *testing.T) {
	a, _ := testApp(t, "一段问题")
	a.sys = &recSys{}
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	orig := runningTargets
	t.Cleanup(func() { runningTargets = orig })
	runningTargets = fanApps
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, pinned: true}
	tt := ui.NewTester(a.detailView, 560, 540)
	tt.Move(300, 300)
	tt.Frame()
	if err := tt.Click("更多发送选项"); err != nil {
		t.Fatal(err)
	}
	tt.Move(300, 900) // 菜单在窗外：光标离窗
	if err := tt.ChooseMenuItem("同时发到…"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	if !a.detail.fanOpen || !tt.HasText("至少选 2 个应用") {
		t.Fatalf("应打开选目标浮层 fanOpen=%v %v", a.detail.fanOpen, tt.Texts())
	}
	tt.Move(300, 300) // 光标重新进窗：解除保持
	tt.Frame()
	tt.Move(300, 900)
	tt.Frame()
	if a.detail.chromeHold || tt.HasText("复制") {
		t.Fatalf("解除后离窗应照常收起 hold=%v", a.detail.chromeHold)
	}
}
