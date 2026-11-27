package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// near：两个坐标相差不超过 tol。
func near(a, b, tol float32) bool { return a-b <= tol && b-a <= tol }

// same：两个宽度相等（只容浮点误差）。文字盒比自然宽度窄零点几个点就会出省略号，所以「没被截」要按相等核对。
func same(a, b float32) bool { return near(a, b, 0.005) }

// 极简标题栏：一行，「标题 · 来源 · 创建时间」落在窗口正中；修改时间、字数不再占标题栏。
func TestDetailHeaderCentered(t *testing.T) {
	a, _ := testApp(t, "一段正文")
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	src, ok1 := dt.Find("Safari")
	when, ok2 := dt.Find(" · 刚刚")
	if !ok1 || !ok2 || !near((src.X+when.X+when.W)/2, 280, 1) || !near(src.X+src.W, when.X, 0.5) {
		t.Fatalf("来源 · 时间应连成一段落在窗口正中 %v %v %v", src, when, dt.Texts())
	}
	if dt.HasText("创建 ") || dt.HasText("来自 ") || dt.HasText(" 字") {
		t.Fatalf("创建 / 字数应只在悬停提示里 %v", dt.Texts())
	}
	body, _ := dt.Find("一段正文")
	if body.Y < 44 || body.Y > 56 {
		t.Fatalf("没有标签行时正文应紧接标题栏 y=%v", body.Y)
	}

	_ = a.store.SetTitle(n.ID, "周会纪要")
	dt.Frame()
	title, ok1 := dt.Find("周会纪要")
	src, ok2 = dt.Find(" · Safari")
	when, _ = dt.Find(" · 刚刚")
	if !ok1 || !ok2 || !near((title.X+when.X+when.W)/2, 280, 1) || !near(title.X+title.W, src.X, 0.5) || !near(src.X+src.W, when.X, 0.5) {
		t.Fatalf("标题 · 来源 · 时间应连成一段并居中 %v %v %v", title, src, when)
	}

	a.enterDetailEdit(n) // 编辑态：标题在正文上方的输入框里改，标题栏只留「编辑中 来源 · 时间」
	dt.Frame()
	if _, sep := dt.Find(" · Safari"); sep || !dt.HasText("编辑中") {
		t.Fatalf("编辑态标题栏不该再带标题 %v", dt.Texts())
	}
	if _, ok := dt.Find("Safari"); !ok {
		t.Fatalf("编辑态标题栏应仍有来源 %v", dt.Texts())
	}
}

