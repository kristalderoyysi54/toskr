package main

import (
	"fmt"
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

// 让位顺序：键位 → 目标名截到下限 → 次操作按保留级别从小到大收进「⋯」→ 轮到进行中的项之前，发送钮先缩成「发送」。
func TestDockFitOrder(t *testing.T) {
	ws := []float32{48, 48, 64, 48, 48} // 选词 原文 处理 复制 编辑
	keep := []int{keepPick, keepRaw, keepProc, keepCopy, keepEdit}
	send := [4]float32{191, 167, 150, 106}
	// 次操作 256 + 间距 5×4 + 发送钮左外边距 4 = 280，再加发送钮
	for _, tc := range []struct {
		room float32
		hide []bool
		mode int
	}{
		{471, []bool{false, false, false, false, false}, sendHint},
		{470, []bool{false, false, false, false, false}, sendFull},
		{446, []bool{false, false, false, false, false}, sendFloor},
		{429, []bool{false, true, false, false, false}, sendFloor}, // 430 才放得下全部：先收「原文」
		{348, []bool{true, true, false, false, true}, sendFloor},   // 最窄 380 的窗：留「处理」「复制」
		{200, []bool{true, true, true, true, true}, sendFloor},
		{150, []bool{true, true, true, true, true}, sendShort}, // 全收了还不够：只留「发送」
	} {
		hide, mode := dockFit(tc.room, ws, keep, send)
		if !slices.Equal(hide, tc.hide) || mode != tc.mode {
			t.Fatalf("room=%v 应为 %v / %d，得到 %v / %d", tc.room, tc.hide, tc.mode, hide, mode)
		}
	}
	// 进行中的项（取消 AI、开着的选词）最后才收，而且先让发送钮缩成「发送」
	ws, keep = []float32{100, 118, 48}, []int{keepPickOn, keepBusy, keepCopy}
	if hide, mode := dockFit(370, ws, keep, send); !slices.Equal(hide, []bool{false, false, true}) || mode != sendShort {
		t.Fatalf("应先收「复制」、再把发送钮缩成「发送」，得到 %v / %d", hide, mode)
	}
	// 「取消 AI」也收起后腾出了位置：目标名放得回来就放回来（290 起），再窄才又只留「发送」
	if hide, mode := dockFit(290, ws, keep, send); !slices.Equal(hide, []bool{false, true, true}) || mode != sendFloor {
		t.Fatalf("收掉「取消 AI」后目标名应放回来，得到 %v / %d", hide, mode)
	}
	if hide, mode := dockFit(250, ws, keep, send); !slices.Equal(hide, []bool{false, true, true}) || mode != sendShort {
		t.Fatalf("仍不够时才收「取消 AI」，开着的选词留到最后，得到 %v / %d", hide, mode)
	}
	// 链接卡：「打开链接」和「复制」留到最后（「处理」「编辑」「选词」先收）
	ws, keep = []float32{48, 72, 64, 48, 48}, []int{keepPick, keepLink, keepProc, keepCopy, keepEdit}
	if hide, mode := dockFit(348, ws, keep, send); !slices.Equal(hide, []bool{true, false, true, false, true}) || mode != sendFloor {
		t.Fatalf("链接卡最窄时应留「打开链接」「复制」，得到 %v / %d", hide, mode)
	}
}

type dockCase struct {
	name  string
	want  []string // 这个状态下该有的次操作（中文键，按坞上的顺序）
	setup func(a *app) store.Note
}

const dockMD = "## 一、结论\n\n- 甲项\n- 乙项\n\n正文一段，不含坞上的字样。"

func dockCases() []dockCase {
	first := func(a *app) store.Note { return a.store.Notes()[0] }
	return []dockCase{
		{"阅读", []string{"选词", "原文", "处理", "复制", "编辑"}, first},
		{"选词中", []string{"选词", "处理", "复制", "编辑"}, func(a *app) store.Note {
			a.detail.pick = true
			return first(a)
		}},
		{"AI 进行中", []string{"选词", "原文", "取消 AI 请求", "处理", "复制", "编辑"}, func(a *app) store.Note {
			n := first(a)
			a.aiBusy, a.aiCancel = n.ID, func() {}
			return n
		}},
		{"AI 进行中 + 选词", []string{"选词", "取消 AI 请求", "处理", "复制", "编辑"}, func(a *app) store.Note {
			n := first(a)
			a.aiBusy, a.aiCancel, a.detail.pick = n.ID, func() {}, true
			return n
		}},
		{"链接卡", []string{"选词", "打开链接", "处理", "复制", "编辑"}, func(a *app) store.Note {
			n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "link", URL: "https://example.com/a", Text: "https://example.com/a", SourceApp: "Safari"})
			return n
		}},
	}
}

