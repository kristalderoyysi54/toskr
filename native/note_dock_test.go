package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 拖起一行：底部滑出「放到哪个分组」坞（不含所在组）；分组多于一页时拖到右侧翻页格停 400ms 翻页；松手在格上移入该组。
func TestNoteDockDropAndPage(t *testing.T) {
	orig := dragNow
	t.Cleanup(func() { dragNow = orig })
	now := time.Now()
	dragNow = func() time.Time { return now }
	a, tt := testApp(t, "甲卡")
	var last string
	for _, name := range []string{"一组", "二组", "三组", "四组", "五组", "六组"} {
		last = a.store.AddSection(name)
	}
	a.reload()
	tt.Frame()
	if tt.HasText("放到哪个分组") {
		t.Fatal("没拖时不应出坞")
	}
	f, ok := tt.Find("刚刚")
	if !ok {
		t.Fatal(tt.Texts())
	}
	fx, fy := f.X-30, f.Y+f.H/2 // 抓头行空白处（正文是拖出源）
	tt.Move(fx, fy)
	tt.Press(fx, fy)
	for i := 1; i <= 4; i++ {
		tt.Move(fx, fy+float32(i)*6)
		tt.Frame()
	}
	tt.Advance(500 * time.Millisecond)
	tt.Frame()
	if !tt.HasText("放到哪个分组") || a.rowDragID == "" {
		t.Fatalf("拖起应出坞 drag=%q %v", a.rowDragID, tt.Texts())
	}
	if _, ok := tt.Find("放到「收件箱」"); ok {
		t.Fatal("坞里不应有所在组")
	}
	r, ok := tt.Find("下一页分组")
	if !ok {
		t.Fatal("6 个分组应分两页")
	}
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	now = now.Add(450 * time.Millisecond)
	tt.Frame()
	if a.dockPage != 1 {
		t.Fatalf("停在翻页格上应翻页 page=%d", a.dockPage)
	}
	tt.Advance(600 * time.Millisecond)
	tt.Frame()
	g, ok := tt.Find("放到「六组」")
	if !ok {
		t.Fatal("第二页应有六组")
	}
	tt.Move(g.X+g.W/2, g.Y+g.H/2)
	tt.Frame()
	tt.Release(g.X+g.W/2, g.Y+g.H/2)
	tt.Frame()
	tt.Frame()
	moved := false
	for _, n := range a.store.Section(last) {
		moved = moved || n.Text == "甲卡"
	}
	if !moved {
		t.Fatal("松手应移入六组")
	}
	tt.Advance(600 * time.Millisecond)
	tt.Frame()
	if a.rowDragID != "" {
		t.Fatal("松手后坞应收起")
	}
}

// liftFirstRow：按住第一行头行空白处（正文是拖出源，不能抓正文）往下拖一点，坞出现。返回按下点。
func liftFirstRow(t *testing.T, tt *ui.Tester) (float32, float32) {
	t.Helper()
	f, ok := tt.Find("刚刚")
	if !ok {
		t.Fatal(tt.Texts())
	}
	fx, fy := f.X-30, f.Y+f.H/2
	tt.Move(fx, fy)
	tt.Press(fx, fy)
	for i := 1; i <= 4; i++ {
		tt.Move(fx, fy+float32(i)*6)
		tt.Frame()
	}
	tt.Advance(500 * time.Millisecond)
	tt.Frame()
	return fx, fy
}

func dropOn(tt *ui.Tester, label string) bool {
	g, ok := tt.Find(label)
	if !ok {
		return false
	}
	tt.Move(g.X+g.W/2, g.Y+g.H/2)
	tt.Frame()
	tt.Release(g.X+g.W/2, g.Y+g.H/2)
	tt.Frame()
	tt.Frame()
	return true
}

