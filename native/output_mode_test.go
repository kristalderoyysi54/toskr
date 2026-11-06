package main

import (
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 选择条「输出格式」：仅本次换格式（去 Markdown / 代码块），发完回到方案默认；卡片不改。
func TestSelectionOutputModeOnce(t *testing.T) {
	a, tt := testApp(t, "# 标题\n**加粗** 与 [链接](https://x.dev)")
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "ChatGPT", BundleID: "com.openai.chat"}
	n := a.store.Notes()[0]
	a.chosen.Add(n.ID)
	tt.Frame()
	a.sendWithMode([]store.Note{n}, "strip-markdown")
	submitPending(a)
	waitFor(t, func() bool { return len(sys.sent()) > 0 })
	if got := sys.sent()[0]; got != "标题\n加粗 与 链接（https://x.dev）" {
		t.Fatalf("去 Markdown %q", got)
	}
	if a.sendMode != "" {
		t.Fatal("发完应清掉本次覆盖")
	}
	a.send([]store.Note{n})
	waitFor(t, func() bool { return len(sys.sent()) > 1 })
	if got := sys.sent()[1]; got != n.Text {
		t.Fatalf("下一次回到方案默认（原文）%q", got)
	}
	// 挂起（检查后发送）时取消：覆盖一并作废
	a.forceCheck = true
	a.sendWithMode([]store.Note{n}, "code")
	a.forceCheck = false
	tt.Frame()
	if a.sendMode != "code" || len(a.pending) != 1 {
		t.Fatalf("挂起时保留覆盖 mode=%q", a.sendMode)
	}
	_ = tt.Click("取消")
	tt.Frame()
	if a.sendMode != "" {
		t.Fatal("取消应清掉覆盖")
	}
	tt.Key(0, ui.KeyEscape)
}