// 操作坞在每个窗宽下都完整留在窗内：发送钮的下拉不出窗、按钮互不相压、目标名不低于下限、次操作一个不丢
// （不在坞上就在「⋯」里）。窗口最窄 380；中英文、目标名长短、选词 / AI 进行中 / 链接卡、Platinum 都走一遍。
func TestDetailDockFitsEveryWidth(t *testing.T) {
	defer setLanguage("zh", nil)
	defer func() { curScheme = "default" }()
	for _, scheme := range []string{"default", "platinum"} {
		for _, lang := range []string{"zh", "en"} {
			for _, target := range []string{"", "Cursor", "Visual Studio Code - Insiders"} {
				for _, dc := range dockCases() {
					a, _ := testApp(t, dockMD)
					a.patchSettings(func(s *store.Settings) { s.DetailTipsOff = true }) // 能力卡上也有「发送」「选词」字样，关掉免得量错
					a.detail = detailState{pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
					n := dc.setup(a)
					a.detail.id = n.ID
					if scheme != "default" {
						a.patchSettings(func(s *store.Settings) { s.ColorScheme = scheme })
					}
					curScheme = scheme
					setLanguage(lang, nil)
					where := fmt.Sprintf("%s / %s / 目标 %q / %s", scheme, lang, target, dc.name)

					// 目标名的下限 = 「发送到 」+ 64：用空目标名量出前缀的宽度
					a.target = macos.FrontApp{PID: 42}
					dt := ui.NewTester(a.detailView, 1400, 540)
					dt.Frame()
					prefix, ok := dt.Find(tr("发送到 "))
					if !ok {
						t.Fatalf("%s：量不到「发送到 」的宽度 %v", where, dt.Texts())
					}
					full, short := tr("发送"), ""
					a.target = macos.FrontApp{}
					if target != "" {
						a.target = macos.FrontApp{PID: 42, Name: target}
						full, short = tr("发送到 ")+target, tr("发送")
					}
					dt.Frame()
					wide, ok := dt.Find(full)
					if !ok || !dt.HasText("⌘⏎") {
						t.Fatalf("%s：够宽时应是全称 + 键位 %v", where, dt.Texts())
					}
					if _, more := dt.Find(tr("更多操作")); more {
						t.Fatalf("%s：够宽时不该有「⋯」", where)
					}
					floor := min(wide.W, prefix.W+ddockNameFloor)

					for w := 380; w <= 700; w += 9 {
						dt.SetSize(w, 540)
						dt.Frame()
						at := fmt.Sprintf("%s / 宽 %d", where, w)
						chev, ok := dt.Find(tr("更多发送选项"))
						if !ok || chev.X+chev.W > float32(w)-ddockPadX+0.5 || chev.W < 20 {
							t.Fatalf("%s：发送钮的下拉应完整留在窗内 %v", at, chev)
						}
						// 发送钮上的字：全称不低于下限；缩成「发送」时一个点都不截
						label, isFull := dt.Find(full)
						if !isFull {
							if short == "" {
								t.Fatalf("%s：发送钮没有字 %v", at, dt.Texts())
							}
							sl, ok := dt.Find(short)
							if !ok || sl.X+sl.W > chev.X {
								t.Fatalf("%s：发送钮应退到「%s」 %v %v", at, short, sl, dt.Texts())
							}
							label = sl
						} else if label.W < floor-0.01 {
							t.Fatalf("%s：目标名被截到下限以下 %v < %v", at, label.W, floor)
						}
						// 次操作：在坞上的从左到右互不相压，且都在发送钮左边；不在坞上的必须在「⋯」里
						var menu []string
						moreBtn, hasMore := dt.Find(tr("更多操作"))
						if hasMore {
							if err := dt.Click(tr("更多操作")); err != nil {
								t.Fatalf("%s：%v", at, err)
							}
							menu = dt.Menu()
							dt.CloseMenu()
							dt.Frame()
							if len(menu) == 0 || moreBtn.X+moreBtn.W > label.X {
								t.Fatalf("%s：「⋯」应有菜单且排在发送钮左边 %v %v", at, menu, moreBtn)
							}
						}
						edge := float32(ddockPadX) - 0.5
						var inMenu []string
						for _, zh := range dc.want {
							r, ok := dt.Find(tr(zh))
							switch {
							case ok && (r.X-12 < edge || r.X+r.W > label.X):
								t.Fatalf("%s：「%s」出窗或压住别的按钮 %v（上一个到 %v，发送钮字在 %v）", at, zh, r, edge, label.X)
							case ok:
								edge = r.X + r.W
							case !slices.Contains(menu, tr(zh)):
								t.Fatalf("%s：「%s」既不在坞上也不在「⋯」里 坞=%v 菜单=%v", at, zh, dt.Texts(), menu)
							default:
								inMenu = append(inMenu, tr(zh))
							}
						}
						if !slices.Equal(inMenu, menu) {
							t.Fatalf("%s：「⋯」里应正好是收起的那几项、顺序同坞上 想要 %v 实际 %v", at, inMenu, menu)
						}
						if hasMore && w >= 560 && target != "Visual Studio Code - Insiders" && lang == "zh" && !strings.Contains(dc.name, "AI") {
							t.Fatalf("%s：默认宽度下不该收起任何操作 %v", at, menu)
						}
					}
				}
			}
		}
	}
}

// 最窄的窗（380）：留「处理」「复制」，其余进「⋯」；菜单项点了等于点按钮，「处理」收进去后是子菜单。
func TestDetailDockMoreMenu(t *testing.T) {
	a, _ := testApp(t, dockMD)
	a.patchSettings(func(s *store.Settings) { s.DetailTipsOff = true })
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	dt := ui.NewTester(a.detailView, 380, 540)
	dt.Frame()
	open := func() []string {
		t.Helper()
		if err := dt.Click("更多操作"); err != nil {
			t.Fatalf("%v %v", err, dt.Texts())
		}
		return dt.Menu()
	}
	if got := open(); !slices.Equal(got, []string{"选词", "原文", "编辑"}) || !dt.HasText("发送到 Cursor") {
		t.Fatalf("380 宽应把「选词 / 原文 / 编辑」收进「⋯」，目标名留全 菜单=%v %v", got, dt.Texts())
	}
	if _, ok := dt.Find("处理"); !ok {
		t.Fatalf("「处理」应留在坞上 %v", dt.Texts())
	}
	if err := dt.ChooseMenuItem("原文"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	if !a.detail.raw {
		t.Fatal("选「原文」应切到原文")
	}
	if got := open(); !slices.Equal(got, []string{"选词", "渲染", "编辑"}) {
		t.Fatalf("切换后菜单项应改口「渲染」 %v", got)
	}
	if err := dt.ChooseMenuItem("选词"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	if !a.detail.pick {
		t.Fatal("选「选词」应进选词模式")
	}
	// 选词开着：按钮连同「词 / 段」回到坞上，别的让位——「处理」进了「⋯」，是子菜单
	if _, ok := dt.Find("选词"); !ok || !dt.HasText("段") {
		t.Fatalf("选词模式下「选词」与「词 / 段」应在坞上 %v", dt.Texts())
	}
	if got := open(); !slices.Equal(got, []string{"渲染", "处理", "复制", "编辑"}) {
		t.Fatalf("选词模式下其余操作应在「⋯」里 %v", got)
	}
	if err := dt.ChooseMenuItem("处理", "转大写"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	if got, _ := a.store.Note(n.ID); got.Text != strings.ToUpper(n.Text) || a.hudUndo == nil {
		t.Fatalf("「处理」子菜单里的项应照常生效、可撤销 %q", got.Text)
	}
	a.detail.pick = false
	dt.Frame()
	_ = open()
	if err := dt.ChooseMenuItem("编辑"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	if !a.detail.edit {
		t.Fatal("选「编辑」应进编辑态")
	}
}

// 最窄的窗里留下最用得上的：链接卡留「打开链接」「复制」；AI 进行中又开着选词、目标名很长时，
// 「取消 AI 请求」收进「⋯」后腾出的位置还给目标名，不是只剩「发送」。
func TestDetailDockKeepsWhatMatters(t *testing.T) {
	cases := dockCases()
	open := func(dc dockCase, target string) *ui.Tester {
		a, _ := testApp(t, dockMD)
		a.patchSettings(func(s *store.Settings) { s.DetailTipsOff = true })
		a.detail = detailState{pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
		n := dc.setup(a)
		a.detail.id = n.ID
		a.target = macos.FrontApp{PID: 42, Name: target}
		dt := ui.NewTester(a.detailView, 380, 540)
		dt.Frame()
		return dt
	}
	menu := func(dt *ui.Tester) []string {
		t.Helper()
		if err := dt.Click("更多操作"); err != nil {
			t.Fatalf("%v %v", err, dt.Texts())
		}
		m := dt.Menu()
		dt.CloseMenu()
		dt.Frame()
		return m
	}
	dt := open(cases[4], "Cursor") // 链接卡
	_, link := dt.Find("打开链接")
	_, cp := dt.Find("复制")
	if got := menu(dt); !link || !cp || !slices.Equal(got, []string{"选词", "处理", "编辑"}) {
		t.Fatalf("链接卡最窄时应留「打开链接」「复制」，其余进「⋯」 菜单=%v 坞=%v", got, dt.Texts())
	}
	dt = open(cases[3], "Visual Studio Code - Insiders") // AI 进行中 + 选词
	name, full := dt.Find("发送到 Visual Studio Code - Insiders")
	_, short := dt.Find("发送")
	if got := menu(dt); !full || short || name.W < 100 || !slices.Contains(got, "取消 AI 请求") || !dt.HasText("段") {
		t.Fatalf("「取消 AI 请求」收起后目标名应放回来（不是只剩「发送」），「词 / 段」留在坞上 目标名=%v 菜单=%v 坞=%v", name, got, dt.Texts())
	}
}

// 编辑态 / 只读预览 / AI 核对的坞按钮少，不走 dockFit：最窄的窗、中英文下也都完整在窗内。
func TestDetailOtherDocksFitNarrowest(t *testing.T) {
	defer setLanguage("zh", nil)
	for _, lang := range []string{"zh", "en"} {
		for _, tc := range []struct {
			name  string
			texts []string
			setup func(a *app, n store.Note)
		}{
			{"编辑态", []string{"渲染", "处理", "保存 ⌘⏎"}, func(a *app, n store.Note) { a.enterDetailEdit(n) }},
			{"只读预览", []string{"原文", "复制"}, func(a *app, n store.Note) { a.detail.virt = &n }},
			{"AI 核对", []string{"另存为新卡", "全部还原", "全部采纳 ⌘⏎"}, func(a *app, n store.Note) {
				rv := &aiReview{noteID: n.ID, orig: n.Text, act: aiActions[0]}
				rv.finish(strings.Replace(n.Text, "甲项", "甲项（已改）", 1))
				a.detail.review = rv
			}},
		} {
			a, _ := testApp(t, dockMD)
			a.patchSettings(func(s *store.Settings) { s.DetailTipsOff = true })
			n := a.store.Notes()[0]
			a.detail, a.detailText = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}, n.Text
			tc.setup(a, n)
			setLanguage(lang, nil)
			dt := ui.NewTester(a.detailView, 380, 540)
			dt.Frame()
			dt.Frame()
			for _, zh := range tc.texts {
				if r, ok := dt.Find(tr(zh)); !ok || r.X < ddockPadX-0.5 || r.X+r.W > 380-ddockPadX+0.5 {
					t.Fatalf("%s / %s：「%s」应完整留在窗内 %v（找到=%v）%v", lang, tc.name, zh, r, ok, dt.Texts())
				}
			}
			setLanguage("zh", nil)
		}
	}
}

// 浅 / 深色截图目检（TOSKR_SHOT_DIR 落盘）：操作坞在各窗宽、各状态下的样子。
func TestDetailDockShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("设 TOSKR_SHOT_DIR 才出图")
	}
	defer setLanguage("zh", nil)
	defer func() { curScheme = "default" }()
	long := "## 一、结论\n\n详情窗当前的信息层次不足：来源、时间、字数挤在同一行 10pt 灰字里，新用户看不出这扇窗能做什么。\n\n## 二、待办\n\n1. 头部拆成「身份」与「元信息」两层\n2. 底部坞改为主操作全宽\n3. 划词工具条保留现有能力\n\n## 三、风险\n\n- 坞变高后长文可读区域减少\n- 图标格在英文界面下标签可能过长\n\n以上意见请在周四前回复。"
	cases := dockCases()
	type scene struct {
		name   string
		w      int
		target string
		dc     dockCase
		en     bool
		scheme string
		hover  string // 悬停在这个标签的元素上再出图
	}
	var scenes []scene
	for _, w := range []int{380, 420, 460, 500, 560} {
		scenes = append(scenes, scene{name: fmt.Sprintf("dock-%d", w), w: w, target: "Cursor", dc: cases[0]})
	}
	scenes = append(scenes,
		scene{name: "dock-380-longtarget", w: 380, target: "Visual Studio Code - Insiders", dc: cases[0]},
		scene{name: "dock-460-longtarget", w: 460, target: "Visual Studio Code - Insiders", dc: cases[0]},
		scene{name: "dock-560-longtarget", w: 560, target: "Visual Studio Code - Insiders", dc: cases[0]},
		scene{name: "dock-380-notarget", w: 380, dc: cases[0]},
		scene{name: "dock-380-pick", w: 380, target: "Cursor", dc: cases[1]},
		scene{name: "dock-380-busy", w: 380, target: "Cursor", dc: cases[2]},
		scene{name: "dock-380-busy-pick", w: 380, target: "Visual Studio Code - Insiders", dc: cases[3]},
		scene{name: "dock-380-link", w: 380, target: "Cursor", dc: cases[4]},
		scene{name: "dock-380-en", w: 380, target: "Cursor", dc: cases[0], en: true},
		scene{name: "dock-460-en", w: 460, target: "Cursor", dc: cases[0], en: true},
		scene{name: "dock-380-hover-more", w: 380, target: "Cursor", dc: cases[0], hover: "更多操作"},
		scene{name: "dock-380-platinum", w: 380, target: "Cursor", dc: cases[0], scheme: "platinum"},
		scene{name: "dock-460-platinum", w: 460, target: "Visual Studio Code - Insiders", dc: cases[0], scheme: "platinum"},
	)
	// 不走 dockFit 的三种坞（编辑态 / 只读预览 / AI 核对），最窄的窗
	first := func(a *app) store.Note { return a.store.Notes()[0] }
	edit := dockCase{setup: func(a *app) store.Note {
		n := first(a)
		a.detail.id = n.ID
		a.enterDetailEdit(n)
		return n
	}}
	virt := dockCase{setup: func(a *app) store.Note {
		n := first(a)
		a.detail.virt = &n
		return n
	}}
	review := dockCase{setup: func(a *app) store.Note {
		n := first(a)
		rv := &aiReview{noteID: n.ID, orig: n.Text, act: aiActions[0]}
		rv.finish(strings.Replace(n.Text, "底部坞", "操作坞", 1))
		a.detail.review = rv
		return n
	}}
	scenes = append(scenes,
		scene{name: "dock-380-edit", w: 380, target: "Cursor", dc: edit},
		scene{name: "dock-380-edit-en", w: 380, target: "Cursor", dc: edit, en: true},
		scene{name: "dock-380-virt", w: 380, target: "Cursor", dc: virt},
		scene{name: "dock-380-review", w: 380, target: "Cursor", dc: review},
		scene{name: "dock-380-review-en", w: 380, target: "Cursor", dc: review, en: true},
	)
	for _, sc := range scenes {
		a, _ := testApp(t, long)
		a.detail = detailState{pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
		n := sc.dc.setup(a)
		a.detail.id, a.detailText = n.ID, n.Text
		if sc.target != "" {
			a.target = macos.FrontApp{PID: 42, Name: sc.target}
		}
		if sc.scheme != "" {
			a.patchSettings(func(s *store.Settings) { s.ColorScheme = sc.scheme })
			curScheme = sc.scheme
		}
		if sc.en {
			setLanguage("en", nil)
		}
		dt := ui.NewTester(a.detailView, sc.w, 540)
		for _, dark := range []bool{false, true} {
			if dark && sc.scheme != "" {
				continue
			}
			dt.SetDark(dark)
			dt.Frame()
			dt.Frame()
			if sc.hover != "" {
				if r, ok := dt.Find(tr(sc.hover)); ok {
					dt.Move(r.X+r.W/2, r.Y+r.H/2)
				}
			}
			dt.Advance(400 * time.Millisecond)
			dt.Frame()
			dt.Frame()
			save(t, filepath.Join(dir, sc.name+"-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), dt.Image())
		}
		setLanguage("zh", nil)
		curScheme = "default"
	}
}
