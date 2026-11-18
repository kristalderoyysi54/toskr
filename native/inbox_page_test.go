package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func addNote(t *testing.T, a *app, n store.Note) store.Note {
	t.Helper()
	x, _, err := a.store.Add(n)
	if err != nil {
		t.Fatal(err)
	}
	return x
}

// 常用栏（用户 2026-11-17 定）：★ 在前按发送次数，其余按次数补满；收件箱、剪贴板、已完成、没发过也没 ★ 的不进。
func TestQuickNotesOrder(t *testing.T) {
	a, _ := testApp(t)
	sec := a.store.AddSection("提示词")
	mk := func(text string, sent int, star bool) {
		n := addNote(t, a, store.Note{Section: sec, Text: text})
		_, _ = a.store.SetSendCount(n.ID, sent)
		_ = a.store.SetKept(n.ID, star)
	}
	mk("代码审查", 14, true)
	mk("翻译成英文", 6, false)
	mk("周报", 2, true)
	mk("解释报错", 11, false)
	mk("从没用过", 0, false)
	in := addNote(t, a, store.Note{Section: store.SectionInbox, Text: "收件箱里的"})
	_, _ = a.store.SetSendCount(in.ID, 99)
	a.reload()
	var got []string
	for _, n := range a.quick {
		got = append(got, n.Text)
	}
	want := []string{"代码审查", "周报", "解释报错", "翻译成英文"}
	if len(got) != len(want) {
		t.Fatalf("常用栏 %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("常用栏顺序 %v，应为 %v", got, want)
		}
	}
}

// 常用栏：纵向滚轮转横向，滚到头停住、不带动外层列表（防误操作）。
func TestQuickStripWheel(t *testing.T) {
	a, tt := testApp(t)
	sec := a.store.AddSection("提示词")
	for i := range 10 {
		n := addNote(t, a, store.Note{Section: sec, Text: "常用提示词 " + itoa(i)})
		_, _ = a.store.SetSendCount(n.ID, 10-i)
	}
	for i := range 20 { // 撑高列表，外层才能滚
		addNote(t, a, store.Note{Section: sec, Text: "普通卡 " + itoa(i)})
	}
	a.switchPage(pageNotes)
	tt.Frame()
	tt.Frame()
	if !tt.HasText("常用") || a.quickScroll.MaxX <= 0 {
		t.Fatalf("常用栏应可横向滚动 MaxX=%v", a.quickScroll.MaxX)
	}
	r, ok := tt.Find("常用提示词 0")
	if !ok {
		t.Fatal(tt.Texts())
	}
	tt.Scroll(r.X+r.W/2, r.Y+r.H/2, 0, 120)
	tt.Frame()
	if a.quickScroll.X != 120 || a.noteScroll.Y != 0 {
		t.Fatalf("纵向滚轮应转横向 X=%v outerY=%v", a.quickScroll.X, a.noteScroll.Y)
	}
	tt.Scroll(r.X+r.W/2, r.Y+r.H/2, 0, 5000)
	tt.Frame()
	tt.Scroll(r.X+r.W/2, r.Y+r.H/2, 0, 80)
	tt.Frame()
	if a.quickScroll.X != a.quickScroll.MaxX || a.noteScroll.Y != 0 {
		t.Fatalf("到头后应停住、不滚外层 X=%v/%v outerY=%v", a.quickScroll.X, a.quickScroll.MaxX, a.noteScroll.Y)
	}
	tt.Scroll(r.X+r.W/2, r.Y+r.H+200, 0, 80) // 指针移出常用栏：照常滚列表
	tt.Frame()
	if a.noteScroll.Y <= 0 {
		t.Fatalf("常用栏外应能滚列表 outerY=%v", a.noteScroll.Y)
	}
}

