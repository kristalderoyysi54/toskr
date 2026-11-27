package main

import (
	"reflect"
	"slices"
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

// 常用区（用户 2026-11-18 定）：只放 ★ 的卡，按拖动排出的顺序（不在顺序里的排后面）；剪贴板、已完成、没 ★ 的不进。
func TestQuickNotesOrder(t *testing.T) {
	a, _ := testApp(t)
	sec := a.store.AddSection("提示词")
	ids := map[string]string{}
	mk := func(section, text string, sent int, star bool) {
		n := addNote(t, a, store.Note{Section: section, Text: text})
		_, _ = a.store.SetSendCount(n.ID, sent)
		_ = a.store.SetKept(n.ID, star)
		ids[text] = n.ID
	}
	mk(sec, "代码审查", 14, true)
	mk(sec, "翻译成英文", 99, false)
	mk(sec, "周报", 2, true)
	mk(store.SectionInbox, "收件箱里的", 0, true)
	mk(store.SectionClipboard, "固定的剪贴", 5, true)
	mk(sec, "做完的", 5, true)
	_ = a.store.SetDone(ids["做完的"], true)
	a.patchSettings(func(x *store.Settings) { x.QuickOrder = []string{ids["周报"], "已删的卡", ids["代码审查"]} })
	a.reload()
	var got []string
	for _, n := range a.quick {
		got = append(got, n.Text)
	}
	if want := []string{"周报", "代码审查", "收件箱里的"}; !slices.Equal(got, want) {
		t.Fatalf("常用区 %v，应为 %v", got, want)
	}
}

// quickTestApp：n 张常用卡（「常用 0」…）+ 一张普通卡，停在内容页。
func quickTestApp(t *testing.T, n int) (*app, *ui.Tester, string) {
	a, tt := testApp(t)
	sec := a.store.AddSection("提示词")
	for i := range n {
		x := addNote(t, a, store.Note{Section: sec, Text: "常用 " + itoa(i)})
		_ = a.store.SetKept(x.ID, true)
	}
	addNote(t, a, store.Note{Section: sec, Text: "普通卡"})
	a.switchPage(pageNotes)
	tt.Frame()
	tt.Frame()
	return a, tt, sec
}

func quickTexts(a *app) (out []string) {
	for _, n := range a.quick {
		out = append(out, n.Text)
	}
	return
}

// dragTo：从 (fx, fy) 拖到 (tx, ty) 松手。
func dragTo(tt *ui.Tester, fx, fy, tx, ty float32) {
	tt.Move(fx, fy)
	tt.Press(fx, fy)
	for i := 1; i <= 6; i++ {
		tt.Move(fx+(tx-fx)*float32(i)/6, fy+(ty-fy)*float32(i)/6)
		tt.Frame()
	}
	tt.Frame()
	tt.Release(tx, ty)
	tt.Frame()
	tt.Frame()
}

// 常用区布局：每行 3 个等宽，最多露出 3 行，更多的区内纵向滚动；没有常用卡就不显示；不再有折叠开关。
func TestQuickGridLayout(t *testing.T) {
	a, tt, _ := quickTestApp(t, 4)
	at := func(i int) ui.Rect { r, _ := tt.Find("发送：" + a.quick[i].Text); return r }
	r0, r2, r3 := at(0), at(2), at(3)
	if r0.W < 80 || r0.Y != r2.Y || r3.Y <= r0.Y || r3.X != r0.X || abs32(r0.W-r2.W) > 0.5 {
		t.Fatalf("应 3 个一行、等宽，第 4 个换行 %v %v %v", r0, r2, r3)
	}
	if a.quickStripHeight() != 2*quickCardH+quickGap {
		t.Fatalf("4 个应占 2 行 %v", a.quickStripHeight())
	}
	if _, ok := tt.Find("折叠常用"); ok {
		t.Fatal("不应再有折叠开关")
	}
	a, tt, _ = quickTestApp(t, 11)
	if a.quickStripHeight() != 3*quickCardH+2*quickGap {
		t.Fatalf("11 个应只露出 3 行 %v", a.quickStripHeight())
	}
	if a.quickScroll.MaxY <= 0 {
		t.Fatalf("超过 3 行应可纵向滚动 MaxY=%v", a.quickScroll.MaxY)
	}
	a, tt, _ = quickTestApp(t, 0)
	if _, ok := tt.Find("quick-strip"); ok || a.quickStripShown() {
		t.Fatal("没有常用卡不应显示常用区")
	}
}

// 常用区内拖动换位置：顺序存进设置。
func TestQuickDragReorder(t *testing.T) {
	a, tt, _ := quickTestApp(t, 4)
	want := []string{a.quick[1].Text, a.quick[2].Text, a.quick[0].Text, a.quick[3].Text}
	f, _ := tt.Find("发送：" + a.quick[0].Text)
	g, _ := tt.Find("发送：" + a.quick[2].Text)
	dragTo(tt, f.X+f.W/2, f.Y+f.H/2, g.X+g.W/2, g.Y+g.H/2)
	if got := quickTexts(a); !slices.Equal(got, want) {
		t.Fatalf("第 1 个拖到第 3 格后 %v，应为 %v", got, want)
	}
	if len(a.store.Settings().QuickOrder) != 4 {
		t.Fatalf("顺序应存进设置 %v", a.store.Settings().QuickOrder)
	}
}

// 列表里的卡拖进常用区 = 设为常用（仍在原分组）；常用方块拖到分组头 = 取消常用并移入该组。
func TestQuickDragInAndOut(t *testing.T) {
	a, tt, sec := quickTestApp(t, 2)
	f, ok := tt.Find("刚刚") // 第一行就是最新的「普通卡」；抓头行空白处（正文是拖出源）
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
	if !tt.HasText("放到哪个分组") {
		t.Fatal("拖起应出坞", tt.Texts())
	}
	if _, ok := tt.Find("设为常用"); !ok {
		t.Fatal("坞里应有「常用」格")
	}
	g, ok := tt.Find("发送：" + a.quick[0].Text) // 常用区还露着：坞出来后它整体下移，仍在坞下面
	d, _ := tt.Find("设为常用")
	if !ok || g.Y < d.Y+d.H {
		t.Fatalf("常用区不应被坞盖住 %v %v", g, d)
	}
	tt.Move(g.X+g.W/2, g.Y+g.H/2)
	tt.Frame()
	tt.Frame()
	tt.Release(g.X+g.W/2, g.Y+g.H/2)
	tt.Frame()
	tt.Frame()
	if got := quickTexts(a); !slices.Contains(got, "普通卡") || len(got) != 3 {
		t.Fatalf("拖进常用区应设为常用 %v", got)
	}
	if n := a.quick[slices.Index(quickTexts(a), "普通卡")]; n.Section != sec {
		t.Fatalf("卡应仍在原分组 %q", n.Section)
	}
	tt.Advance(time.Second)
	tt.Frame()
	tt.Advance(time.Second)
	tt.Frame()
	f, _ = tt.Find("发送：常用 1")
	h, ok := tt.Find("收件箱")
	if !ok {
		t.Fatal(tt.Texts())
	}
	dragTo(tt, f.X+f.W/2, f.Y+f.H/2, h.X+h.W/2, h.Y+h.H/2)
	if got := quickTexts(a); slices.Contains(got, "常用 1") {
		t.Fatalf("拖到分组头应取消常用 %v", got)
	}
	moved := slices.ContainsFunc(a.store.Section(store.SectionInbox), func(n store.Note) bool { return n.Text == "常用 1" && !n.Kept })
	if !moved {
		t.Fatal("应移入收件箱")
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

// 减弱动态效果总开关：设置同步到 reduceMotionPref（各窗口每帧据此关掉过渡），设置页有这一行；关掉恢复。
func TestReduceMotionSwitch(t *testing.T) {
	a, tt := testApp(t, "甲卡", "乙卡")
	t.Cleanup(func() { reduceMotionPref = false })
	a.patchSettings(func(x *store.Settings) { x.ReduceMotion = true })
	if !reduceMotionPref {
		t.Fatal("设置应同步到总开关")
	}
	for range 3 { // 开着时照常出帧
		tt.Frame()
	}
	if !tt.HasText("甲卡") {
		t.Fatal(tt.Texts())
	}
	// 展开分组：开着时第一帧就是最终画面（没有中间帧）；关着时第一帧还在动
	settled := func(on bool) bool {
		a.patchSettings(func(x *store.Settings) { x.ReduceMotion = on })
		for _, v := range []bool{true, false} {
			for _, sec := range a.store.Sections() {
				if sec.ID == store.SectionInbox {
					sec.Collapsed = v
					_ = a.store.UpdateSection(sec)
				}
			}
			tt.Frame()
			if v {
				tt.Advance(time.Second)
				tt.Frame()
			}
		}
		first := tt.Image()
		tt.Advance(time.Second)
		tt.Frame()
		tt.Frame()
		return reflect.DeepEqual(first, tt.Image())
	}
	if settled(false) {
		t.Fatal("开关关着：展开第一帧应还在过渡中")
	}
	if !settled(true) {
		t.Fatal("开关开着：展开应直接到位")
	}
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 960)
	set.Frame()
	if !set.HasText("减弱动态效果") {
		t.Fatalf("设置页应有总开关 %v", set.Texts())
	}
	a.patchSettings(func(x *store.Settings) { x.ReduceMotion = false })
	if reduceMotionPref {
		t.Fatal("关掉应恢复")
	}
}

// 常用方块双击 / 连点只发一次；隔开再点、或点另一个照常发。
func TestQuickDoubleClickSendsOnce(t *testing.T) {
	a, tt, _ := quickTestApp(t, 2)
	t0 := time.Now()
	id, other := a.quick[0].ID, a.quick[1].ID
	for i, c := range []struct {
		id   string
		at   time.Duration
		want bool
	}{{id, 0, true}, {id, 200 * time.Millisecond, false}, {id, 500 * time.Millisecond, false}, {other, 600 * time.Millisecond, true}, {id, 700 * time.Millisecond, true}, {id, 2 * time.Second, true}} {
		if got := a.quickClickOnce(c.id, t0.Add(c.at)); got != c.want {
			t.Fatalf("第 %d 次点击：发送=%v，应为 %v", i, got, c.want)
		}
	}
	// 走真实点击：紧挨着点两下，只记一次发送时刻的起点
	a.quickSentID = ""
	f, _ := tt.Find("发送：" + a.quick[0].Text)
	tt.ClickAt(f.X+f.W/2, f.Y+f.H/2)
	tt.Frame()
	if a.quickSentID != id {
		t.Fatal("点一下应发送")
	}
	if a.quickClickOnce(id, a.quickSentAt.Add(100*time.Millisecond)) {
		t.Fatal("紧跟的第二下不应再发")
	}
}

// 按下后手滑几个点（框架判成拖动）又在原格松手：按点击发送；拖到别的格子再拖回来松手不发。
func TestQuickSloppyClickSends(t *testing.T) {
	a, tt, _ := quickTestApp(t, 4)
	id := a.quick[0].ID
	f, _ := tt.Find("发送：" + a.quick[0].Text)
	g, _ := tt.Find("发送：" + a.quick[1].Text)
	cx, cy := f.X+f.W/2, f.Y+f.H/2
	before := quickTexts(a)
	dragTo(tt, cx, cy, cx+7, cy+5)
	if a.quickSentID != id {
		t.Fatal("原格内手滑松手应按点击发送")
	}
	if got := quickTexts(a); !slices.Equal(got, before) {
		t.Fatalf("顺序不应变 %v", got)
	}
	a.quickSentID = ""
	tt.Move(cx, cy)
	tt.Press(cx, cy)
	for _, x := range []float32{cx + 10, g.X + g.W/2, g.X + g.W/2, cx + 10, cx} {
		tt.Move(x, cy)
		tt.Frame()
	}
	tt.Release(cx, cy)
	tt.Frame()
	tt.Frame()
	if a.quickSentID != "" {
		t.Fatal("拖到别的格子又拖回原格松手不应发送")
	}
}
