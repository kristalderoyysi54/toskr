package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 剪贴卡「移入笔记」浮钮：单击进收件箱；长按弹出分组选择，选中后进该组；长按后的松开不算单击。
func TestClipMoveButtonClickAndLongPress(t *testing.T) {
	a, tt := testApp(t)
	orig := lpAfter
	t.Cleanup(func() { lpAfter = orig })
	var fire func()
	lpAfter = func(_ time.Duration, f func()) { fire = f }
	sec := a.store.AddSection("Bug")
	for _, s := range []string{"第一条剪贴", "第二条剪贴"} {
		if _, err := a.addClip(core.ClipEvent{Text: s, Source: macos.FrontApp{Name: "Safari"}}); err != nil {
			t.Fatal(err)
		}
	}
	a.switchPage(pageClip)
	a.reload()
	tt.Frame()
	r, ok := tt.Find("第二条剪贴")
	if !ok {
		t.Fatal(tt.Texts())
	}
	tt.Move(r.X+r.W/2, r.Y+r.H/2) // 悬停显出浮钮
	tt.Frame()
	if err := tt.Click("移入笔记（长按选择分类）"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if n := noteByText(a, "第二条剪贴"); n.Section != store.SectionInbox {
		t.Fatalf("单击应进收件箱 %+v", n)
	}

	r, _ = tt.Find("第一条剪贴")
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	b, ok := tt.Find("移入笔记（长按选择分类）")
	if !ok {
		t.Fatal("浮钮未显出")
	}
	tt.Press(b.X+b.W/2, b.Y+b.H/2)
	tt.Frame()
	fire() // 450ms 到
	if a.clipPick == "" {
		t.Fatal("长按应弹出分组选择")
	}
	tt.Release(b.X+b.W/2, b.Y+b.H/2)
	tt.Frame()
	if n := noteByText(a, "第一条剪贴"); n.Section != store.SectionClipboard {
		t.Fatalf("长按后松开不应移动 %+v", n)
	}
	if !tt.HasText("移入笔记分类") || !tt.HasText("Bug") {
		t.Fatalf("应弹出分组选择 %v", tt.Texts())
	}
	if a.clipPickAt.W == 0 {
		t.Fatal("应记下浮钮位置，浮层挂在它旁边")
	}
	a.chosen.Add(noteByText(a, "第一条剪贴").ID) // 真机上长按时卡片常处于选中态
	tt.Frame()
	tt.Key(0, ui.KeyEscape) // Esc 先关浮层（不清选择、不移动）
	tt.Frame()
	if a.clipPick != "" || a.chosen.Len() != 1 {
		t.Fatalf("Esc 应先关分组选择、保留选择 pick=%q chosen=%d", a.clipPick, a.chosen.Len())
	}
	a.chosen.Clear()
	a.clipPick = noteByText(a, "第一条剪贴").ID
	tt.Frame()
	if err := tt.Click("移入 Bug"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if n := noteByText(a, "第一条剪贴"); n.Section != sec || a.clipPick != "" {
		t.Fatalf("应移入 Bug %+v", n)
	}
}

func noteByText(a *app, s string) store.Note {
	for _, n := range a.store.Notes() {
		if n.Text == s {
			return n
		}
	}
	return store.Note{}
}
