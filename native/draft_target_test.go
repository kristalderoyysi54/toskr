package main

import (
	"testing"
	"time"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 预检出现后改了发送目标：投递中止、不发、提示「目标已变化」；目标没变则照常发出。
func TestDraftTargetChangedBlocksSend(t *testing.T) {
	a, tt := testApp(t, "联系 demo.user@example.com")
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	a.send([]store.Note{a.store.Notes()[0]})
	if len(a.pending) == 0 {
		t.Fatal("含邮箱应先进预检")
	}
	a.target = macos.FrontApp{PID: 43, Name: "Terminal"}
	a.confirmPending(true)
	time.Sleep(150 * time.Millisecond)
	tt.Frame()
	if len(sys.sent()) != 0 || a.hudKind != "warn" || a.hudText != "目标已变化：这次内容是为 Cursor 准备的，未发送，请重新发送" {
		t.Fatalf("应中止 sent=%v hud=%s %q", sys.sent(), a.hudKind, a.hudText)
	}

	a.send([]store.Note{a.store.Notes()[0]})
	a.confirmPending(true)
	waitFor(t, func() bool { tt.Frame(); return len(sys.sent()) > 0 })
}
