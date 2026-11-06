package main

import (
	"testing"

	"github.com/toskr/native/internal/store"
)

// 同 Tauri 编辑态坞：原文/渲染 · 处理 · 粘贴图片 · 保存 ⌘⏎；「处理」改草稿（选区优先），无变化出 info。
func TestDetailEditDock(t *testing.T) {
	a, _ := testApp(t, "hello world")
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	a.enterDetailEdit(n)
	dt.Frame()
	for _, s := range []string{"渲染", "处理", "保存 ⌘⏎"} {
		if !dt.HasText(s) {
			t.Fatalf("编辑态坞缺「%s」%v", s, dt.Texts())
		}
	}
	dt.Click("渲染")
	dt.Frame()
	if !a.detail.editPreview || !dt.HasText("原文") {
		t.Fatalf("点「渲染」应预览草稿 %v", dt.Texts())
	}
	dt.Click("原文")
	dt.Frame()
	if a.detail.editPreview {
		t.Fatal("再点「原文」应回到编辑器")
	}

	upper := textOps[2].apply
	a.applyEditTextOp(n, upper)
	if a.detailText != "HELLO WORLD" {
		t.Fatalf("整篇处理 %q", a.detailText)
	}
	if got, _ := a.store.Note(n.ID); got.Text != "hello world" {
		t.Fatalf("处理只改草稿，保存前不落库 %q", got.Text)
	}
	a.applyEditTextOp(n, upper)
	if a.hudText != "内容无变化" {
		t.Fatalf("无变化应提示 %q", a.hudText)
	}

	a.detailText, a.detail.editRange = "hello world", [2]int{0, 5}
	a.applyEditTextOp(n, upper)
	if a.detailText != "HELLO world" || a.detail.editSel != [2]int{0, 5} {
		t.Fatalf("选区处理 %q sel=%v", a.detailText, a.detail.editSel)
	}

	a.detail.blocks = []store.ContentBlock{{Type: "text", Text: "a"}, {Type: "image", File: "x.png"}, {Type: "text", Text: "b"}}
	a.applyEditTextOp(n, upper)
	if a.detail.blocks[0].Text != "A" || a.detail.blocks[2].Text != "B" || a.detail.blocks[1].File != "x.png" {
		t.Fatalf("图文卡逐文字块处理 %+v", a.detail.blocks)
	}
}
