package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

func TestPreflightPerItemAndPolicies(t *testing.T) {
	mail := "alice" + "@corp.io"
	key := strings.Join([]string{"sk-", "proj-", strings.Repeat("Ab3", 10)}, "")
	a, tt := testApp(t, "联系 "+mail+" 或 "+mail+"，密钥 "+key)
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	note := a.store.Notes()[0]
	a.send([]store.Note{note})
	tt.Frame()
	if len(a.pf.items) != 3 {
		t.Fatalf("应命中 2 个邮箱 + 1 个密钥：%+v", a.pf.items)
	}
	// 逐项：替换第一个邮箱 → 同一原值的另一处也是同一占位符，编号稳定
	_ = tt.Click("逐项处理")
	tt.Frame()
	if !tt.HasText(core.MaskedPreview(mail)) {
		t.Fatalf("列表应显示遮罩预览 %v", tt.Texts())
	}
	a.pfReplace(func(x pfItem) bool { return x.f.Category == "email" })
	if got := a.pending[0].Text; !strings.HasPrefix(got, "联系 [EMAIL_01] 或 [EMAIL_01]，") {
		t.Fatalf("同值同占位符：%q", got)
	}
	if len(a.pf.items) != 1 || a.pf.replaced != 2 {
		t.Fatalf("替换后只剩密钥：%+v", a.pf.items)
	}

	// requireRedaction（默认）：未处理不能发；保留后可发且不回车
	if e := a.pfEvaluate("requireRedaction"); e.canSend || e.unresolved != 1 {
		t.Fatalf("%+v", e)
	}
	// confirmRaw：高风险未处理不能发
	if e := a.pfEvaluate("confirmRaw"); e.canSend || e.needRaw != "" {
		t.Fatalf("confirmRaw 高风险须处理 %+v", e)
	}
	// allowRaw：高风险原文需再次确认
	if e := a.pfEvaluate("allowRaw"); e.canSend || e.needRaw != "block" {
		t.Fatalf("allowRaw %+v", e)
	}
	a.pf.raw = "block"
	if e := a.pfEvaluate("allowRaw"); !e.canSend || !e.noEnter {
		t.Fatalf("确认后可发、不回车 %+v", e)
	}
	a.pf.raw = ""
	a.pfKeep(func(x pfItem) bool { return true })
	e := a.pfEvaluate("requireRedaction")
	if !e.canSend || !e.noEnter {
		t.Fatalf("保留高风险后可发、强制不回车 %+v", e)
	}
	// 重新检测：保留项仍保留
	a.pfScan()
	if !a.pf.kept[a.pf.items[0].id] {
		t.Fatal("重新检测不应丢掉保留决定")
	}
	tt.Frame()
	_ = tt.Click("发送")
	waitFor(t, func() bool { return len(sys.sent()) > 0 })
	if got := sys.sent()[0]; !strings.Contains(got, "[EMAIL_01]") || !strings.Contains(got, key) || strings.Contains(got, mail) {
		t.Fatalf("发出的应是替换邮箱、保留密钥的副本 %q", got)
	}
	if n, _ := a.store.Note(note.ID); !strings.Contains(n.Text, mail) {
		t.Fatal("原卡不应被改写")
	}
	tt.Key(0, ui.KeyEscape)
}

func TestPreflightConfirmRawWarnOnly(t *testing.T) {
	a, _ := testApp(t)
	a.pending = []store.Note{{Text: "发给 bob" + "@corp.io"}}
	a.pfScan()
	if e := a.pfEvaluate("confirmRaw"); e.canSend || e.needRaw != "warn" {
		t.Fatalf("提示级需整体确认 %+v", e)
	}
	a.pf.raw = "warn"
	if e := a.pfEvaluate("confirmRaw"); !e.canSend || e.noEnter {
		t.Fatalf("确认后可发，提示级不强制关回车 %+v", e)
	}
}

// 列表里点「替换为占位符」会改写副本：同一帧后续行不能再拿旧区间切片（曾因此越界崩溃）。
func TestPreflightReplaceClickInList(t *testing.T) {
	a, tt := testApp(t, "预检演示 联系 demo.user"+"@example.com 手机：13800138000")
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	a.sys = &recSys{}
	a.send([]store.Note{a.store.Notes()[0]})
	tt.Frame()
	_ = tt.Click("逐项处理")
	tt.Frame()
	if err := tt.Click("替换为占位符"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	tt.Frame()
	if !strings.Contains(a.pending[0].Text, "[EMAIL_01]") || len(a.pf.items) != 1 {
		t.Fatalf("%q %+v", a.pending[0].Text, a.pf.items)
	}
}
