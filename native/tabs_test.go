package main

import (
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"
)

// 一级页签（同 Tauri pageOrder）：拖动页签重排并写回设置；⌘←→ / ⌃Tab 按显示顺序走；关闭剪贴历史不出剪贴页；双击页签回到列表开头。
func TestTabsOrderDragAndDoubleClick(t *testing.T) {
	a, tt := testApp(t, "甲", "乙", "丙")
	st := a.store.Settings()
	st.ClipboardWatch = true
	_ = a.store.SetSettings(st)
	tt.Frame()
	x := func(label string) float32 { r, _ := tt.Find(label); return r.X }
	if !(x("剪贴") < x("笔记") && x("笔记") < x("任务")) {
		t.Fatal("默认顺序 剪贴 · 笔记 · 任务")
	}
	drag(t, tt, "任务", "剪贴", 0)
	if got := a.store.Settings().PageOrder; !slices.Equal(got[:3], []string{"tasks", "clipboard", "notes"}) {
		t.Fatalf("拖到剪贴上应移到最前 %v", got)
	}
	tt.Frame()
	if !(x("任务") < x("剪贴") && x("剪贴") < x("笔记")) {
		t.Fatal("页签按新顺序显示")
	}
	a.switchPage(pageNotes)
	tt.Key(ui.Cmd, ui.KeyRight)
	tt.Frame()
	if a.page != pageNotes {
		t.Fatal("已在最后一个页签，⌘→ 不动")
	}
	tt.Key(ui.Cmd, ui.KeyLeft)
	tt.Frame()
	if a.page != pageClip {
		t.Fatalf("⌘← 按显示顺序到剪贴，实为 %d", a.page)
	}
	tt.Key(ui.Ctrl, ui.KeyTab)
	tt.Key(ui.Ctrl, ui.KeyTab)
	tt.Frame()
	if a.page != pageTasks {
		t.Fatalf("⌃Tab 循环：剪贴 → 笔记 → 任务，实为 %d", a.page)
	}
	a.switchPage(pageNotes)
	st = a.store.Settings()
	st.ClipboardWatch = false
	_ = a.store.SetSettings(st)
	tt.Frame()
	if tt.HasText("剪贴") || slices.Contains(a.visiblePages(), pageClip) {
		t.Fatal("关闭剪贴历史不出剪贴页")
	}
	a.selected = 2
	r, _ := tt.Find("笔记")
	tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	if a.selected != 0 {
		t.Fatalf("双击页签焦点回第一张，实为 %d", a.selected)
	}
}
