package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/toskr/native/internal/store"
)

func inboxOpenCount(a *app) int { return len(a.inboxOpenNotes()) }

// 收件箱整批操作（抽屉头「…」）：全部归到某组 / 全部标为完成 / 全部删除，都能整批撤销；点「…」不连带开合抽屉；整批归类不记规则。
func TestInboxBulkActions(t *testing.T) {
	a, tt, secs := drawerApp(t)
	open := a.inboxDrawerOpen()
	if err := tt.Click("整批操作"); err != nil {
		t.Fatal(err)
	}
	if a.inboxDrawerOpen() != open {
		t.Fatal("点「…」不该开合抽屉")
	}
	if err := tt.ChooseMenuItem("全部归到（5 条）", "Bug"); err != nil {
		t.Fatalf("%v 菜单 %v", err, tt.Menu())
	}
	tt.Frame()
	tt.Frame()
	if inboxOpenCount(a) != 0 || len(a.store.Section(secs[1])) != 6 || len(a.store.Settings().FileRules) != 0 {
		t.Fatalf("应全部移入 Bug 且不记规则：收件箱 %d · Bug %d · 规则 %d", inboxOpenCount(a), len(a.store.Section(secs[1])), len(a.store.Settings().FileRules))
	}
	if a.hudUndo == nil {
		t.Fatal("应可撤销")
	}
	a.hudUndo()
	tt.Frame()
	tt.Frame()
	if inboxOpenCount(a) != 5 || a.inboxOpenNotes()[0].Text != "最新进来的" {
		t.Fatalf("撤销后 5 条回到收件箱原顺序 %d", inboxOpenCount(a))
	}

	if err := tt.Click("整批操作"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("全部标为完成"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	tt.Frame()
	if inboxOpenCount(a) != 0 || len(a.store.Section(store.SectionInbox)) != 5 {
		t.Fatal("应全部标为完成（仍在收件箱）")
	}
	if _, ok := tt.Find("整批操作"); ok {
		t.Fatal("没有未完成的条目时不出「…」")
	}
	a.hudUndo()
	tt.Frame()
	tt.Frame()
	if inboxOpenCount(a) != 5 {
		t.Fatal("撤销后应恢复未完成")
	}

	if err := tt.Click("整批操作"); err != nil {
		t.Fatal(err)
	}
	answer := false
	inboxDeleteAsk = func(int) bool { return answer }
	if err := tt.ChooseMenuItem("全部删除（5 条）…"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if inboxOpenCount(a) != 5 {
		t.Fatal("取消确认不应删除")
	}
	answer = true
	_ = tt.Click("整批操作")
	if err := tt.ChooseMenuItem("全部删除（5 条）…"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	tt.Frame()
	if len(a.store.Section(store.SectionInbox)) != 0 || a.hudText != "已清空收件箱 · 删除 5 条" {
		t.Fatalf("应清空 %q", a.hudText)
	}
	a.hudUndo()
	tt.Frame()
	tt.Frame()
	if inboxOpenCount(a) != 5 || a.inboxOpenNotes()[0].Text != "最新进来的" || !tt.HasText("32") && !tt.HasText("5") {
		t.Fatalf("撤销后 5 条按原顺序回来 %d", inboxOpenCount(a))
	}
}

// 列表模式（收件箱排在分组列表里）：分组头右键菜单里同样有整批操作。
func TestInboxBulkInListMode(t *testing.T) {
	a, tt := testApp(t, "甲", "乙", "丙")
	if err := tt.RightClick("收件箱"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("全部标为完成"); err != nil {
		t.Fatalf("%v 菜单 %v", err, tt.Menu())
	}
	tt.Frame()
	if inboxOpenCount(a) != 0 || a.hudUndo == nil {
		t.Fatal("应全部标为完成且可撤销")
	}
	a.hudUndo()
	if inboxOpenCount(a) != 3 {
		t.Fatal("撤销后恢复")
	}
}

// TestInboxBulkShots：抽屉头带「…」，收起 / 展开，两位数条数，浅深两色（TOSKR_SHOT_DIR 未设时跳过）。
func TestInboxBulkShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	for _, dark := range []bool{false, true} {
		a, tt, _ := drawerApp(t)
		for i := range 27 {
			a.store.Add(store.Note{Section: store.SectionInbox, Text: "一条比较长的收件箱内容，用来挤一挤抽屉头这一行 " + itoa(i)})
		}
		tt.SetDark(dark)
		for _, open := range []bool{false, true} {
			a.setDrawerOpen(open)
			a.invalidateAll()
			tt.Frame()
			tt.Advance(time.Second)
			tt.Frame()
			save(t, filepath.Join(dir, "inbox-bulk-"+map[bool]string{false: "closed", true: "open"}[open]+"-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), tt.Image())
		}
	}
}
