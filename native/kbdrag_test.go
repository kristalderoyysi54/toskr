package main

import (
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 键盘拖拽排序（QA#9）：Space 拾起、↑↓ 移动并跨组、Esc 回原位、Space 放下。
func TestKeyboardDragReorder(t *testing.T) {
	a, tt := testApp(t, "甲卡", "乙卡", "丙卡")
	sec := a.store.AddSection("资料")
	_, _, _ = a.store.Add(store.Note{Section: sec, Text: "丁卡"})
	a.reload()
	tt.Frame()
	order := func(s string) (out []string) {
		for _, n := range a.store.Section(s) {
			out = append(out, n.Text)
		}
		return
	}
	id := func(text string) string {
		for _, n := range a.store.Notes() {
			if n.Text == text {
				return n.ID
			}
		}
		return ""
	}
	if _, ok := tt.Find("拖拽调整位置和分组（Space 拾起，方向键移动）"); !ok {
		t.Fatal("卡片应有键盘拖拽把手")
	}
	focusGrip := func(text string) {
		t.Helper()
		for range 60 {
			if a.gripFocus == id(text) {
				return
			}
			tt.Key(0, ui.KeyTab)
			tt.Frame()
		}
		t.Fatalf("Tab 聚焦不到 %s 的把手（当前 %q）", text, a.gripFocus)
	}
	focusGrip("丙卡")
	tt.Key(0, ui.KeySpace)
	tt.Frame()
	if a.kbd.id != id("丙卡") {
		t.Fatal("Space 应拾起")
	}
	tt.Key(0, ui.KeyUp)
	tt.Frame()
	if got := order(store.SectionInbox); !slices.Equal(got, []string{"甲卡", "丙卡", "乙卡"}) {
		t.Fatalf("↑ 上移一位 %v", got)
	}
	for range 2 { // 乙后面 → 组尾再 ↓ 进下一组开头
		tt.Key(0, ui.KeyDown)
		tt.Frame()
	}
	if got := order(sec); !slices.Equal(got, []string{"丙卡", "丁卡"}) {
		t.Fatalf("到组尾再 ↓ 跨进下一组开头 %v / 收件箱 %v", got, order(store.SectionInbox))
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if got := order(store.SectionInbox); !slices.Equal(got, []string{"甲卡", "乙卡", "丙卡"}) || a.kbd.id != "" {
		t.Fatalf("Esc 回原位 %v", got)
	}
	focusGrip("甲卡")
	tt.Key(0, ui.KeySpace)
	tt.Frame()
	tt.Key(0, ui.KeyDown)
	tt.Frame()
	tt.Key(0, ui.KeySpace)
	tt.Frame()
	if got := order(store.SectionInbox); !slices.Equal(got, []string{"乙卡", "甲卡", "丙卡"}) || a.kbd.id != "" {
		t.Fatalf("Space 放下 %v", got)
	}
}
