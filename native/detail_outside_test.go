package main

import (
	"bytes"
	"slices"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 详情窗标签：没按回车就点别处，输入的文字也存成标签并收起输入框（用户 2026-11-12）。
func TestDetailTagSavedOnClickOutside(t *testing.T) {
	a, _ := testApp(t, "一段正文")
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1}
	tt := ui.NewTester(a.detailView, 560, 540)
	tt.Frame()
	if err := tt.Click("＋ 标签"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	tt.Frame()
	tt.Type("周报")
	tt.Frame()
	tt.ClickAt(280, 400) // 正文区
	tt.Frame()
	tt.Frame()
	cur, _ := a.store.Note(n.ID)
	if !slices.Contains(cur.Tags, "周报") || a.detail.tagOn {
		t.Fatalf("点别处应保存并收起 tags=%v on=%v", cur.Tags, a.detail.tagOn)
	}
	if !tt.HasText("＋ 标签") {
		t.Fatalf("输入框收起后应回到「＋ 标签」 %v", tt.Texts())
	}
}

// 按发送次数排序（分组级设置）：发送成功累计次数；开了排序的分组未完成卡次数多的在前、同次数保持手动顺序。
func TestSortNotesBySendCount(t *testing.T) {
	a, _ := testApp(t, "甲", "乙", "丙")
	ns := a.store.Notes()
	byText := map[string]string{}
	for _, n := range ns {
		byText[n.Text] = n.ID
	}
	manual := func() []string {
		a.reload()
		var out []string
		for _, n := range a.notes {
			out = append(out, n.Text)
		}
		return out
	}
	before := manual()
	for _, id := range []string{byText["丙"], byText["丙"], byText["乙"]} {
		_ = a.store.SetKept(id, true) // 常用卡发送后不标完成，留在列表里
		a.store.AddDelivery(store.Delivery{Status: "sent", SourceIDs: []string{id}})
		_ = a.store.MarkSent([]string{id}, a.now())
	}
	if n, _ := a.store.Note(byText["丙"]); n.SendCount != 2 {
		t.Fatalf("发送次数应累计 %d", n.SendCount)
	}
	if got := manual(); !slices.Equal(got, before) {
		t.Fatalf("未开排序应保持手动顺序 %v → %v", before, got)
	}
	inbox := a.store.Sections()[0]
	inbox.Sort = store.SortSent
	_ = a.store.UpdateSection(inbox)
	got := manual()
	if got[0] != "丙" || got[1] != "乙" || got[2] != "甲" {
		t.Fatalf("应按发送次数降序 %v", got)
	}
	// 最近发送：乙最后发，排第一；甲没发过排最后
	inbox.Sort = store.SortRecent
	_ = a.store.UpdateSection(inbox)
	if got := manual(); got[0] != "乙" || got[1] != "丙" || got[2] != "甲" {
		t.Fatalf("应按最近发送 %v", got)
	}
	// 清零后不再靠前，且重开数据不会按发送历史补回来
	inbox.Sort = store.SortSent
	_ = a.store.UpdateSection(inbox)
	if _, err := a.store.SetSendCount(byText["丙"], 0); err != nil {
		t.Fatal(err)
	}
	if got := manual(); got[0] != "乙" {
		t.Fatalf("清零后应让位 %v", got)
	}
}

// 清零发送次数要持久：回填只做一次，重开数据不会按发送历史补回。
func TestSendCountResetPersists(t *testing.T) {
	dir, key := t.TempDir(), bytes.Repeat([]byte{1}, 32)
	st, _ := store.OpenDir(dir, key)
	n, _, _ := st.Add(store.Note{Section: store.SectionInbox, Text: "卡"})
	st.AddDelivery(store.Delivery{Status: "sent", SourceIDs: []string{n.ID}})
	_ = st.MarkSent([]string{n.ID}, time.Now())
	if _, err := st.SetSendCount(n.ID, 0); err != nil {
		t.Fatal(err)
	}
	_ = st.Flush()
	re, _ := store.OpenDir(dir, key)
	if got, _ := re.Note(n.ID); got.SendCount != 0 {
		t.Fatalf("清零应持久 %d", got.SendCount)
	}
}

// 11-12 迭代版存的 sortBySent 并入 Sort。
func TestLegacySortBySentMigrates(t *testing.T) {
	dir, key := t.TempDir(), bytes.Repeat([]byte{1}, 32)
	st, _ := store.OpenDir(dir, key)
	sec := st.Sections()[0]
	sec.SortBySent = true
	_ = st.UpdateSection(sec)
	_ = st.Flush()
	re, _ := store.OpenDir(dir, key)
	if got := re.Sections()[0]; got.Sort != store.SortSent || got.SortBySent {
		t.Fatalf("旧字段应迁移 %+v", got)
	}
}