// 坞钉在列表最上方；多选拖动整组移入，格里冒「+N」，气泡撤销各回原位。
func TestNoteDockNearRowMultiUndo(t *testing.T) {
	a, tt := testApp(t, "甲卡", "乙卡", "丙卡")
	sec := a.store.AddSection("资料")
	a.reload()
	tt.Frame()
	ids := a.store.Section(store.SectionInbox)
	a.chosen.Add(ids[0].ID)
	a.chosen.Add(ids[1].ID)
	tt.Frame()
	_, fy := liftFirstRow(t, tt)
	r, ok := tt.Find("放到「资料」")
	if !ok {
		t.Fatal("应出坞", tt.Texts())
	}
	if r.Y > fy {
		t.Fatalf("坞应在列表最上方 row=%v dock=%v", fy, r.Y)
	}
	if !tt.HasText("2 条") {
		t.Fatal("多选拖动应有「2 条」角标")
	}
	if !dropOn(tt, "放到「资料」") {
		t.Fatal("找不到资料格")
	}
	if got := a.store.Section(sec); len(got) != 2 {
		t.Fatalf("两条都应移入 %d", len(got))
	}
	if !tt.HasText("+2") || !tt.HasText("放到哪个分组") && !tt.HasText("把 2 条放到哪个分组") {
		t.Fatalf("放入后坞应停留并冒「+2」 %v", tt.Texts())
	}
	a.hudUndo()
	a.reload()
	got := a.store.Section(store.SectionInbox)
	if len(got) != 3 || got[0].ID != ids[0].ID || got[1].ID != ids[1].ID {
		t.Fatalf("撤销应各回原位 %v", got)
	}
}

// 拖到「新建分组」格松手：坞留下来起名，↵ 建组并放入。
func TestNoteDockNewSection(t *testing.T) {
	a, tt := testApp(t, "甲卡")
	a.store.AddSection("资料")
	a.reload()
	tt.Frame()
	liftFirstRow(t, tt)
	if !dropOn(tt, "新建分组并放入") {
		t.Fatal("坞里应有新建分组格", tt.Texts())
	}
	tt.Advance(300 * time.Millisecond)
	tt.Frame()
	if len(a.dockNaming) != 1 || !tt.HasText("新建分组，放入 1 条") {
		t.Fatalf("松手后坞应留下来起名 %v", tt.Texts())
	}
	tt.Type("灵感")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	var last store.Section
	for _, s := range a.store.Sections() {
		if s.Name == "灵感" {
			last = s
		}
	}
	if last.ID == "" || len(a.store.Section(last.ID)) != 1 || len(a.dockNaming) != 0 {
		t.Fatalf("应建组并放入 %+v", a.store.Sections())
	}
}

// 坞里的分组按放入次数排：常去的排第一页最前；没用过的保持原顺序。
func TestDockSectionsByUse(t *testing.T) {
	a, _ := testApp(t, "甲卡")
	x := a.store.AddSection("一组")
	y := a.store.AddSection("二组")
	a.reload()
	id := a.store.Section(store.SectionInbox)[0].ID
	if s := a.dockSections(id); len(s) < 2 || s[0].ID != x {
		t.Fatalf("没用过保持原顺序 %v", s)
	}
	n, _ := a.store.Note(id)
	a.moveNotesTo([]store.Note{n}, y)
	n, _ = a.store.Note(id)
	a.moveNotesTo([]store.Note{n}, store.SectionInbox)
	if s := a.dockSections(id); s[0].ID != y {
		t.Fatalf("放过的排前 %v", s)
	}
}

// 拖起后原位收成一行小卡高，下面的行跟着上移；松手恢复。
func TestDragRowCollapses(t *testing.T) {
	a, tt := testApp(t, "甲卡\n第二行\n第三行\n第四行", "乙卡")
	a.reload()
	tt.Frame()
	below, _ := tt.Find("乙卡")
	fx, fy := liftFirstRow(t, tt)
	tt.Advance(time.Second)
	tt.Frame()
	after, ok := tt.Find("乙卡")
	if !ok || after.Y >= below.Y+dockSlotH-10 {
		t.Fatalf("拖起的行应收起、下面的行上移 %v → %v", below.Y, after.Y)
	}
	tt.Release(fx, fy)
	tt.Frame()
	tt.Advance(time.Second)
	tt.Frame()
	if a.rowDragLast != "" {
		t.Fatal("松手后应恢复")
	}
}