// 收件箱建议：同一来源 + 类型大多归在哪就建议哪（至少 2 条）；「按建议归好」全部归过去，可撤销；
// 同类归到同组满 3 次自动记成规则，之后的建议标为规则。
func TestInboxSuggestAndLearnRule(t *testing.T) {
	a, tt := testApp(t)
	claim := a.store.AddSection("报销")
	a.store.AddSection("资料")
	fs := func(text, sec string) store.Note {
		return addNote(t, a, store.Note{Section: sec, Text: text, SourceApp: "飞书", BundleID: "com.feishu"})
	}
	fs("发票一", claim)
	fs("发票二", claim)
	x := fs("新发票甲", store.SectionInbox)
	y := fs("新发票乙", store.SectionInbox)
	addNote(t, a, store.Note{Section: store.SectionInbox, Text: "没来源的", SourceApp: "", BundleID: ""})
	a.switchPage(pageNotes)
	a.reload()
	if s, ok := a.inboxSug[x.ID]; !ok || s.section != claim || s.rule {
		t.Fatalf("应建议报销（非规则） %+v %v", s, ok)
	}
	if len(a.inboxSug) != 2 {
		t.Fatalf("没来源的不应有建议 %v", a.inboxSug)
	}
	tt.Frame()
	if !tt.HasText("按建议归好 2 条") || !tt.HasText("逐条整理") {
		t.Fatal("收件箱头部应有按建议归好 / 逐条整理", tt.Texts())
	}
	if err := tt.Click("按建议归好 2 条"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	for _, id := range []string{x.ID, y.ID} {
		if n, _ := a.store.Note(id); n.Section != claim {
			t.Fatalf("应归到报销 %+v", n)
		}
	}
	rules := a.store.Settings().FileRules
	if len(rules) != 1 || rules[0].Bundle != "com.feishu" || rules[0].Section != claim || rules[0].Kind != "text" {
		t.Fatalf("同类归同组满 3 次应记成规则 %+v", rules)
	}
	a.hudUndo()
	if n, _ := a.store.Note(x.ID); n.Section != store.SectionInbox {
		t.Fatal("撤销应放回收件箱")
	}
	a.reload()
	if s := a.inboxSug[x.ID]; !s.rule {
		t.Fatalf("有规则后建议应标为规则 %+v", s)
	}
	// 单条建议胶囊：点一下归过去
	tt.Frame()
	if err := tt.Click("归到 报销"); err == nil {
		tt.Frame()
	}
}

// 逐条整理：数字键归到对应分组（与「收到哪里」同一套），空格跳过，⏎ 按建议，Esc 退出；整理完自动关闭。
func TestInboxTriageKeys(t *testing.T) {
	a, tt := testApp(t)
	s1 := a.store.AddSection("提示词")
	s2 := a.store.AddSection("报销")
	s3 := a.store.AddSection("资料")
	for _, s := range []string{"丙", "乙", "甲"} {
		addNote(t, a, store.Note{Section: store.SectionInbox, Text: "整理" + s})
	}
	a.switchPage(pageNotes)
	tt.Frame()
	if err := tt.Click("逐条整理"); err != nil {
		t.Fatal(err, tt.Texts())
	}
	tt.Frame()
	if !a.triageOn || !tt.HasText("第 1 / 3 条") || !tt.HasText("1–3") {
		t.Fatal("应打开逐条整理并显示进度与键位", tt.Texts())
	}
	sec := func(text string) string { return noteByText(a, text).Section }
	tt.Key(0, ui.Key2)
	tt.Frame()
	if sec("整理甲") != s2 {
		t.Fatalf("按 2 应归到报销：%q", sec("整理甲"))
	}
	tt.Key(0, ui.KeySpace)
	tt.Frame()
	if sec("整理乙") != store.SectionInbox || !tt.HasText("整理丙") {
		t.Fatal("空格应跳过乙、显示下一条", tt.Texts())
	}
	tt.Key(0, ui.Key3)
	tt.Frame()
	if sec("整理丙") != s3 {
		t.Fatalf("按 3 应归到资料：%q", sec("整理丙"))
	}
	if a.triageOn {
		t.Fatal("没有未处理的条目后应自动关闭")
	}
	// 再开：Esc 退出且不归类
	a.triageOn, a.triageSkip = true, map[string]bool{}
	tt.Frame()
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.triageOn || sec("整理乙") != store.SectionInbox {
		t.Fatal("Esc 应只退出")
	}
	_ = s1
}

// 鼠标点选一行后指针移走：操作钮隐藏（用户 2026-11-17）；方向键移来的焦点照常常显。
func TestRowActionsHideOnLeave(t *testing.T) {
	a, tt := testApp(t, "甲行", "乙行")
	r, ok := tt.Find("甲行")
	if !ok {
		t.Fatal(tt.Texts())
	}
	tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	if !tt.HasText("删除") {
		t.Fatalf("悬停时应有操作钮 %v", tt.Texts())
	}
	tt.Move(r.X+r.W/2, r.Y+400) // 移到列表外
	tt.Frame()
	tt.Advance(300 * time.Millisecond)
	tt.Frame()
	if tt.HasText("删除") {
		t.Fatalf("指针移走后操作钮应隐藏 %v", tt.Texts())
	}
	a.focusAt(1)
	tt.Frame()
	if !tt.HasText("删除") {
		t.Fatal("方向键移来的焦点应常显操作钮")
	}
}

// 标题栏 ☰ 菜单的「全部折叠 / 全部展开」作用于笔记页列出的所有分组。
func TestFoldAllSections(t *testing.T) {
	a, tt := testApp(t, "甲")
	a.store.AddSection("工作")
	a.reload()
	tt.Frame()
	a.menuOpen = true
	tt.Frame()
	if tt.HasText("全部展开") || !tt.HasText("保持面板展开") {
		t.Fatalf("都展开着不该有「全部展开」；面板设置在同一个菜单末尾 %v", tt.Texts())
	}
	if err := tt.Click("全部折叠"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if open, shut := a.sectionFoldCounts(); open != 0 || shut < 2 {
		t.Fatalf("应全部折叠 open=%d shut=%d", open, shut)
	}
	if a.menuOpen {
		t.Fatal("选完应收起菜单")
	}
	a.menuOpen = true
	tt.Frame()
	if err := tt.Click("全部展开"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if _, shut := a.sectionFoldCounts(); shut != 0 {
		t.Fatalf("应全部展开 shut=%d", shut)
	}
}

// 常用栏点标题行折叠（只剩标题行、方块不再构建），状态存设置，再点展开。
func TestQuickStripCollapse(t *testing.T) {
	a, tt := testApp(t)
	sec := a.store.AddSection("提示词")
	n := addNote(t, a, store.Note{Section: sec, Text: "常用提示词"})
	_, _ = a.store.SetSendCount(n.ID, 3)
	a.switchPage(pageNotes)
	tt.Frame()
	tt.Frame()
	if _, ok := tt.Find("发送：常用提示词"); !ok {
		t.Fatal("常用方块应在", tt.Texts())
	}
	if err := tt.Click("折叠常用"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	tt.Advance(400 * time.Millisecond)
	tt.Frame()
	if !a.store.Settings().QuickCollapsed {
		t.Fatal("应存为折叠")
	}
	if _, ok := tt.Find("发送：常用提示词"); ok {
		t.Fatal("折叠后不应再有方块")
	}
	if err := tt.Click("展开常用"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.store.Settings().QuickCollapsed {
		t.Fatal("应展开")
	}
}
