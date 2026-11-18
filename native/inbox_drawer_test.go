package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// drawerApp：打开抽屉模式的测试应用——两个用户分组，收件箱里 5 条（3 条来自 Arc、建议归「可借鉴」）。
func drawerApp(t *testing.T) (*app, *ui.Tester, []string) {
	a, tt := testApp(t)
	inboxDrawer = true
	ref, bug := a.store.AddSection("可借鉴"), a.store.AddSection("Bug")
	for i := range 2 {
		a.store.Add(store.Note{Section: ref, Text: "旧参考 " + itoa(i), BundleID: "arc", SourceApp: "Arc"})
	}
	a.store.Add(store.Note{Section: bug, Text: "旧缺陷"})
	for i := range 3 {
		a.store.Add(store.Note{Section: store.SectionInbox, Text: "新参考 " + itoa(i), BundleID: "arc", SourceApp: "Arc"})
	}
	a.store.Add(store.Note{Section: store.SectionInbox, Text: "没有去处的一条"})
	a.store.Add(store.Note{Section: store.SectionInbox, Text: "最新进来的"})
	a.switchPage(pageNotes)
	a.reload()
	tt.Frame()
	tt.Frame()
	return a, tt, []string{ref, bug}
}

// 收件箱在底部抽屉里：收起时列表里没有它的卡、只露一行（条数 + 最新一条）；点开看到分堆和卡；键盘列表展开才含收件箱。
func TestInboxDrawerCollapsedAndOpen(t *testing.T) {
	a, tt, _ := drawerApp(t)
	if !a.drawerMode() {
		t.Fatal("有用户分组时应走抽屉")
	}
	if !tt.HasText("收件箱") || !tt.HasText("5") || !tt.HasText("最新进来的") || tt.HasText("没有去处的一条") || tt.HasText("逐条整理") {
		t.Fatalf("收起：一行，露最新一条 %v", tt.Texts())
	}
	if slices.ContainsFunc(a.notes, func(n store.Note) bool { return n.Section == store.SectionInbox }) {
		t.Fatal("收起时键盘列表不含收件箱")
	}
	bar, _ := tt.Find("展开收件箱")
	list, _ := tt.Find("旧缺陷")
	if bar.Y <= list.Y {
		t.Fatalf("抽屉应在分组列表下面 bar=%v list=%v", bar, list)
	}
	if err := tt.Click("展开收件箱"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	tt.Advance(time.Second)
	tt.Frame()
	if !a.store.Settings().InboxOpen || !tt.HasText("没有去处的一条") || !tt.HasText("逐条整理") || !tt.HasText("归入") || !tt.HasText("收起收件箱") {
		t.Fatalf("展开：分堆 + 卡 %v", tt.Texts())
	}
	if n := len(a.notes); n < 5 || a.notes[n-1].Section != store.SectionInbox {
		t.Fatal("展开后收件箱的卡排在键盘列表最后")
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		for _, dark := range []bool{false, true} {
			tt.SetDark(dark)
			a.invalidateAll()
			tt.Frame()
			tt.Advance(time.Second)
			tt.Frame()
			mode := map[bool]string{false: "light", true: "dark"}[dark]
			save(t, filepath.Join(dir, "inbox-drawer-open-"+mode+".png"), tt.Image())
			a.setDrawerOpen(false)
			tt.Frame()
			tt.Advance(time.Second)
			tt.Frame()
			save(t, filepath.Join(dir, "inbox-drawer-closed-"+mode+".png"), tt.Image())
			a.setDrawerOpen(true)
		}
	}
}

// 按去向分堆：同一去向 2 条以上列成一堆，「归入」一次送走整堆，可撤销；清空后抽屉整条让位。
func TestInboxDrawerPiles(t *testing.T) {
	a, tt, secs := drawerApp(t)
	g, _ := a.inboxGroup()
	piles := a.inboxPiles(g.open)
	if len(piles) != 1 || piles[0].sec.ID != secs[0] || len(piles[0].ids) != 3 {
		t.Fatalf("应有一堆：可借鉴 3 条 %+v", piles)
	}
	a.setDrawerOpen(true)
	tt.Frame()
	tt.Advance(time.Second)
	tt.Frame()
	if err := tt.Click("归入"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if got := len(a.store.Section(store.SectionInbox)); got != 2 || len(a.store.Section(secs[0])) != 5 {
		t.Fatalf("整堆应归到可借鉴，收件箱剩 2 条，实际 %d", got)
	}
	if a.hudUndo == nil {
		t.Fatal("应可撤销")
	}
	a.hudUndo()
	if got := len(a.store.Section(store.SectionInbox)); got != 5 {
		t.Fatalf("撤销后回收件箱 %d", got)
	}
	tt.Frame()
	tt.Frame()
	if err := tt.Click("按建议归好 3 条"); err != nil { // 全部按建议归好仍在（抽屉里分堆上面一行）
		t.Fatalf("%v %v", err, tt.Texts())
	}
	tt.Frame()
	if got := len(a.store.Section(store.SectionInbox)); got != 2 {
		t.Fatalf("按建议归好后收件箱剩 2 条，实际 %d", got)
	}
	a.hudUndo()
	for _, n := range a.store.Section(store.SectionInbox) {
		_ = a.store.MoveTo(n.ID, secs[1])
	}
	a.reload()
	tt.Frame()
	tt.Frame()
	if _, ok := tt.Find("收起收件箱"); ok || tt.HasText("收件箱 ") {
		t.Fatalf("清空后抽屉应让位 %v", tt.Texts())
	}
}

// 搜索时收件箱照旧排在列表里（命中的卡看得到）；定位到收件箱里的卡会先展开抽屉。
func TestInboxDrawerSearchAndFocus(t *testing.T) {
	a, tt, _ := drawerApp(t)
	a.query = "没有去处"
	a.reload()
	tt.Frame()
	if a.drawerMode() || !tt.HasText("没有去处的一条") {
		t.Fatalf("搜索时不走抽屉，命中可见 %v", tt.Texts())
	}
	a.query = ""
	a.reload()
	var target store.Note
	for _, n := range a.store.Section(store.SectionInbox) {
		if n.Text == "没有去处的一条" {
			target = n
		}
	}
	a.focusNote(target)
	tt.Frame()
	tt.Frame()
	if cur, ok := a.current(); !a.store.Settings().InboxOpen || !ok || cur.ID != target.ID {
		t.Fatal("定位到收件箱里的卡应展开抽屉并选中它")
	}
}
