package main

import (
	"strings"
	"testing"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 预检替换后发送：映射按这次发送记在内存；关联到这次发送的回复卡可恢复占位符（可撤销），凭据类不恢复。
func TestRestoreReplyPlaceholders(t *testing.T) {
	mail := "alice" + "@corp.io"
	key := strings.Join([]string{"sk-", "proj-", strings.Repeat("Ab3", 10)}, "")
	a, tt := testApp(t, "联系 "+mail+"，密钥 "+key)
	a.sys = &recSys{}
	a.target = macos.FrontApp{PID: 42, Name: "Cursor", BundleID: "com.x"}
	src := a.store.Notes()[0]
	a.send([]store.Note{src})
	tt.Frame()
	a.pfReplace(func(pfItem) bool { return true })
	ph := a.pf.ph
	if ph[mail] != "[EMAIL_01]" {
		t.Fatalf("%v", ph)
	}
	a.cancelPending()
	// 投递本体走 Window.Update（测试里没有主循环），这里直接跑收尾
	a.finishDeliver(a.target, []string{src.ID}, []string{"x"}, nil, 2, sendRedaction{raw: ph}, "稳妥发送", core.CheckVerified, nil)
	d := a.store.Deliveries()[0]
	if m := a.redactionMap(d.ID); m == nil || m[mail] != "[EMAIL_01]" || len(m) != 1 {
		t.Fatalf("只记可逆映射 %v", m)
	}
	reply, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "已联系 [EMAIL_01]，密钥 [API_KEY_01] 已失效"})
	a.store.LinkResult(d.ID, reply.ID)
	reply, _ = a.store.Note(reply.ID)
	if reply.Provenance == nil {
		t.Fatal("应已关联")
	}
	a.restoreReplyPlaceholders(reply)
	got, _ := a.store.Note(reply.ID)
	if got.Text != "已联系 "+mail+"，密钥 [API_KEY_01] 已失效" {
		t.Fatalf("%q", got.Text)
	}
}

// 取消「粘贴后按回车？」不得把遮挡图副本 / 占位符映射带进下一次发送。
func TestCancelEnterAskClearsSendOverrides(t *testing.T) {
	a, _ := testApp(t, "x")
	a.enterAsk = []store.Note{{Text: "x"}}
	a.sendPNG, a.sendPH = []byte{1}, sendRedaction{raw: map[string]string{"a": "[EMAIL_01]"}}
	a.cancelEnterAsk()
	if a.sendPNG != nil || a.sendPH.raw != nil || a.enterAsk != nil {
		t.Fatal("取消后应清空")
	}
}
