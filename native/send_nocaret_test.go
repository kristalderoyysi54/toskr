package main

import (
	"testing"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
)

// 发送结论为「没有光标」：警告气泡点名目标应用，记录标为未确认，不出「已发送」。
func TestFinishDeliverNoCaretWarns(t *testing.T) {
	a, _ := testApp(t, "内容")
	n := a.store.Notes()[0]
	a.finishDeliver(macos.FrontApp{PID: 42, Name: "Chrome", BundleID: "com.google.Chrome"}, []string{n.ID}, []string{n.Text}, nil, 0, sendRedaction{}, "默认", core.CheckNoCaret, nil)
	if a.hudKind != "warn" || a.hudText != "Chrome 里没有光标，内容可能没粘贴进去" {
		t.Fatalf("应警告没有光标 %s %q", a.hudKind, a.hudText)
	}
	if ds := a.store.Deliveries(); len(ds) == 0 || !ds[0].Unconfirmed {
		t.Fatalf("记录应标为未确认 %+v", ds)
	}
}
