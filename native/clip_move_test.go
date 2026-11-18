package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 剪贴卡「收下」浮钮：单击收进收件箱（原卡留在剪贴页）；长按弹出「收到哪里」，选中后收进该组；长按后的松开不算单击。
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
	if err := tt.Click("收下（长按选择分类）"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if n := savedCopy(a, "第二条剪贴"); n.Section != store.SectionInbox {
		t.Fatalf("单击应收进收件箱 %+v", n)
	}
	if n := noteByText(a, "第二条剪贴"); n.Section != store.SectionClipboard || n.SavedTo == "" {
		t.Fatalf("原卡应留在剪贴页并标记已收下 %+v", n)
	}

	r, _ = tt.Find("第一条剪贴")
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	b, ok := tt.Find("收下（长按选择分类）")
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
	if n := noteByText(a, "第一条剪贴"); n.SavedTo != "" {
		t.Fatalf("长按后松开不应收下 %+v", n)
	}
	if !tt.HasText("收到哪里") || !tt.HasText("Bug") {
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
	if err := tt.Click("收到 Bug"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if n := savedCopy(a, "第一条剪贴"); n.Section != sec || a.clipPick != "" {
		t.Fatalf("应收到 Bug %+v", n)
	}
}

// savedCopy：剪贴卡收下后在内容页里的那份副本。
func savedCopy(a *app, s string) store.Note {
	for _, n := range a.store.Notes() {
		if n.Text == s && n.Section != store.SectionClipboard {
			return n
		}
	}
	return store.Note{}
}

// 剪贴卡底栏「收下 ˅ / 提醒」：收下进收件箱并换成绿色小标；小箭头弹「收到哪里」，⏎ 收件箱、数字键收到分组、Esc 只关不收；
// 浮层关着时数字键不误收；提醒 = 收下 + 建一条到期提醒。
func TestClipKeepLinksAndKeys(t *testing.T) {
	a, tt := testApp(t)
	a.store.AddSection("提示词")
	sec2 := a.store.AddSection("报销")
	for _, s := range []string{"甲剪贴", "乙剪贴", "丙剪贴", "丁剪贴"} {
		if _, err := a.addClip(core.ClipEvent{Text: s, Source: macos.FrontApp{Name: "微信"}}); err != nil {
			t.Fatal(err)
		}
	}
	a.switchPage(pageClip)
	a.reload()
	tt.Frame()
	id := func(s string) string { return noteByText(a, s).ID }
	// 底栏「收下」
	a.selected = 0
	b, ok := tt.Find("收下")
	if !ok {
		t.Fatal("底栏应常驻「收下」", tt.Texts())
	}
	tt.ClickAt(b.X+b.W/2, b.Y+b.H/2)
	tt.Frame()
	first := a.clipList[0].Text
	if n := savedCopy(a, first); n.Section != store.SectionInbox {
		t.Fatalf("收下应进收件箱 %+v", n)
	}
	if !tt.HasText("收件箱") {
		t.Fatal("收下后底栏应换成分组小标")
	}
	// 小箭头 → 数字键 2 收到「报销」
	open := func(s string) {
		t.Helper()
		a.clipPick, a.clipPickAt = id(s), ui.Rect{X: 200, Y: 300, W: 14, H: 14}
		tt.Frame()
		if !tt.HasText("收到哪里") {
			t.Fatal("应弹出收到哪里")
		}
	}
	open("乙剪贴")
	tt.Key(0, ui.Key2)
	tt.Frame()
	if n := savedCopy(a, "乙剪贴"); n.Section != sec2 || a.clipPick != "" {
		t.Fatalf("按 2 应收到报销并关浮层 %+v pick=%q", n, a.clipPick)
	}
	// Esc 只关不收
	open("丙剪贴")
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.clipPick != "" || noteByText(a, "丙剪贴").SavedTo != "" {
		t.Fatal("Esc 应只关浮层")
	}
	// 浮层关着时数字键不误收
	tt.Key(0, ui.Key1)
	tt.Frame()
	if noteByText(a, "丙剪贴").SavedTo != "" {
		t.Fatal("浮层关着时数字键不应收下")
	}
	// ⏎ 收件箱
	open("丙剪贴")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if n := savedCopy(a, "丙剪贴"); n.Section != store.SectionInbox {
		t.Fatalf("回车应收进收件箱 %+v", n)
	}
	// 提醒 = 收下 + 建提醒
	if _, err := a.addClip(core.ClipEvent{Text: "戊剪贴", Source: macos.FrontApp{Name: "微信"}}); err != nil {
		t.Fatal(err)
	}
	before := len(a.store.Tasks())
	at := time.Now().Add(3 * time.Hour)
	a.remindClip(noteByText(a, "戊剪贴"), at)
	if n := savedCopy(a, "戊剪贴"); n.Section != store.SectionInbox {
		t.Fatalf("设提醒应同时收下 %+v", n)
	}
	if ts := a.store.Tasks(); len(ts) != before+1 || !ts[0].DueAt.Equal(at) || ts[0].Note != "戊剪贴" {
		t.Fatalf("应建一条到期提醒 %+v", ts)
	}
	a.hudUndo()
	if len(a.store.Tasks()) != before || noteByText(a, "戊剪贴").SavedTo != "" {
		t.Fatalf("撤销应删掉提醒并取消收下 tasks=%d/%d saved=%q hud=%q", len(a.store.Tasks()), before, noteByText(a, "戊剪贴").SavedTo, a.hudText)
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

// 「提醒我」浮层：输入「3小时后」实时认出时间，⏎ 设提醒并收下；认不出的不设；Esc 关闭。
func TestClipRemindPopoverInput(t *testing.T) {
	a, tt := testApp(t)
	if _, err := a.addClip(core.ClipEvent{Text: "提醒剪贴", Source: macos.FrontApp{Name: "微信"}}); err != nil {
		t.Fatal(err)
	}
	a.switchPage(pageClip)
	a.reload()
	tt.Frame()
	if err := tt.Click("提醒"); err != nil {
		t.Fatal(err, tt.Texts())
	}
	tt.Frame()
	if a.remindPick == "" || !tt.HasText("提醒我") {
		t.Fatal("应弹出提醒我浮层", tt.Texts())
	}
	tt.Type("随便写写")
	tt.Frame()
	if !tt.HasText("认不出时间，换个说法试试") {
		t.Fatal("认不出时应提示", tt.Texts())
	}
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if len(a.store.Tasks()) != 0 {
		t.Fatal("认不出时回车不应设提醒")
	}
	a.remindText = ""
	tt.Frame()
	tt.Type("3小时后")
	tt.Frame()
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	ts := a.store.Tasks()
	if len(ts) != 1 || ts[0].DueAt.Sub(time.Now()) < 170*time.Minute || a.remindPick != "" {
		t.Fatalf("应设 3 小时后的提醒并关闭浮层 %+v pick=%q", ts, a.remindPick)
	}
	if n := savedCopy(a, "提醒剪贴"); n.Section != store.SectionInbox {
		t.Fatal("设提醒应同时收下")
	}
}