// 标题栏放不下时的让位顺序：先截标题，再截来源，时间不截。宽度按「一个点都不能少」核对——
// 文字盒窄零点几个点就会出省略号，宽松的容差看不出来。
func TestDetailHeaderTruncationOrder(t *testing.T) {
	a, _ := testApp(t, "一段正文")
	n := a.store.Notes()[0]
	_ = a.store.SetTitle(n.ID, "周会纪要")
	dt := detailTester(t, a, n)
	src, _ := dt.Find(" · Safari")
	when, _ := dt.Find(" · 刚刚")
	srcW, whenW := src.W, when.W                  // 放得下时的宽度
	const lo, hi = 12 + 54 + 8, 560 - 12 - 54 - 8 // 中间那格的左右边界（两侧各一格 54：「#」钮 + 固定钮）

	long := strings.Repeat("关于详情窗重设计的评审意见", 6)
	_ = a.store.SetTitle(n.ID, long)
	dt.Frame()
	title, _ := dt.Find(long)
	src, _ = dt.Find(" · Safari")
	when, _ = dt.Find(" · 刚刚")
	if !same(src.W, srcW) || !same(when.W, whenW) {
		t.Fatalf("标题过长应只截标题，来源与时间一个点都不能少 src=%v（原 %v） when=%v（原 %v）", src.W, srcW, when.W, whenW)
	}
	if title.X < lo-0.5 || !near(when.X+when.W, hi, 0.5) || !near(title.X+title.W, src.X, 0.5) || !near(src.X+src.W, when.X, 0.5) {
		t.Fatalf("截断后应正好铺满中间那格、不压两端 title=%v src=%v when=%v", title, src, when)
	}

	// 来源也很长：标题与来源各占一半，时间照旧完整
	x, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "另一段", SourceApp: "Visual Studio Code - Insiders (Extension Development Host)"})
	_ = a.store.SetTitle(x.ID, long)
	a.detail = detailState{id: x.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	dt.Frame()
	title, _ = dt.Find(long)
	src, _ = dt.Find(" · Visual Studio Code - Insiders (Extension Development Host)")
	when, _ = dt.Find(" · 刚刚")
	if !same(when.W, whenW) || !near(title.W, src.W, 0.5) || title.X < lo-0.5 || !near(when.X+when.W, hi, 0.5) {
		t.Fatalf("标题、来源都很长时应各占一半、时间完整 title=%v src=%v when=%v", title, src, when)
	}

	// 标题短、来源长：标题留全，只截来源
	_ = a.store.SetTitle(x.ID, "周会纪要")
	dt.SetSize(1200, 540)
	dt.Frame()
	title, _ = dt.Find("周会纪要")
	titleW := title.W
	dt.SetSize(380, 540)
	dt.Frame()
	title, _ = dt.Find("周会纪要")
	src, _ = dt.Find(" · Visual Studio Code - Insiders (Extension Development Host)")
	when, _ = dt.Find(" · 刚刚")
	if !same(title.W, titleW) || !same(when.W, whenW) || title.X < lo-0.5 || !near(when.X+when.W, 380-lo, 0.5) || !near(title.X+title.W, src.X, 0.5) {
		t.Fatalf("标题短时应留全、只截来源 title=%v（原宽 %v） src=%v when=%v", title, titleW, src, when)
	}

	// 没有标题：来源放不下就截来源，时间仍完整
	_ = a.store.SetTitle(x.ID, "")
	dt.Frame()
	src, _ = dt.Find("Visual Studio Code - Insiders (Extension Development Host)")
	when, _ = dt.Find(" · 刚刚")
	if !same(when.W, whenW) || src.X < lo-0.5 || !near(when.X+when.W, 380-lo, 0.5) || !near(src.X+src.W, when.X, 0.5) {
		t.Fatalf("没有标题时应截来源、时间完整 src=%v when=%v", src, when)
	}
}

// 标签一行放不下就折行：胶囊不压窄、字不折成两行；正文、查找栏跟着多出的行高下移，标签少了再收回。
func TestDetailTagsWrap(t *testing.T) {
	a, _ := testApp(t, "一段正文")
	n := a.store.Notes()[0]
	tags := []string{"设计评审", "详情窗", "v1.0.4", "待确认", "原生版", "mygo", "交互", "排期"}
	_ = a.store.SetTags(n.ID, tags)
	dt := detailTester(t, a, n)
	a.detail.tagsOpen = true
	settle := func() {
		dt.Frame()
		dt.Frame()
		dt.Advance(300 * time.Millisecond)
		dt.Frame()
	}
	dt.SetSize(1400, 540) // 够宽：全在一行，记下每枚的自然宽度
	settle()
	wide := map[string]float32{}
	for _, tag := range tags {
		r, _ := dt.Find("#" + tag)
		wide[tag] = r.W
	}
	if a.detail.tagsH != 28 {
		t.Fatalf("一行放得下时标签行应是 28 高 %v", a.detail.tagsH)
	}
	dt.SetSize(560, 540)
	settle()
	rows := map[float32]bool{}
	for _, tag := range tags {
		r, ok := dt.Find("#" + tag)
		if !ok || r.H > 16.5 || !same(r.W, wide[tag]) || r.X < 12 || r.X+r.W > 560-12 {
			t.Fatalf("标签 %q 应单行、不被压窄、不出窗 %v（自然宽 %v）", tag, r, wide[tag])
		}
		rows[r.Y] = true
	}
	last, _ := dt.Find("#排期")
	body, _ := dt.Find("一段正文")
	if len(rows) < 2 || a.detail.tagsH <= 28 || body.Y < last.Y+last.H+4 {
		t.Fatalf("560 宽放不下 8 个标签应折行，正文让到最后一行下面 rows=%d tagsH=%v body=%v last=%v", len(rows), a.detail.tagsH, body, last)
	}
	a.openDetailFind()
	settle()
	bar, _ := dt.Find("文内查找")
	body, _ = dt.Find("一段正文")
	if extra := a.detail.tagsH - 28; !near(bar.Y, 44+extra, 0.5) || body.Y < bar.Y+bar.H {
		t.Fatalf("查找栏应随折行下移、正文在它下面 bar=%v body=%v tagsH=%v", bar, body, a.detail.tagsH)
	}
	a.closeDetailFind()
	_ = a.store.SetTags(n.ID, tags[:2])
	settle()
	if body, _ = dt.Find("一段正文"); a.detail.tagsH != 28 || body.Y < 64 || body.Y > 76 {
		t.Fatalf("标签少回一行后正文应收回 tagsH=%v body=%v", a.detail.tagsH, body)
	}
}

