package main

import (
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
)

func TestDiagnosticsPage(t *testing.T) {
	diag.Init(t.TempDir())
	orig := screenAllowed
	screenAllowed = func() bool { return false }
	t.Cleanup(func() { screenAllowed = orig })
	a, _ := testApp(t)
	diag.Push("双击触发")
	diag.Push("发送: 1 条 → com.apple.Terminal 方案=default")
	diag.Push("面板显示 target=x")
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 2000)
	a.setJump = "诊断"
	set.Frame()
	set.Frame()
	for _, s := range []string{"全部", "捕获", "发送", "打开日志文件"} {
		if !set.HasText(s) {
			t.Fatalf("缺 %q：%v", s, set.Texts())
		}
	}
	has := func(sub string) bool {
		for _, s := range set.Texts() {
			if len(s) >= len(sub) && contains(s, sub) {
				return true
			}
		}
		return false
	}
	if !has("双击触发") || !has("面板显示") {
		t.Fatal(set.Texts())
	}
	a.diagFilter = "delivery"
	set.Frame()
	if !has("发送: 1 条") || has("双击触发") || has("面板显示") {
		t.Fatalf("发送筛选：%v", set.Texts())
	}
	a.setJump = "权限"
	set.Frame()
	set.Frame()
	if !has("屏幕录制") || !has("输入监控") {
		t.Fatal(set.Texts())
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestDiagInitReadsTail(t *testing.T) {
	dir := t.TempDir()
	diag.Init(dir)
	diag.Push("第一条")
	diag.Push("第二条")
	diag.Init(dir) // 重启
	r := diag.Recent(5)
	if len(r) != 2 || r[0].Msg != "第二条" {
		t.Fatalf("%+v", r)
	}
}
