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
