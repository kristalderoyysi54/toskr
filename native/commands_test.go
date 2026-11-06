package main

import (
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func cmdLabels(items []cmdItem) []string {
	var out []string
	for _, it := range items {
		out = append(out, it.label)
	}
	return out
}

// ⌘K 命令面板：无查询词只给动作；输入后按文字过滤动作并附卡片 / 任务命中；↓↵ 执行；再按 ⌘K / Esc 关闭。
func TestCommandPalette(t *testing.T) {
	a, tt := testApp(t, "周报草稿", "另一条")
	a.store.AddTask(store.Task{Text: "周报提交"})
	_, _, _ = a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴里的周报链接"})
	a.reload()
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	if !a.cmdOpen || !tt.HasText("切到剪贴页") || !tt.HasText("打开设置") {
		t.Fatalf("⌘K 应打开并列出动作 %v", tt.Texts())
	}
	if got := cmdLabels(a.commandItems("")); slices.ContainsFunc(got, func(s string) bool { return s == "周报草稿" }) {
		t.Fatal("无查询词只给动作")
	}
	tt.Type("周报")
	tt.Frame()
	got := cmdLabels(a.commandItems(a.cmdQuery))
	if !slices.Equal(got, []string{"剪贴里的周报链接", "周报草稿", "周报提交"}) {
		t.Fatalf("查询应命中卡片与任务 %v", got)
	}
	tt.Key(0, ui.KeyDown) // 第二条：笔记卡
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if a.cmdOpen || a.page != pageNotes {
		t.Fatalf("↵ 执行并关闭，应切到内容页 open=%v page=%d", a.cmdOpen, a.page)
	}
	if cur, ok := a.current(); !ok || cur.Text != "周报草稿" || !a.focusList {
		t.Fatalf("焦点应落在命中的卡 %+v", cur)
	}
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	tt.Type("设置")
	tt.Frame()
	if got := cmdLabels(a.commandItems(a.cmdQuery)); !slices.Equal(got, []string{"打开设置"}) {
		t.Fatalf("动作按文字过滤 %v", got)
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.cmdOpen || !tt.HasText("周报草稿") {
		t.Fatal("Esc 只关命令面板，不收面板")
	}
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	if a.cmdOpen {
		t.Fatal("再按 ⌘K 关闭")
	}
}