// 标签行默认收起：没有标签时是「#」钮，点开直接进输入；有标签时是「#N」，点它展开 / 收起，收起时没回车的草稿也存下。
func TestDetailTagChipTogglesRow(t *testing.T) {
	a, _ := testApp(t, "一段正文")
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	if dt.HasText("＋ 标签") {
		t.Fatalf("标签行应默认收起 %v", dt.Texts())
	}
	if err := dt.Click("添加标签"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	if !a.detail.tagsOpen || !a.detail.tagOn {
		t.Fatalf("没有标签时点「#」应展开并进输入 open=%v on=%v", a.detail.tagsOpen, a.detail.tagOn)
	}
	dt.Key(0, ui.KeyEscape) // 什么都没加就退出输入：空的标签行自己收起，不留一行「＋ 标签」
	dt.Frame()
	dt.Advance(300 * time.Millisecond)
	dt.Frame()
	if body, _ := dt.Find("一段正文"); a.detail.tagsOpen || dt.HasText("＋ 标签") || body.Y > 56 {
		t.Fatalf("没有标签又不在输入时标签行应收起 open=%v body=%v %v", a.detail.tagsOpen, body, dt.Texts())
	}
	if err := dt.Click("添加标签"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	dt.Type("甲")
	dt.Key(0, ui.KeyEnter)
	dt.Type("乙")
	dt.Key(0, ui.KeyEnter)
	dt.Frame()
	if !dt.HasText("#2") || !dt.HasText("#甲") || !dt.HasText("#乙") {
		t.Fatalf("应显示「#2」与展开的标签 %v", dt.Texts())
	}
	dt.Advance(300 * time.Millisecond)
	dt.Frame()
	if body, _ := dt.Find("一段正文"); body.Y < 66 {
		t.Fatalf("标签行展开后正文应让到它下面 y=%v", body.Y)
	}
	dt.Type("丙") // 没回车就点「#2」收起：草稿照常存成标签
	dt.Frame()
	if err := dt.Click("标签"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	cur, _ := a.store.Note(n.ID)
	if !slices.Equal(cur.Tags, []string{"甲", "乙", "丙"}) || a.detail.tagsOpen || a.detail.tagOn || dt.HasText("#甲") || !dt.HasText("#3") {
		t.Fatalf("收起应保存草稿并只留「#3」 tags=%v open=%v on=%v %v", cur.Tags, a.detail.tagsOpen, a.detail.tagOn, dt.Texts())
	}
	if err := dt.Click("标签"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	if !a.detail.tagsOpen || a.detail.tagOn || !dt.HasText("#丙") || !dt.HasText("＋ 标签") {
		t.Fatalf("有标签时点「#3」只展开、不进输入 open=%v on=%v %v", a.detail.tagsOpen, a.detail.tagOn, dt.Texts())
	}
}

// 主题自绘标题栏（Platinum）没有「#N」钮：标签行照旧常驻，正文位置不变。
func TestDetailTagsRowPinnedForThemedHeader(t *testing.T) {
	a, _ := testApp(t, "一段正文")
	st := a.store.Settings()
	st.ColorScheme = "platinum"
	_ = a.store.SetSettings(st)
	curScheme = "platinum"
	defer func() { curScheme = "default" }()
	dt := detailTester(t, a, a.store.Notes()[0])
	if _, ok := dt.Find("添加标签"); ok || !dt.HasText("＋ 标签") {
		t.Fatalf("Platinum 标签行应常驻、没有「#」钮 %v", dt.Texts())
	}
	if body, _ := dt.Find("一段正文"); body.Y < 64 {
		t.Fatalf("Platinum 正文位置不应上移 y=%v", body.Y)
	}
	// 常驻的标签行同样折行，正文让到最后一行下面
	_ = a.store.SetTags(a.store.Notes()[0].ID, []string{"设计评审", "详情窗", "v1.0.4", "待确认", "原生版", "mygo", "交互", "排期"})
	dt.Frame()
	dt.Frame()
	dt.Advance(300 * time.Millisecond)
	dt.Frame()
	last, _ := dt.Find("#排期")
	if body, _ := dt.Find("一段正文"); a.detail.tagsH <= 28 || last.H > 16.5 || body.Y < last.Y+last.H+4 {
		t.Fatalf("Platinum 标签多了也应折行并让出正文 tagsH=%v last=%v body=%v", a.detail.tagsH, last, body)
	}
}

// 剪贴卡的「存入笔记分组」还在标题栏右端；只读合并预览没有标签钮。
func TestDetailHeaderKeepsSaveAndHidesChipForPreview(t *testing.T) {
	a, _ := testApp(t)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴来的一段", SourceApp: "Safari"})
	dt := detailTester(t, a, n)
	save, ok1 := dt.Find("存入笔记分组")
	chip, ok2 := dt.Find("添加标签")
	if !ok1 || !ok2 || save.X+save.W > chip.X {
		t.Fatalf("剪贴卡标题栏应有「存入笔记分组」且排在标签钮左边 %v %v %v", save, chip, dt.Texts())
	}
	v := n
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}, virt: &v, subtitle: "2 张 · 发送记录不保存正文"}
	dt.Frame()
	if _, ok := dt.Find("添加标签"); ok || !dt.HasText("2 张 · 发送记录不保存正文") || dt.HasText("这条内容还能") {
		t.Fatalf("只读预览不该有标签钮 / 能力卡，副标题居中显示 %v", dt.Texts())
	}
}

func capsApp(t *testing.T, w, h int, text string) (*app, store.Note, *ui.Tester) {
	t.Helper()
	a, _ := testApp(t, text)
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	dt := ui.NewTester(a.detailView, w, h)
	dt.Frame()
	dt.Frame() // 能力卡要等量到正文高度的下一帧
	return a, n, dt
}

// 能力卡：短内容时列在正文下方、不压操作坞；内容一屏放不下、编辑 / 选词 / 查找、隐身时不出现；化名关着不提化名。
func TestDetailCapsShownOnlyWhenRoomy(t *testing.T) {
	a, n, dt := capsApp(t, 560, 540, "会议纪要：周五前完成对比报告。")
	for _, s := range []string{"这条内容还能", "不再提示", "划词即改", "选词发送", "一稿多投", "化名保护"} {
		if !dt.HasText(s) {
			t.Fatalf("短内容应列出能力卡，缺 %q %v", s, dt.Texts())
		}
	}
	last, _ := dt.Find("化名保护")
	first, _ := dt.Find("划词即改")
	second, _ := dt.Find("选词发送")
	dock, _ := dt.Find("复制")
	body, _ := dt.Find("会议纪要：周五前完成对比报告。")
	if last.Y+last.H > dock.Y || first.Y < body.Y+body.H || !near(first.Y, second.Y, 0.5) || second.X <= first.X+first.W {
		t.Fatalf("能力卡应两列排在正文与操作坞之间 first=%v second=%v last=%v dock=%v", first, second, last, dock)
	}

	a.enterDetailEdit(n)
	dt.Frame()
	if dt.HasText("这条内容还能") {
		t.Fatal("编辑态不该有能力卡")
	}
	a.commitDetailEdit(n)
	a.openDetailFind()
	dt.Frame()
	if dt.HasText("这条内容还能") {
		t.Fatal("查找中不该有能力卡")
	}
	a.closeDetailFind()
	dt.Frame()
	if !dt.HasText("这条内容还能") {
		t.Fatalf("回到阅读态应恢复 %v", dt.Texts())
	}

	a.patchSettings(func(s *store.Settings) { s.AliasOff = true })
	dt.Frame()
	if dt.HasText("化名保护") || !dt.HasText("一稿多投") {
		t.Fatalf("化名关着时不提化名 %v", dt.Texts())
	}
	first, _ = dt.Find("划词即改")
	if odd, _ := dt.Find("一稿多投"); !near(odd.W, first.W, 0.5) || !near(odd.X, first.X, 0.5) {
		t.Fatalf("剩三张时落单的那张应与上面的同宽 %v %v", odd, first)
	}
	a.patchSettings(func(s *store.Settings) { s.AliasOff, s.Stealth = false, true })
	dt.Frame()
	if dt.HasText("这条内容还能") {
		t.Fatal("隐身模式不该有能力卡")
	}

	_, _, long := capsApp(t, 560, 540, strings.Repeat("很长的一行内容。\n\n", 40))
	if long.HasText("这条内容还能") {
		t.Fatal("内容超过一屏不该有能力卡")
	}
	// 窄窗（最小宽度）单列；窗口矮到四行放不下就整块不画，不出现半截
	_, _, narrow := capsApp(t, 380, 540, "短")
	c1, ok1 := narrow.Find("划词即改")
	c2, ok2 := narrow.Find("选词发送")
	if !ok1 || !ok2 || !near(c1.X, c2.X, 0.5) || c2.Y < c1.Y+c1.H {
		t.Fatalf("窄窗应单列 %v %v", c1, c2)
	}
	if _, _, low := capsApp(t, 380, 300, "短"); low.HasText("这条内容还能") {
		t.Fatal("放不下四行时不该画能力卡")
	}
}

// 能力卡点击：选词直接进选词模式，一稿多投直接开选目标浮层；「不再提示」写进设置、可撤销。
func TestDetailCapsActions(t *testing.T) {
	runningTargets = func() []macos.AppInfo {
		return []macos.AppInfo{{PID: 7, Name: "Notes", BundleID: "com.apple.Notes"}, {PID: 8, Name: "Claude", BundleID: "com.anthropic.claude"}}
	}
	defer func() { runningTargets = macos.RegularApps }()
	a, _, dt := capsApp(t, 560, 540, "会议纪要：周五前完成对比报告。")
	if err := dt.Click("选词发送"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	if !a.detail.pick || dt.HasText("这条内容还能") {
		t.Fatalf("点「选词发送」应进选词模式（能力卡让位） pick=%v", a.detail.pick)
	}
	a.detail.pick = false
	dt.Frame()
	dt.Frame()
	if err := dt.Click("一稿多投"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	if !a.detail.fanOpen || !dt.HasText("同时发到") {
		t.Fatalf("点「一稿多投」应打开选目标浮层 %v", dt.Texts())
	}
	a.detail.fanOpen = false
	dt.Frame()
	if err := dt.Click("划词即改"); err != nil {
		t.Fatal(err)
	}
	if a.hudKind != "info" || a.hudText != "在正文里划选一段文字" {
		t.Fatalf("要先划选的卡应给气泡提示 %s %q", a.hudKind, a.hudText)
	}

	if err := dt.Click("不再提示"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	if !a.store.Settings().DetailTipsOff || dt.HasText("这条内容还能") || a.hudUndo == nil {
		t.Fatalf("「不再提示」应写进设置并可撤销 off=%v", a.store.Settings().DetailTipsOff)
	}
	a.hudUndo()
	dt.Frame()
	if a.store.Settings().DetailTipsOff || !dt.HasText("这条内容还能") {
		t.Fatalf("撤销应恢复能力卡 %v", dt.Texts())
	}
}

// 设置 → 外观 →「详情窗能力提示」开关与「不再提示」是同一个设置。
func TestDetailTipsSettingRow(t *testing.T) {
	a, _ := testApp(t)
	set := ui.NewTester(a.settingsView, 1040, 2400)
	set.Frame()
	if !set.HasText("详情窗能力提示") {
		t.Fatalf("外观页应有「详情窗能力提示」 %v", set.Texts())
	}
}

// 浅 / 深色截图目检（TOSKR_SHOT_DIR 落盘）：真实宽度 × 最坏数据 × 状态组合。
func TestDetailRedesignShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("设 TOSKR_SHOT_DIR 才出图")
	}
	runningTargets = func() []macos.AppInfo {
		return []macos.AppInfo{{PID: 7, Name: "Cursor", BundleID: "a"}, {PID: 8, Name: "Claude", BundleID: "b"}, {PID: 9, Name: "ChatGPT", BundleID: "c"}}
	}
	defer func() { runningTargets = macos.RegularApps }()
	short := "会议纪要：周五前完成 mygo 原生版对比报告，附内存与启动耗时。\n\n1. 主面板、任务、剪贴、订阅、秘文逐屏 1:1 对照\n2. 设置窗外壳与控件\n3. HUD 气泡与详情窗"
	long := "## 一、结论\n\n详情窗当前的信息层次不足：来源、时间、字数挤在同一行 10pt 灰字里，新用户看不出这扇窗能做什么。本轮先定结构，再定视觉。\n\n## 二、待办\n\n1. 头部拆成「身份」与「元信息」两层，标题缺省时取首行\n2. 底部坞改为主操作全宽，次操作用图标格表达\n3. 划词工具条保留现有能力，补充「加入化名词典」的说明\n4. 短内容时在正文下方露出能力卡，超过一屏自动隐藏\n\n## 三、风险\n\n- 坞变高后长文可读区域减少约 46pt\n- 图标格在英文界面下标签可能过长，需要实测\n- 首次引导只出现一次，需要可在设置里重新打开\n\n以上意见请在周四前回复；确认后进入原生实现与浅深色截图走查。"
	type scene struct {
		name   string
		w, h   int
		text   string
		setup  func(a *app, n store.Note)
		en     bool
		light  bool    // 只出浅色（Platinum 固定浅色）
		scroll float32 // 出图前先把正文滚下去这么多
	}
	worst := func(a *app, n store.Note) {
		_ = a.store.SetTitle(n.ID, "关于 Toskr 1.0.4 详情窗重设计的评审意见与后续排期（含设计、研发、测试三方结论）")
		_ = a.store.SetTags(n.ID, []string{"设计评审", "详情窗", "v1.0.4", "待确认", "原生版", "mygo", "交互", "排期"})
		a.target = macos.FrontApp{PID: 42, Name: "Visual Studio Code - Insiders"}
	}
	scenes := []scene{
		{name: "short-560", w: 560, h: 540, text: short},
		{name: "short-640x680", w: 640, h: 680, text: short},
		{name: "short-480", w: 480, h: 540, text: short},
		{name: "short-380", w: 380, h: 540, text: short},
		{name: "short-en-560", w: 560, h: 540, text: short, en: true},
		{name: "short-en-380", w: 380, h: 540, text: short, en: true},
		{name: "short-noalias", w: 560, h: 540, text: short, setup: func(a *app, n store.Note) {
			a.patchSettings(func(s *store.Settings) { s.AliasOff = true })
		}},
		{name: "short-find", w: 560, h: 540, text: short, setup: func(a *app, n store.Note) {
			a.openDetailFind()
			a.detail.findQuery = "窗"
		}},
		{name: "short-fanout", w: 560, h: 540, text: short, setup: func(a *app, n store.Note) { a.detail.fanOpen = true }},
		{name: "short-edit", w: 560, h: 540, text: short, setup: func(a *app, n store.Note) { a.enterDetailEdit(n) }},
		{name: "worst-560", w: 560, h: 540, text: long, setup: worst},
		{name: "worst-380", w: 380, h: 540, text: long, setup: worst},
		{name: "worst-tags-open", w: 560, h: 540, text: long, setup: func(a *app, n store.Note) {
			worst(a, n)
			a.detail.tagsOpen = true
		}},
		{name: "worst-short-tags-open", w: 560, h: 540, text: short, setup: func(a *app, n store.Note) {
			worst(a, n)
			a.detail.tagsOpen = true
		}},
		{name: "clip-380", w: 380, h: 540, text: short, setup: func(a *app, n store.Note) {
			x, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: short, SourceApp: "Visual Studio Code - Insiders"})
			_ = a.store.SetTags(x.ID, []string{"周报", "走查"})
			a.detail.id = x.ID
		}},
		{name: "worst-380-tags-open", w: 380, h: 540, text: long, setup: func(a *app, n store.Note) {
			worst(a, n)
			a.detail.tagsOpen = true
		}},
		{name: "worst-tags-find", w: 560, h: 540, text: long, setup: func(a *app, n store.Note) {
			worst(a, n)
			a.detail.tagsOpen = true
			a.openDetailFind()
			a.detail.findQuery = "坞"
		}},
		{name: "worst-tags-input", w: 560, h: 540, text: long, setup: func(a *app, n store.Note) {
			worst(a, n)
			_ = a.store.SetTags(n.ID, []string{"设计评审", "详情窗", "v1.0.4", "待确认", "原生版", "mygo", "交互"})
			a.detail.tagsOpen, a.detail.tagOn = true, true
		}},
		{name: "longsrc-title-380", w: 380, h: 540, text: short, setup: func(a *app, n store.Note) {
			x, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: short, SourceApp: "Visual Studio Code - Insiders"})
			_ = a.store.SetTitle(x.ID, "周会纪要与对比报告的排期")
			_ = a.store.SetTags(x.ID, []string{"周报", "走查"})
			a.detail.id = x.ID
		}},
		{name: "tags-extreme-380", w: 380, h: 540, text: short, setup: func(a *app, n store.Note) {
			var tags []string
			for i := range store.TagMaxCount { // 8 个、每个顶到 24 字的上限
				tags = append(tags, strings.Repeat("标签很长", 6)[:3*(23)]+itoa(i))
			}
			_ = a.store.SetTags(n.ID, tags)
			a.detail.tagsOpen = true
		}},
		{name: "worst-scrolled", w: 560, h: 540, text: long + "\n\n" + long + "\n\n" + long, scroll: 160, setup: func(a *app, n store.Note) {
			worst(a, n)
			a.detail.tagsOpen = true
		}},
		{name: "platinum-worst", w: 560, h: 540, text: long, light: true, setup: func(a *app, n store.Note) {
			worst(a, n)
			a.patchSettings(func(s *store.Settings) { s.ColorScheme = "platinum" })
			curScheme = "platinum"
		}},
	}
	defer func() { curScheme = "default" }()
	for _, sc := range scenes {
		a, _ := testApp(t, sc.text)
		a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
		n := a.store.Notes()[0]
		a.detailText = n.Text
		a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}, title: n.Title}
		if sc.en {
			setLanguage("en", nil)
		}
		if sc.setup != nil {
			sc.setup(a, n)
		}
		dt := ui.NewTester(a.detailView, sc.w, sc.h)
		for _, dark := range []bool{false, true} {
			if dark && sc.light {
				continue
			}
			dt.SetDark(dark)
			dt.Frame()
			dt.Frame() // 标签行高、正文高度都是量上一帧的：多画两帧到位
			dt.Frame()
			if sc.scroll > 0 {
				dt.Scroll(float32(sc.w)/2, float32(sc.h)/2, 0, sc.scroll)
			}
			dt.Advance(400 * time.Millisecond)
			dt.Frame()
			dt.Frame()
			save(t, filepath.Join(dir, sc.name+"-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), dt.Image())
		}
		if sc.en {
			setLanguage("zh", nil)
		}
		curScheme = "default"
	}
}
