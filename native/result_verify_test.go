package main

import (
	"context"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/store"
)

// 回复检查：从回复关联打开，本地规则检查、AI 深度检查（发出前替换敏感项）、存为笔记、问题进预检。
func TestVerifySheetFlow(t *testing.T) {
	a, tt := testApp(t, "请整理联系人 bob"+"@corp.io 的资料，输出 JSON")
	src := a.store.Notes()[0]
	a.finishDeliver(a.target, []string{src.ID}, []string{src.Text}, nil, 0, sendRedaction{counts: map[string]int{}}, "稳妥发送", core.CheckVerified, nil)
	d := a.store.Deliveries()[0]
	reply, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: `{"name":"bob"}`})
	a.store.LinkResult(d.ID, reply.ID)
	reply, _ = a.store.Note(reply.ID)
	a.openVerify(reply)
	tt.Frame()
	if !tt.HasText("回复检查") || !tt.HasText("你希望回复满足什么？") {
		t.Fatalf("%v", tt.Texts())
	}
	a.verify.fields = "name\nemail"
	if err := tt.Click("检查回复"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	r := a.verify.report
	if r == nil || r.Status != core.VerifyBlock || !tt.HasText("缺少 JSON 必填字段：email") {
		t.Fatalf("%+v %v", r, tt.Texts())
	}
	var sent string
	orig := aiRewrite
	t.Cleanup(func() { aiRewrite = orig })
	aiRewrite = func(_ context.Context, _ ai.Config, _, user string) (string, error) { sent = user; return "遗漏：email 字段", nil }
	a.runVerifyAI()
	tt.Frame()
	if strings.Contains(sent, "bob"+"@corp.io") || !strings.Contains(sent, "[EMAIL_01]") || a.verify.aiText != "遗漏：email 字段" {
		t.Fatalf("发给 AI 前应替换邮箱：%q / %q", sent, a.verify.aiText)
	}
	tt.Scroll(200, 300, 0, 2000) // 报告较长：滚到浮层底部
	tt.Frame()
	if err := tt.Click("保存为笔记"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	var report store.Note
	for _, n := range a.store.Notes() {
		if n.Title == "结果核验报告" {
			report = n
		}
	}
	if report.ID == "" || report.Provenance == nil || report.Provenance.DeliveryID != d.ID || !strings.Contains(report.Text, "AI 深度检查") {
		t.Fatalf("%+v", report)
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.verify.noteID != "" {
		t.Fatal("Esc 应先关回复检查")
	}
}
