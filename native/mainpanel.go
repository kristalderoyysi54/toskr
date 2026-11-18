package main

import (
	"fmt"
	"os/exec"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/codehl"
	"github.com/toskr/native/internal/store"
)

// 主面板按 Tauri 版逐项复刻（坐标、字阶、颜色、阴影取自浏览器实测导出）。
// 面板宽 380；自上而下：标题栏 44 → 目标条 36 → 6 → 页签 30 → 6 → 列表 → 快捷键提示 20 → 输入区 60。

// noteGroup 是笔记页里的一个分组块。
type noteGroup struct {
	sec  store.Section
	open []store.Note
	done []store.Note
}

func (a *app) mainHeader(c *ui.Context, k tokens) {
	// 整个头部（含标题上方 14pt 留白与两侧空白）是拖动区，同 Tauri <header data-tauri-drag-region>；按钮照常点击。
	// 之前只有「Toskr」文字可拖，用户从面板顶部空白处拖不动
	ui.Row(c).Height(44).Padding(14, 16, 8, 16).Gap(8).AlignItems(ui.Start).DragWindow().Key("panel-header").Children(func() {
		tipOf(c, text(c, "Toskr", 13, 18, 600, k.fg).LetterSpacing(-0.325).Grow(1).Margin(2, 0, 0, 0).Cursor(ui.CursorGrab), tr("拖动此处可移动面板（未吸附时）")).DragWindow()
		ui.Row(c).Gap(2).Children(func() {
			a.updatePill(c, k)
			if a.page != pageTasks && a.iconButton(c, k, "search", 22, 14, "搜索（⌘F）") {
				a.searchOpen = !a.searchOpen
			}
			if a.iconButton(c, k, "menu", 22, 14, "列表与面板选项") {
				a.menuOpen, a.placementOpen = !a.menuOpen, false
			}
			if a.iconButton(c, k, "settings-2", 22, 14, "设置（⌘,）") {
				a.openSettings()
			}
		})
	})
}

// iconButton 是 Tauri 的 IconButton：透明底、圆角 8、悬停浅底。
func (a *app) iconButton(c *ui.Context, k tokens, icon string, box, size float32, tip string) bool {
	b := tipOf(c, ui.Box(c).Size(box, box).Radius(rr(8)).Center(), tip).Role(ui.RoleButton).Label(tip)
	if col, ok := k.th.IconFace(b, k.muted, k.fg, false); ok {
		b.Children(func() { licon(c, icon, size, col) })
		return b.Clicked()
	}
	bg := ui.Transparent
	if b.Hovered() {
		bg = k.track
	}
	fadeColor(b, "bg", bg, tweenControl) // IconButton：color / bg / transform 100ms，按下 scale 0.94
	b.AnimatePose(ui.Pose{Scale: pressScale(b.Pressed(), 0.94)}, tweenControl)
	b.Children(func() { licon(c, icon, size, k.muted) })
	return b.Clicked()
}

// toggleIconButton：带按下态的 IconButton（aria-pressed 时图标染主色）。
func (a *app) toggleIconButton(c *ui.Context, k tokens, icon, tip string, on bool) bool {
	b := tipOf(c, ui.Box(c).Size(22, 22).Radius(rr(8)).Center(), tip).Role(ui.RoleButton).Label(tip)
	if col, ok := k.th.IconFace(b, k.muted, k.fg, on); ok {
		b.Children(func() { licon(c, icon, 14, col) })
		return b.Clicked()
	}
	bg := ui.Transparent
	if b.Hovered() {
		bg = k.track
	}
	fadeColor(b, "bg", bg, tweenControl)
	b.AnimatePose(ui.Pose{Scale: pressScale(b.Pressed(), 0.94)}, tweenControl)
	fg := k.muted
	if on {
		fg = stok(c).primary
	}
	b.Children(func() { licon(c, icon, 14, fg) })
	return b.Clicked()
}

func (a *app) targetBar(c *ui.Context, k tokens) {
	ui.Column(c).Margin(0, 12).Padding(4).Children(func() {
		ui.Row(c).Height(28).Gap(6).Grow(1).AlignItems(ui.Center).Children(func() {
			ui.Row(c).Gap(6).Grow(1).AlignItems(ui.Center).Children(func() {
				el, switching := a.targetSwitchElapsed(c) // 换目标时「灵动胶囊」动效（target_switch.go）
				switch {
				case switching:
					a.targetSwitchWho(c, k, el)
				default:
					a.targetIcon(c, k, a.target) // 目标应用真实图标（同 Tauri TargetLensBar appIcon），没取到用通用图标
				}
				if a.target.PID == 0 {
					if !switching {
						text(c, tr("未识别目标"), 11, 16, 600, k.fg)
					}
					return
				}
				if !switching {
					text(c, a.target.Name, 11, 16, 600, k.fg).SingleLine()
				}
				text(c, "·", 10, 14, 400, k.muted)
				dot, state := k.ok, tr("可发送")
				if !targetAlive(a.target.PID, a.targetStarted) { // 同 Tauri TargetLensBar：进程已退出 / 重启 → 失效
					dot, state = k.danger, tr("目标应用已失效")
				}
				ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
					ui.Box(c).Size(6, 6).Radius(3).Background(dot)
					text(c, state, 10, 14, 500, k.muted)
				})
			})
			ui.Row(c).Gap(2).Children(func() {
				// 同 Tauri showRecoveryAction：目标未识别 / 已失效时刷新钮放在头部；正常时收在展开区方案行末
				if (a.target.PID == 0 || !targetAlive(a.target.PID, a.targetStarted)) && a.iconButton(c, k, "refresh-cw", 20, 12, tr("重新识别发送目标")) {
					a.refreshTarget()
				}
				if a.iconButton(c, k, "rotate-ccw-clock", 20, 12, tr("最近发送")) {
					a.drawerOpen = !a.drawerOpen
				}
				a.lensChevron(c, k)
			})
		})
		if a.lensOpen {
			a.lensDetail(c, k)
		}
	})
}

var tabLabels = []string{"剪贴", "笔记", "任务"}

var pageIDs = map[string]int{"clipboard": pageClip, "notes": pageNotes, "tasks": pageTasks}

// visiblePages：按设置的页签顺序（同 Tauri pageOrder），秘文是「内容」下的子页不占一级；关闭剪贴历史时不出剪贴页。
func (a *app) visiblePages() []int {
	st := a.store.Settings()
	var out []int
	for _, id := range store.NormalizePageOrder(st.PageOrder) {
		p, ok := pageIDs[id]
		if ok && (p != pageClip || st.ClipboardWatch || a.page == pageClip) {
			out = append(out, p)
		}
	}
	return out
}

func pageID(p int) string {
	for k, v := range pageIDs {
		if v == p {
			return k
		}
	}
	return ""
}

type tabDrag struct{ page int }

// secDrag 是被拖动排序的笔记分组（区头组名 / 侧栏分组胶囊）。
type secDrag struct{ id string }

// pageStep：⌘←→ / ⌃Tab 按可见页签顺序移动（wrap 时循环）。
func (a *app) pageStep(d int, wrap bool) {
	pages := a.visiblePages()
	i := max(0, slices.Index(pages, a.page)) + d
	if wrap {
		i = (i + len(pages)) % len(pages)
	}
	if i >= 0 && i < len(pages) {
		a.switchPage(pages[i])
	}
}

// scrollPageTop：双击页签回到列表起点（滚到顶、焦点回第一张）。
func (a *app) scrollPageTop(p int) {
	switch p {
	case pageClip:
		a.clipScroll.ScrollTo(0, 0, springSnappy)
	case pageNotes:
		a.noteScroll.ScrollTo(0, 0, springSnappy)
	case pageTasks:
		a.taskScroll.ScrollTo(0, 0, springSnappy)
	}
	a.selected = 0
}

func (a *app) tabs(c *ui.Context, k tokens) {
	ui.Row(c).Height(30).Margin(6, 12, 6, 12).AlignItems(ui.Start).Children(func() { a.tabStrip(c, k) })
}

// tabStrip 是页签轨道本体（竖栏单独一行；横栏并入标题行）。
func (a *app) tabStrip(c *ui.Context, k tokens) {
	{
		ui.Row(c).Padding(2).Radius(rr(10)).Background(k.track).Children(func() {
			st := a.store.Settings()
			for _, i := range a.visiblePages() {
				label := tabLabels[i]
				if i == pageNotes && (st.SecretEnabled || st.MessagesEnabled) {
					label = "内容" // 秘文 / 消息开启后笔记页升格为「内容」域（笔记 · 消息 · 秘文），与 Tauri 一致
				}
				if i == pageTasks && st.SubscriptionsEnabled {
					label = "提醒"
				}
				sel := a.page == i
				badge := 0
				if i == pageTasks {
					badge = a.overdueCount()
				}
				if i == pageNotes {
					badge = a.newMessageCount()
				}
				w := float32(44)
				if badge > 0 {
					w = 66 // 文字 22 + 间距 6 + 徽标 16 + 内边距 20 + 边框 2
				}
				b := tipOf(c, ui.Box(c).Size(w, 26).Padding(1).Radius(rr(8)).Key("tab-"+label), fmt.Sprintf(tr("切换到%s；双击返回列表起点；拖动可调整顺序"), tr(label)))
				b.Drag(tabDrag{i})
				if d, ok := ui.Drop[tabDrag](b); ok && d.page != i { // 拖到另一个页签上 = 移到它的位置（同 Tauri arrayMove）
					cur := a.store.Settings()
					cur.PageOrder = store.MovePage(cur.PageOrder, pageID(d.page), pageID(i))
					_ = a.store.SetSettings(cur)
				}
				hover := !sel && b.Hovered()
				if hover { // 悬停底色不在 Tauri 的过渡列表里：即时
					b.Background(k.hoverBg)
				}
				b.AnimatePose(ui.Pose{Scale: pressScale(b.Pressed(), 0.97)}, tweenControl)
				b.Children(func() {
					if sel { // 选中胶囊是共享布局指示器（layoutId page-tab-thumb）：换页时从旧页签滑过来
						thumb := ui.Box(c).Absolute().Top(1).Left(1).Right(1).Bottom(1).Radius(rr(8)).Background(k.pill).Shadow(0, 1, 2, 0, k.pillShadow).
							PassThrough().Transition(ui.ElementTransition{Match: layoutID{"page-tab-thumb"}, Animation: &springControl, Position: true, Size: true})
						if !k.dark {
							thumb.InsetShadow(0, 1, 0, 0, k.pillHighlight)
						}
						k.th.SegThumb(thumb)
					}
					ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Center().Children(func() { // 绝对定位且排在胶囊之后才画在胶囊上
						w, col := 400, k.muted
						if sel || hover {
							col = k.fg
						}
						if sel {
							w = 500
						}
						col = b.AnimateColor("fg", col, tweenControl)
						ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
							text(c, tr(label), 11, 16, w, col)
							if badge > 0 {
								ui.Box(c).Size(16, 16).Radius(8).Background(k.danger.Alpha(0.9)).Center().Children(func() {
									text(c, itoa(badge), 10, 14, 600, ui.RGB(255, 255, 255))
								})
							}
						})
					})
				})
				if b.Clicked() {
					a.switchPage(i)
				}
				if b.DoubleClicked() {
					a.scrollPageTop(i)
				}
			}
		})
	}
}

// groups 重建笔记页的分组块（剪贴板分组只在「剪贴」页出现）。
func (a *app) groups() []noteGroup {
	all := store.Search(a.store.Notes(), a.query)
	var out []noteGroup
	for _, s := range a.store.Sections() {
		if s.ID == store.SectionClipboard || (a.noteFilter != "" && a.noteFilter != doneFilter && s.ID != a.noteFilter) {
			continue
		}
		g := noteGroup{sec: s}
		for _, n := range all {
			if n.Section != s.ID {
				continue
			}
			if n.Done {
				g.done = append(g.done, n)
			} else {
				g.open = append(g.open, n)
			}
		}
		if a.query != "" && len(g.open)+len(g.done) == 0 {
			continue // 同 Tauri：搜索时隐藏没有命中的分组
		}
		switch s.Sort { // 同值保持手动顺序
		case store.SortSent:
			slices.SortStableFunc(g.open, func(x, y store.Note) int { return y.SendCount - x.SendCount })
		case store.SortRecent: // 没发过的（零值）自然排在最后
			slices.SortStableFunc(g.open, func(x, y store.Note) int { return y.SentAt.Compare(x.SentAt) })
		}
		out = append(out, g)
	}
	return out
}

// autoSorted：分组是否自动排序（分组菜单「排序」不是手动）。这样的组里卡片间拖放不改顺序，拖到分组头 / 侧栏换组照常。
func (a *app) autoSorted(secID string) bool {
	for _, s := range a.store.Sections() {
		if s.ID == secID {
			return s.Sort != ""
		}
	}
	return false
}

// sectionSorts：分组「排序」的三个选项（值 → 菜单文字 → 分组头图标）。
var sectionSorts = []struct{ id, label, icon string }{
	{"", "手动", ""}, {store.SortSent, "发送最多", "list-ordered"}, {store.SortRecent, "最近发送", "clock"},
}

func (a *app) notesPage(c *ui.Context, k tokens) {
	defer a.triagePanel(c, k)
	ui.Row(c).Grow(1).AlignItems(ui.Stretch).Children(func() { // Row 默认垂直居中：不拉伸的话列表短于视口时会整块浮到中间
		a.notesList(c, k) // 左侧分组侧栏已移除（用户 2026-11-17）：筛选在分组头菜单、新建分组在标题栏 ☰ 菜单，换组靠拖动分组坞
	})
}

func (a *app) notesList(c *ui.Context, k tokens) {
	// 侧栏点选分组 = 换一批内容：按侧栏顺序定方向淡入（swapView）
	at := 0
	if a.noteFilter != "" {
		at = 1 + slices.IndexFunc(a.noteSections(), func(s store.Section) bool { return s.ID == a.noteFilter })
	}
	a.swapView(ui.Column(c).Grow(1).Basis(0), "note-filter", at).Children(func() {
		pad := float32(10)
		if k.th.ClassicScroll() {
			pad = 4 // 右侧让给经典滚动条（井内左 10 / 右 4）
		}
		if a.rowDragID == "" && a.rowDragLast != "" { // 刚松手：放下的行高弹回去的这段仍走动画
			a.rowSettle, a.rowSettleUntil = a.rowDragLast, dragNow().Add(700*time.Millisecond)
		}
		a.rowDragLast, a.rowDragID = a.rowDragID, ""
		if a.rowDragLast == "" && len(a.dockNaming) == 0 { // 坞收起：翻页 / 翻页计时 / 指针在坞上 复位
			a.dockFor, a.dockPage, a.dockEdge, a.dockUnder = "", 0, dockEdge{}, false
		}
		// 分组坞钉在列表最上方：视口让出一条，滚动量同步补上，列表内容原地不动
		if on := a.dockOn(); on != a.dockWas {
			if on {
				a.noteScroll.Y += dockSlotH
			} else {
				a.noteScroll.Y = max(a.noteScroll.Y-dockSlotH, 0)
			}
			a.dockWas = on
		}
		if a.dockWas { // 坞在列表之后建、绝对定位到让出的那一条里（构建顺序在后：同名文字先命中列表里的分组）
			defer a.noteDock(c, k, 10, pad)
		}
		sc := ui.Scroll(c).Grow(1).Basis(0).FillWidth().Scrollbars(false).TrackScroll(&a.noteScroll)
		if a.dockWas {
			sc.Margin(dockSlotH, 0, 0, 0)
		}
		// 分组吸顶用：上一帧的视口位置与当时的滚动量（Bounds 是上一帧布局），换算分组在内容里的纵坐标
		a.stick = stickCtx{view: sc.Bounds(), builtY: a.stick.nextY, nextY: a.noteScroll.Y, top: map[string]float32{}}
		sc.Children(func() {
			list := ui.Column(c).Padding(4, pad, 8, 10).Gap(8)
			sortListBegin[secDrag](&a.secSort, list, &a.secJump, &a.secSeen, func(from, to string) { // 松手：落进让出的空位（同 dnd-kit arrayMove）
				_ = a.store.ReorderSection(from, to)
				a.reload()
			})
			if a.secSort.active != "" || (a.rowDragLast != "" && !a.dockUnder) { // 拖分组 / 拖行到列表上下缘自动滚（指针在分组坞上时不滚）
				sortAutoScroll(c, sc, &a.noteScroll)
			}
			a.secOrder = a.secOrder[:0]
			for _, g := range a.noteGroups {
				a.secOrder = append(a.secOrder, g.sec.ID)
			}
			defer func() { sortListEnd(&a.secSort, a.secSeen) }()
			list.Children(func() {
				a.noteFilterBar(c, k)
				if a.newSecOn {
					ui.TextInputBase(c, &a.newSec).Height(28).Padding(0, 10).Radius(rr(10)).Background(k.track).Font(fontSans).FontSize(12).
						Focus().Placeholder(tr("分组名，↵ 创建")).OnTextKey(func(key ui.TextKey) bool {
						switch key.Key {
						case ui.KeyEnter:
							if id := a.store.AddSection(key.Text()); id != "" {
								a.section = id
							}
							a.newSecOn, a.newSec = false, ""
							return true
						case ui.KeyEscape:
							a.newSecOn, a.newSec = false, ""
							return true
						}
						return false
					})
				}
				// 行高固定（舒适 52 / 紧凑 40），按滚动位置只构建视口附近的卡，其余用等高占位（长列表换页不卡）
				_, vh := c.Size()
				a.vis = visWindow{top: a.noteScroll.Y - 600, bottom: a.noteScroll.Y + vh + 600}
				y := float32(4)
				if a.noteFilter != "" && a.noteFilter != doneFilter {
					y += 26 + 8 // 筛选条
				}
				total := 0
				for _, g := range a.noteGroups {
					total += len(g.open) + len(g.done)
				}
				coach := a.coachVisible()
				if coach { // 演练 / 进阶课卡在列表顶部（同 Tauri）
					a.coachCards(c, k)
				}
				switch { // 同 Tauri 笔记页空态 / 搜索无结果
				case total == 0 && coach:
					return
				case total == 0 && a.query != "":
					text(c, fmt.Sprintf(tr("没有匹配「%s」的卡片"), a.query), 12, 18, 400, k.muted).Padding(32, 0).TextAlign(ui.Center).FillWidth()
					return
				case total == 0 && a.noteFilter == "":
					a.emptyQueue(c, k)
					return
				}
				if a.quickStripShown() { // 常用栏：定高，计进后面分组的纵坐标（窗口化按它算可见）
					a.quickStrip(c, k)
					y += a.quickStripHeight() + 8
				}
				a.glideHov, a.glideNext = a.glideNext, rowGlideAt{} // 上一帧量到的悬停行，本帧画滑动浅底
				for _, g := range a.noteGroups {
					y += a.sectionBlock(c, k, g, y) + 8
				}
			})
		})
	})
}

// noteFilterBar：「只看此组」时列表顶上的筛选条：分组色点 + 名 + 「显示全部」。
func (a *app) noteFilterBar(c *ui.Context, k tokens) {
	if a.noteFilter == "" || a.noteFilter == doneFilter {
		return
	}
	var sec store.Section
	for _, s := range a.store.Sections() {
		if s.ID == a.noteFilter {
			sec = s
		}
	}
	bar := ui.Row(c).Height(26).Padding(0, 4, 0, 10).Gap(6).Radius(rr(8)).Background(k.track).AlignItems(ui.Center).Key("note-filter-bar").
		Transition(foldTransition)
	for _, g := range a.noteGroups { // 右键筛选条 = 该分组头的菜单
		if g.sec.ID == sec.ID {
			bar.ContextMenu(func(m *ui.Menu) { a.sectionHeadMenu(c, m, g) })
		}
	}
	bar.Children(func() {
		licon(c, "list-filter", 11, k.muted)
		text(c, tr("只看"), 11, 16, 400, k.muted)
		if tint, ok := sectionTint(sec); ok {
			ui.Box(c).Size(7, 7).Radius(4).Background(tint)
		}
		text(c, sectionName(sec), 11, 16, 600, k.fg).SingleLine().Shrink(1)
		ui.Box(c).Grow(1)
		b := ui.Row(c).Height(20).Padding(0, 8).Radius(rr(6)).AlignItems(ui.Center).Role(ui.RoleButton).Label(tr("显示全部分组")).Key("filter-all")
		if b.Hovered() {
			b.Background(k.hoverBg)
		}
		b.Children(func() { text(c, tr("显示全部"), 11, 16, 500, stok(c).primary) })
		if b.Clicked() {
			a.pickNoteGroup("")
		}
	})
}

// visWindow：笔记列表内容坐标下需要真实构建的纵向范围。
type visWindow struct{ top, bottom float32 }

// has：纵坐标 y、高 h 的条目是否与范围相交。
func (v visWindow) has(y, h float32) bool { return y+h >= v.top && y <= v.bottom }

const secPad = 4 // 分组大边框的内边距

const emptySecH = 32 // 空分组提示高（上下各 8 + 一行 16；sectionBlock 的占位高度与之一致）

// emptyQueue：笔记页空态——用键帽把动作画出来，再给一个当下就能点的操作（把剪贴板现有文字收成第一张卡）。
// 键帽读设置里的实际触发键，不写死 ⇧。
func (a *app) emptyQueue(c *ui.Context, k tokens) {
	label := a.captureKeyLabel() // 如「⇧ Shift」
	glyph, name, _ := strings.Cut(label, " ")
	ui.Column(c).Padding(36, 20, 20, 20).AlignItems(ui.Center).FillWidth().Key("empty-queue").Children(func() {
		ui.Row(c).Gap(8).Label(fmt.Sprintf(tr("连按两次 %s"), label)).Children(func() {
			for i := range 2 {
				ui.Box(c).Size(40, 40).Radius(rr(10)).Background(k.card).Border(1, k.fg.Alpha(0.12)).Shadow(0, 1, 0, 0, k.fg.Alpha(0.12)).Center().Key("empty-key-" + itoa(i)).
					Children(func() { text(c, glyph, 17, 24, 500, k.fg) })
			}
		})
		text(c, fmt.Sprintf(tr("选中文字，连按两次 %s"), name), 13, 18, 600, k.fg).Margin(14, 0, 0, 0)
		text(c, tr("在任何应用里都可以"), 11, 16, 400, k.muted).Margin(2, 0, 0, 0)
		ui.Row(c).FillWidth().Margin(16, 0, 0, 0).Children(func() {
			if btnOf(c, tr("把剪贴板内容收成第一张卡")).Grow(1).Basis(0).Clicked() {
				a.clipboardToFirstCard()
			}
		})
	})
}

// clipboardToFirstCard：把系统剪贴板里现有的文字存成收件箱的一张卡（可撤销）；没有文字时只提示。
func (a *app) clipboardToFirstCard() {
	txt, _ := a.sys.ReadString()
	if strings.TrimSpace(txt) == "" {
		a.showHUD("info", tr("剪贴板里没有文字"))
		return
	}
	n, dup, err := a.store.Add(store.Note{Section: a.captureSection(), Text: txt})
	if err != nil {
		a.showHUD("warn", tr("保存失败：")+err.Error())
		return
	}
	a.reload()
	if dup {
		a.showHUD("duplicate", preview(n.Text, 40))
		return
	}
	a.showHUDUndo("added", preview(n.Text, 40), func() {
		a.store.Delete(n.ID)
		a.reload()
	})
}

// emptySection：空分组——一行「此分组为空」（同 Tauri EmptyState inline）。拖入仍由分组块接收；
// 「设为捕获目标」在分组右键菜单里（同 Tauri SectionGroup）。
func (a *app) emptySection(c *ui.Context, k tokens, sec store.Section) {
	ui.Column(c).Height(emptySecH).Center().Key("secempty-" + sec.ID).Transition(foldTransition).Children(func() {
		text(c, tr("此分组为空"), 11, 16, 400, k.muted)
	})
}

func (a *app) cardHeight() float32 {
	if a.store.Settings().CardDensity == "compact" {
		return 40
	}
	return listRowH
}

// sectionHeadMenu：分组头右键 / 「…」共用菜单（用户 2026-11-17：区头「+」并入这里）——
// 新建内容 · 只看此组 · 清理已完成，之后是分组管理（sectionMenu），只放针对本组的操作；新建分组 · 全部展开 / 全部折叠在标题栏 ☰ 菜单（用户 2026-11-18）。
func (a *app) sectionHeadMenu(c *ui.Context, m *ui.Menu, g noteGroup) {
	if g.sec.ID != store.SectionClipboard && m.Item(tr("新建内容")).Chosen() {
		a.newNoteIn(g.sec)
	}
	m.Separator()
	if a.noteFilter == g.sec.ID {
		if m.Item(tr("显示全部分组")).Chosen() {
			a.pickNoteGroup("")
		}
	} else if m.Item(tr("只看此组")).Chosen() {
		a.pickNoteGroup(g.sec.ID)
	}
	if len(g.done) > 0 && m.Item(tr("清理已完成")).Chosen() {
		a.section = g.sec.ID
		a.clearDone(c)
	}
	m.Separator()
	secs := a.noteSections()
	i := slices.IndexFunc(secs, func(x store.Section) bool { return x.ID == g.sec.ID })
	a.secMenuSrc = "head"
	a.sectionMenu(m, g.sec, i, len(secs))
}

// sectionFoldCounts：笔记页当前列出的分组里展开 / 折叠的各有几个。
func (a *app) sectionFoldCounts() (open, shut int) {
	for _, g := range a.noteGroups {
		if g.sec.Collapsed {
			shut++
		} else {
			open++
		}
	}
	return
}

// foldAllSections：笔记页列出的分组一起折叠 / 展开（状态逐组存，与单独点区头同一字段）。
func (a *app) foldAllSections(fold bool) {
	ids := map[string]bool{}
	for _, g := range a.noteGroups {
		ids[g.sec.ID] = true
	}
	for _, s := range a.store.Sections() {
		if ids[s.ID] && s.Collapsed != fold {
			s.Collapsed = fold
			_ = a.store.UpdateSection(s)
		}
	}
	a.reload()
}

// sectionBlock 构建一个分组块，top 为它在列表内容里的纵坐标，返回块高（与布局一致：区头 20 + 间距 6 + 卡片列 + 底 4）。
func (a *app) sectionBlock(c *ui.Context, k tokens, g noteGroup, top float32) float32 {
	collapsed := g.sec.Collapsed
	height := float32(20 + 4)
	switch {
	case collapsed:
	case len(g.open) == 0 && len(g.done) == 0:
		height += 6 + emptySecH
	default:
		height += 6 + 2*secPad // 分组大边框：内边距 secPad，行间不留缝
		for _, n := range g.open {
			height += a.noteRowH(c, n) // 卡片样式行高随内容变
		}
		if len(g.done) > 0 {
			height += 18
			if a.doneOpen[g.sec.ID] {
				height = -1 // 已完成展开：高度不固定，不做窗口化
			}
		}
	}
	// 分组拖动排序（同 Tauri SectionGroup useSortable）：槽位不动、按它判断落点，内层平移让位
	slot := ui.Column(c).Key("secslot-" + g.sec.ID)
	sortTrack(&a.secSort, slot, g.sec.ID)
	shift := a.secSort.offset(a.secOrder, g.sec.ID, 8) // 让位目标：窗口化时连平移后的位置一起算可见
	slot.Children(func() {
		col := ui.Column(c).Gap(6).Padding(0, 0, 4, 0).Radius(rr(8)).Key("sec-" + g.sec.ID)
		sortShift(&a.secSort, col, a.secOrder, g.sec.ID, 8, a.secJump)
		off := a.stickOffset(g.sec.ID, col.Bounds())
		col.Children(func() {
			if a.secSort.active == g.sec.ID { // 落点：虚线框标出松手后分组落在哪（内容已淡化）
				slotMark(c)
			}
			head := ui.Row(c).Height(20).Padding(0, 4, 0, 2).Gap(4).Radius(rr(6)).AlignItems(ui.Center).Key("sechead-" + g.sec.ID) // 稳定身份：落点虚线框插在前面时拖动源不能换人
			if a.headRename != g.sec.ID {
				head.Drag(secDrag{g.sec.ID}) // 同 Tauri：按住区头拖动 = 拿起整个分组
			}
			if head.Dragging() {
				a.secSort.begin(g.sec.ID)
				a.secSeen = true
				liftHead(c, head)
			}
			if off > 0 { // 同 Tauri SectionGroup sticky top-0：滚过组首后区头钉在视口顶，直到本组底部把它推走
				head.Translate(0, off)
			}
			_, over := ui.DragOver[noteDrag](head)
			if over {
				head.Background(stok(c).primary.Alpha(0.12))
			}
			if a.dragHover(c, g.sec.ID, over, collapsed) {
				g.sec.Collapsed = false
				_ = a.store.UpdateSection(g.sec)
			}
			if d, ok := ui.Drop[noteDrag](head); ok {
				a.moveNotesTo(a.dragNotes(d.id), g.sec.ID)
			}
			head.ContextMenu(func(m *ui.Menu) { a.sectionHeadMenu(c, m, g) })
			a.sectionColorPopover(c, k, g.sec, head, "head")
			head.Children(func() {
				b := ui.Box(c).Size(16, 16).Radius(rr(6)).Center()
				b.Children(func() { foldChevron(c, k, collapsed) })
				if b.Clicked() {
					g.sec.Collapsed = !collapsed
					_ = a.store.UpdateSection(g.sec)
				}
				if g.sec.Color != "" { // 同 Tauri SectionGroup：分组色点（带一圈同色光晕，与框描边呼应）
					col := hexColor(g.sec.Color)
					ui.Box(c).Size(8, 8).Radius(4).Background(col).Border(2, col.Alpha(0.22))
				}
				a.sectionHeadName(c, k, g.sec)
				if g.sec.KeepAfterSend {
					tipOf(c, liconFilled(c, "star", 10, k.muted), tr("发送后保留"))
				}
				for _, o := range sectionSorts {
					if o.icon != "" && g.sec.Sort == o.id {
						tipOf(c, licon(c, o.icon, 10, k.muted), tr("排序：")+tr(o.label))
					}
				}
				if g.sec.ID != store.SectionInbox && a.store.Settings().CaptureSection == g.sec.ID {
					tipOf(c, licon(c, "arrow-down-to-line", 10, k.muted), tr("捕获目标"))
				}
				total := len(g.open) + len(g.done)
				ui.Box(c).Grow(1)
				if head.Hovered() || a.secMenuOpen == g.sec.ID { // 同 Tauri：悬停出「…」分组操作
					mb := ghostIconButton(c, k, "secmore-"+g.sec.ID, "ellipsis", tr("分组操作"), 18, 12, false, true)
					mb.Menu(func(m *ui.Menu) {
						a.secMenuOpen = g.sec.ID
						a.sectionHeadMenu(c, m, g)
					})
					if !mb.Hovered() && a.secMenuOpen == g.sec.ID {
						a.secMenuOpen = ""
					}
				}
				if g.sec.ID == store.SectionInbox && !collapsed { // 收件箱操作排在悬停按钮之后
					a.inboxHeadActions(c, k, g)
				}
				// 条数贴最右对齐（用户 2026-11-17）：各组数字一列对齐；等宽数字、最小宽度保证个位 / 两位数右缘齐
				text(c, itoa(total), 10.5, 14, 500, k.muted).Font(fontMono).TextAlign(ui.End).MinWidth(18).Shrink(0).Key("sec-count")
			})
			if collapsed {
				return
			}
			if len(g.open) == 0 && len(g.done) == 0 {
				a.emptySection(c, k, g.sec)
				return
			}
			// 吸顶时卡片滚到区头下沿即被裁掉（同 Tauri 卡片在吸顶栏下沿渐隐，不与标题叠印）：
			// 外层裁切窗随区头下移，内层反向平移保持卡片原位
			clip := ui.Box(c).Key("secclip-" + g.sec.ID)
			if shift := off - 4; shift > 0 {
				clip.Translate(0, shift).ClipY()
			}
			clip.Children(func() {
				// 分组大边框（用户 2026-11-17 定）：一个分组一个框，行在框里；收件箱是唯一抬起（带阴影）的框
				// 分组颜色（用户 2026-11-17：融进框里）：框描边带一层分组色、悬停滑块用分组色（框顶渐变已去：操作条遮罩对不上色）；
				// 选中仍是主色（选中的含义全局统一）。无颜色的分组保持中性
				tint, tinted := sectionTint(g.sec)
				border := k.inputBorder
				if tinted {
					border = tint.Alpha(map[bool]float32{true: 0.42, false: 0.34}[k.dark])
				}
				body := ui.Column(c).Padding(secPad).Radius(rr(14)).Background(k.card).Border(1, border).Key("secbody-" + g.sec.ID).Transition(foldTransition)
				if g.sec.ID == store.SectionInbox {
					elevated(body, k, true)
				}
				if shift := off - 4; shift > 0 {
					body.Translate(0, -shift)
				}
				body.Children(func() {
					if bw := body.Bounds().W; bw > 0 {
						a.listBodyW = bw // 卡片样式按它量正文折行
					}
					a.rowGlide(c, k, g.sec.ID, tint, tinted)
					y := top + 26 + secPad
					skip := float32(0)
					flush := func() {
						if skip > 0 {
							ui.Box(c).Height(skip).Key("gap-" + itoa(int(y))) // 占位：跳过的行（行间无缝）
							skip = 0
						}
					}
					rowY := float32(secPad)
					for i, n := range g.open {
						rh := a.noteRowH(c, n)
						a.rowFirst, a.rowSec, a.rowY = i == 0, g.sec.ID, rowY
						if height >= 0 && !a.vis.has(y, rh) && !a.vis.has(y+shift, rh) && !a.chosen.Has(n.ID) && n.ID != a.rowDragLast {
							skip += rh
						} else {
							flush()
							a.noteCard(c, k, n)
						}
						y += rh
						rowY += rh
					}
					flush()
					if len(g.done) > 0 {
						a.doneRow(c, k, g)
					}
				})
			})
		})
	})
	if height < 0 { // 高度不可预知：之后的分组全部真实构建，避免占位算错漏卡
		a.vis = visWindow{top: -1e9, bottom: 1e9}
		return 0
	}
	return height
}

func (a *app) doneRow(c *ui.Context, k tokens, g noteGroup) {
	open := a.doneOpen[g.sec.ID]
	r := ui.Row(c).Height(18).Padding(2, 4).Gap(4).AlignItems(ui.Center).Key("done-" + g.sec.ID)
	r.Children(func() {
		foldChevronSized(c, !open, 10, k.muted)
		text(c, tr("已完成 ")+itoa(len(g.done)), 10, 14, 400, k.muted)
	})
	if r.Clicked() {
		a.doneOpen[g.sec.ID] = !open
	}
	if open {
		ui.Column(c).Gap(4).Key("done-body-" + g.sec.ID).Transition(foldTransition).Children(func() {
			for _, n := range g.done {
				a.noteCard(c, k, n)
			}
		})
	}
}

// cardTitle 同 Tauri NoteCard typeLabel：图片 ×n / 图文 ×n / 链接 / 代码语言 / 文本。
func cardTitle(n store.Note) string {
	imgs := len(n.MediaFiles())
	switch {
	case n.Kind == "image" && imgs > 1:
		return fmt.Sprintf(tr("图片 ×%d"), imgs)
	case n.Kind == "image":
		return tr("图片")
	case imgs > 0:
		return fmt.Sprintf(tr("图文 ×%d"), imgs+1)
	case n.Kind == "link":
		return tr("链接")
	case isCode(n):
		return tr(codehl.Label(n.CodeLang))
	}
	return tr("文本")
}

// isCode：代码卡（同 Tauri 以 codeLang 判定；旧数据 kind=code 也算）。
func isCode(n store.Note) bool { return n.CodeLang != "" || n.Kind == "code" }

func (a *app) noteCard(c *ui.Context, k tokens, n store.Note) {
	idx, ok := a.noteIdx[n.ID]
	if !ok {
		idx = -1
	}
	focused := idx >= 0 && idx == a.selected && a.focusList && a.kbFocus // 只有键盘移来的焦点才常显操作钮；鼠标点选后移走即隐藏
	checked := a.chosen.Has(n.ID)
	compact := a.store.Settings().CardDensity == "compact"
	// 竖版笔记页（用户 2026-11-17 定）：分组是一个大边框，里面一行一条，不再是带彩色通栏的独立卡片；
	// 通栏样式只留在横版（hbar.go）。点一行 = 在框里选中（主色浅底），悬停浅底 + 操作钮，键盘焦点同悬停。
	first := a.rowFirst
	a.rowFirst = false
	sec, rowY := a.rowSec, a.rowY
	a.rowSec = ""
	style := a.listStyle()
	cardStyle := !compact && isCardStyle(style)
	var lay cardLayout
	rowH := a.cardHeight()
	if cardStyle {
		style = cardStyleFor(n, style)
		lay = a.cardLayoutOf(c, n, style)
		rowH = lay.h
	}
	if a.rowDragLast == n.ID {
		rowH = dragRowH
	}
	box := ui.Row(c).Radius(rr(9)).AlignItems(ui.Center).Key(n.ID)
	if box.Dragging() || a.rowDragLast == n.ID || (a.rowSettle == n.ID && dragNow().Before(a.rowSettleUntil)) {
		box.Height(box.AnimateTo("h", rowH, springControl)) // 拖起 / 放下时行高弹簧收放，下面的行跟着平滑让位
	} else {
		box.Height(rowH) // 平时不挂动画（常驻的高度动画会让行一直处在动画态）
	}
	hovered := box.Hovered()
	a.bandHover(n.ID, hovered)
	p := stok(c).primary
	// 行底：平常透明（分组的滑动浅底从下面透上来），选中为主色浅底。遮罩色按「卡片底 + 浅底」合成，与看到的颜色一致
	base := k.card
	if checked {
		base = p.Mix(k.card, 0.88)
	}
	base = box.AnimateColor("row-bg", base, tweenTw)
	if checked {
		box.Background(base)
	}
	box.AnimatePose(ui.Pose{Scale: pressScale(box.Pressed(), 0.985)}, tweenControl)
	dragging := box.Dragging()
	if dragging { // 拖起：原位淡出；跟手副本（框架按本元素画）带卡片底 + 细边 + 浮起阴影（同原型 .ghost / .lifting）
		if a.dockFor != n.ID {
			a.dockFor, a.dockPage = n.ID, 0
		}
		a.rowDragID = n.ID
		box.Background(ui.RGBA(0, 0, 0, 0)).Opacity(0.4).Cursor(ui.CursorGrabbing) // 行本身透明（选中底也去掉）：跟手副本只剩一行小卡（dragMini）
	} else if hovered && !n.Done && a.page == pageNotes {
		box.Cursor(ui.CursorGrab)
	}
	box.ContextMenu(func(m *ui.Menu) {
		if idx >= 0 {
			a.selected = idx
		}
		a.cardMenu(c, m, max(idx, 0), n)
	})
	// 拖拽排序（同 Tauri dnd-kit）：拖起一行，放到另一行上 = 插到它前面（可跨分组）；放到分组头 / 侧栏分组 = 移入该组
	if a.titleEditID != n.ID && a.tagEditID != n.ID && !n.Done { // 同 Tauri useSortable({disabled: note.done})
		box.Drag(noteDrag{n.ID})
	}
	dropOver := false
	if !a.autoSorted(n.Section) {
		if d, ok := ui.DragOver[noteDrag](box); ok && d.id != n.ID {
			dropOver = true
		}
		if d, ok := ui.Drop[noteDrag](box); ok && d.id != n.ID {
			for _, x := range a.dragNotes(d.id) { // 多选整组按顺序插到它前面
				if x.ID != n.ID {
					_ = a.store.MoveNoteBefore(x.ID, n.ID)
				}
			}
		}
	}
	box.Children(func() {
		if dragging { // 拖动中：整行内容换成一行小卡（用户 2026-11-17：整张卡跟手会挡住分组坞）
			a.dragMini(c, k, n, box.Bounds().W)
			return
		}
		if dropOver {
			ui.Box(c).Absolute().Top(-1).Left(6).Right(6).Height(2).Radius(1).Background(p).PassThrough()
		}
		if compact {
			a.compactCard(c, k, n, hovered || focused, a.compactHover(c, box, n))
			a.cardOverlays(c, k, n, false, true)
			a.quickBadge(c, k, idx, 12)
			a.cardGrip(c, k, n, 9)
			return
		}
		active := hovered || focused
		if active && sec != "" && !checked {
			a.glideNext = rowGlideAt{sec: sec, y: rowY, h: rowH}
		}
		if !first { // 行间细分隔线：从文字起点开始（图标列不画），悬停 / 选中的行盖住它
			ui.Box(c).Absolute().Top(0).Left(a.listTextX()).Right(12).Height(1).Background(k.fg.Alpha(0.06)).PassThrough()
		}
		headMid := float32(listRowH) / 2 // 头行中线：操作条、快捷键角标、拖动把手都对齐它
		if cardStyle {
			a.cardRow(c, k, n, lay, style, active)
			headMid = cardPadY + cardHeadH/2
			if style == listHero && lay.media {
				headMid += lay.mediaH + 8
			}
		} else if two := a.listRow(c, k, n, active); two {
			headMid = 8 + 9
		}
		if n.Blur {
			blurOverlay(c, k, 16)
		}
		if active && !dragging {
			a.rowToolbar(c, k, n, base, !checked, headMid-12) // 选中行没有悬停浅底（滑动浅底不进选中行）
		}
		if hovered && !dragging && !n.Done && a.page == pageNotes && a.query == "" { // 悬停露出拖动把手：这一行可以拖
			ui.Box(c).Absolute().Left(0).Top(headMid-8).Size(11, 16).Center().PassThrough().Key("row-grip").
				Transition(ui.ElementTransition{Animation: &tweenTw, Enter: &ui.Motion{X: 3}, Exit: &ui.Motion{X: 3}}).
				Children(func() { licon(c, "grip-vertical", 12, k.muted.Alpha(0.7)) })
		}
		a.cardOverlays(c, k, n, false, false) // 舒适行：投递状态带带文字胶囊（发送中… / 回执 + 撤销）
		a.quickBadge(c, k, idx, headMid-8)
		a.cardGrip(c, k, n, headMid-11)
	})
	clk, dbl, mods := cardPressed(box, n.ID) // 正文是拖出源，点在正文上也算点卡片
	if clk && !(mods&ui.Shift != 0 && a.rangeSelect(n.ID)) {
		a.cardClick(n.ID, idx, mods)
	}
	if dbl && idx >= 0 {
		a.cardDoubleClick(n, idx, false)
	}
}

type rowGlideAt struct {
	sec  string
	y, h float32
}

// rowGlide：分组里唯一的一块悬停浅底，跟着指针在行间弹簧滑动（不是每行各自闪现）；移出分组时原地淡出。
// sectionTint：分组颜色（未设色返回 false）。
func sectionTint(s store.Section) (ui.Color, bool) {
	if s.Color == "" {
		return ui.Color{}, false
	}
	return hexColor(s.Color), true
}

func (a *app) rowGlide(c *ui.Context, k tokens, sec string, tint ui.Color, tinted bool) {
	on := a.glideHov.sec == sec
	bg := k.fg.Alpha(0.05)
	if tinted {
		bg = tint.Alpha(map[bool]float32{true: 0.16, false: 0.09}[k.dark])
	}
	a.glideBg = bg
	b := ui.Box(c).Absolute().Left(secPad).Right(secPad).Radius(rr(9)).Background(bg).PassThrough().Key("glide-" + sec)
	if on {
		a.rowGlideLast[sec] = a.glideHov
	}
	last := a.rowGlideLast[sec]
	b.Top(b.AnimateTo("y", last.y, springControl)).Height(b.AnimateTo("h", max(last.h, 1), springControl)) // 卡片行高不一：高度也跟着弹
	b.Opacity(b.AnimateTo("op", map[bool]float32{true: 1}[on], tweenTw))
}

const (
	listRowH  = 52 // 竖版舒适密度行高：8 + 标题行 18 + 次行 18 + 8
	listPadX  = 12
	listIcon  = 18
	listTile  = 36 // 行首方块 / 右端缩略图：统一这一个尺寸
	listLeadW = 40 // 方块列宽：方块 + 多图叠放外扩 4
	listGap   = 10
)

// listRow：竖版行（用户 2026-11-17 重设计）。两条对齐线：
//   - 左：图标与标题同一行居中，次行（摘要 / 来源 / 标签）与标题左缘对齐
//   - 右：标题行右端是时间（悬停时换成操作条），次行右端是建议分组 / 常用 / 发送次数
//
// 没有次行内容时整行只留一行、垂直居中，不留半空的第二行。返回是否两行。
func (a *app) listRow(c *ui.Context, k tokens, n store.Note, active bool) bool {
	preview := a.listPreview(n)
	alias := a.aliasCount(n)
	meta := n.Provenance != nil || alias > 0 || len(n.Tags) > 0
	_, sug := a.inboxSug[n.ID]
	sug = sug && n.Section == store.SectionInbox
	busy := a.aiBusy == n.ID
	code := isCode(n) && !n.Blur
	two := preview != "" || meta || sug || n.Kept || n.SendCount > 0 || busy || code
	timeCell := func() {
		t := text(c, ago(n.CreatedAt, a.now()), 10.5, 18, 400, k.muted).SingleLine().Shrink(0).Key("row-time")
		op := float32(1)
		if active || a.bandFor(n.ID) != nil {
			op = 0 // 让位给操作条 / 投递胶囊（只淡出不移除，标题不重排）
		}
		t.Opacity(t.AnimateTo("op", op, tweenTw))
	}
	ui.Row(c).Fill().Padding(0, listPadX).Gap(listGap).AlignItems(ui.Center).Children(func() {
		style := a.listStyle()
		thumb := a.listThumbOf(n)
		trailing := style == listTrail || style == listMail // 缩略图放右端
		switch style {
		case listTiles, listFilm, listAvatar:
			round := style == listAvatar
			ui.Box(c).Size(listLeadW, listLeadW).Shrink(0).Key("row-lead").Children(func() {
				if thumb != nil {
					a.listThumbStack(c, k, n, thumb, active, round)
					return
				}
				a.listTileIcon(c, k, n, active, round)
			})
		case listTrail: // 左列恒为小应用图标，与标题行对齐
			lead := ui.Box(c).Size(listIcon, listIcon).Shrink(0).Key("row-lead")
			if two {
				lead.Margin(0, 0, 18, 0)
			}
			lead.AnimatePose(ui.Pose{Scale: map[bool]float32{true: 1.1, false: 1}[active]}, springControl)
			lead.Children(func() { a.listLead(c, k, n) })
		}
		inlineIcon := (style == listMail && !n.Blur) || (thumb != nil && style != listTrail) // 次行行首的 13 小应用图标
		ui.Column(c).Grow(1).Basis(0).Clip().Children(func() {
			ui.Row(c).Height(18).Gap(8).AlignItems(ui.Center).Children(func() {
				if a.cardInlineInputOn(c, k, n, k.fg) {
					return
				}
				a.listTitle(c, k, n)
				timeCell()
			})
			if !two {
				return
			}
			ui.Row(c).Height(18).Gap(6).AlignItems(ui.Center).Children(func() {
				a.aiBusyMark(c, k, n.ID) // 含「取消」钮：放行首，位置不随悬停变
				if ic := a.appIcon(n.BundleID); inlineIcon && ic != nil {
					ui.Image(c, ic).Size(13, 13).Shrink(0)
				}
				if code {
					text(c, cardTitle(n), 9.5, 14, 500, k.muted).Font(fontMono).Padding(0, 4).Radius(4).Background(k.track).Shrink(0)
				}
				// 状态小标排在次行起点（与标题左缘对齐），摘要跟在后面占满剩余宽度
				if a.bandFor(n.ID) == nil {
					if n.Kept {
						tipOf(c, liconFilled(c, "star", 11, amber400).Shrink(0), tr("常用"))
					}
					a.inboxSugChip(c, k, n)
					a.sentChip(c, k, n)
				}
				if style == listFilm && thumb != nil && len(n.MediaFiles()) > 1 { // 胶片：多图行次行是一排小缩略
					a.filmStrip(c, k, n)
					return
				}
				if meta {
					a.cardFooterLeadOpt(c, k, n, a.appIcon(n.BundleID) == nil)
				} else {
					text(c, preview, 11.5, 18, 400, k.muted).SingleLine().Grow(1).Basis(0)
				}
			})
		})
		if trailing && thumb != nil {
			ui.Box(c).Size(listLeadW, listLeadW).Shrink(0).Key("row-trail").Children(func() {
				a.listThumbStack(c, k, n, thumb, active, false)
			})
		}
	})
	return two
}

// listPreview：次行摘要——标题之外还能看到的那部分：正文第二行起 / 链接域名 / 图片备注；
// 都没有时，取不到应用图标的写「来自 X」。
func (a *app) listPreview(n store.Note) string {
	if n.Blur || n.Kind == "secret" {
		return ""
	}
	out := ""
	switch {
	case n.Kind == "link":
		if strings.TrimSpace(n.Title) != "" || n.LinkTitle != "" {
			out = linkHost(n.Text)
		}
	case n.Kind == "image":
		out = cardImageMeta(n) // 尺寸「W × H」或「N 张」
		if s := strings.TrimSpace(imageNoteText(n)); s != "" && !store.IsImagePlaceholder(s) && strings.TrimSpace(n.Title) != "" {
			out = firstLine(s) + " · " + out
		}
	case strings.TrimSpace(n.Title) != "":
		out = firstLine(n.Text)
	default:
		t := strings.TrimSpace(n.Text)
		if i := strings.IndexByte(t, '\n'); i >= 0 {
			out = strings.Join(strings.Fields(t[i+1:]), " ")
		}
	}
	if n.SourceApp != "" && a.appIcon(n.BundleID) == nil { // 取不到应用图标：来源写成文字放在摘要前
		out = strings.TrimSuffix(tr("来自 ")+n.SourceApp+" · "+out, " · ")
	}
	return preview(out, 160)
}

// rowToolbar：悬停 / 键盘焦点时挂在标题行右端的操作条（换掉时间的位置）。左侧一段与行底同色的渐隐遮住标题尾部，
// 条本身是浮起的胶囊，从右侧 6pt 处滑入淡显。
func (a *app) rowToolbar(c *ui.Context, k tokens, n store.Note, under ui.Color, lit bool, top float32) {
	// 遮罩与操作条是两个独立的绝对定位兄弟：遮罩穿透点击，只有按钮本身接收点击（包一层容器会把行的点击吞掉）
	cnt := 5
	if a.aliasCount(n) > 0 {
		cnt = 6
	}
	barW := float32(cnt*22 + 4 + 2)
	right := float32(8)
	if (a.listStyle() == listTrail || a.listStyle() == listMail) && a.listThumbOf(n) != nil {
		right = listPadX + listLeadW + 6 // 右端是缩略图：操作条停在它左边，不盖图
	}
	in := ui.ElementTransition{Animation: &springControl, Enter: &ui.Motion{X: 6}, Exit: &ui.Motion{X: 4}}
	// 遮罩按行的实际叠法分两层：先渐变到卡片底（或选中底），再叠一层同样渐变的 5% 前景色（= 悬停浅底），颜色与旁边严丝合缝
	ui.Box(c).Absolute().Right(right+barW).Top(top).Size(28, 24).Gradient(under.Alpha(0), under, 90).PassThrough().Key("row-tools-fade").
		Transition(ui.ElementTransition{Animation: &springControl, Enter: &ui.Motion{}, Exit: &ui.Motion{}}).Children(func() {
		if !lit {
			return
		}
		ui.Box(c).Absolute().Left(0).Top(0).Right(0).Bottom(0).Gradient(a.glideBg.Alpha(0), a.glideBg, 90).PassThrough() // 与悬停浅底同色（分组色也对得上）
	})
	bar := ui.Row(c).Absolute().Right(right).Top(top).Height(24).Padding(0, 2).Radius(rr(8)).AlignItems(ui.Center).Background(k.card).
		Border(1, k.inputBorder).Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 14, -6, k.floatShadowB).Key("row-tools").Transition(in)
	bar.Children(func() {
		a.noteActions(c, k, n, func(key, icon, tip string, danger bool) ui.Element {
			return ghostIconButton(c, k, key, icon, tip, 22, 12, danger, true)
		})
	})
}

// listTitle：自定义标题 > 链接标题 > 图片备注 > 正文首行；代码用等宽；搜索命中高亮；已完成划线。
func (a *app) listTitle(c *ui.Context, k tokens, n store.Note) {
	title := strings.TrimSpace(n.Title)
	switch {
	case n.Blur:
		title = cmpOr(title, tr("已模糊"))
	case title != "":
	case n.Kind == "link":
		title = cmpOr(n.LinkTitle, linkHost(n.Text))
	case n.Kind == "image":
		title = cardTitle(n)
		if s := strings.TrimSpace(imageNoteText(n)); s != "" && !store.IsImagePlaceholder(s) {
			title = firstLine(s)
		}
	default:
		title = cmpOr(firstLine(n.Text), cardTitle(n))
	}
	t := doneText(highlightText(c, k, title, a.query, 12.5, 18, k.fg).FontWeight(500).SingleLine().Grow(1).Basis(0), k, n)
	if isCode(n) && n.Title == "" && !n.Blur {
		t.Font(fontMono).FontSize(11.5)
	}
}

// cardClick 同 Tauri NoteCard onClick：⌘ 累加 / 移出多选；单击唯一已选的那张取消；其余单选（卡面出选中柔光）。
// 双击发送的第一击会把多选塌成单选，先留档给 cardDoubleClick 找回整组。
func (a *app) cardClick(id string, idx int, mods ui.Modifiers) {
	a.anchorID = id
	if a.chosen.Len() >= 2 && a.chosen.Has(id) {
		a.multiStash, a.multiStashAt = slices.Collect(a.chosen.All()), time.Now()
	}
	switch {
	case mods&ui.Cmd != 0:
		if a.chosen.Has(id) {
			a.chosen.Remove(id)
		} else {
			a.chosen.Add(id)
		}
	case a.chosen.Len() == 1 && a.chosen.Has(id):
		a.chosen.Clear()
	default:
		a.chosen.Clear()
		a.chosen.Add(id)
	}
	if idx >= 0 {
		a.selected, a.focusList, a.kbFocus = idx, true, false
	}
}

// cardDoubleClick 同 Tauri：双击直发该卡；双击落在刚才的多选集合里则整组发送。
// 剪贴卡在详情窗开着时追加进那张卡（编辑中进草稿，光标落末尾；含图片），见 sendFromList。
func (a *app) cardDoubleClick(n store.Note, idx int, clip bool) {
	a.selected = idx
	stash := a.multiStash
	a.multiStash = nil
	if len(stash) >= 2 && time.Since(a.multiStashAt) < 600*time.Millisecond && slices.Contains(stash, n.ID) {
		var group []store.Note
		for _, x := range a.notes {
			if slices.Contains(stash, x.ID) {
				group = append(group, x)
			}
		}
		a.chosen.Clear()
		a.sendFromList(group)
		return
	}
	a.chosen.Clear()
	a.sendFromList([]store.Note{n})
}

// elevated 按 on 在 150ms 内淡入 / 淡出 elevation-2（贴身影 + 环境影 + 顶缘高光）。
func elevated(e ui.Element, k tokens, on bool) {
	pick := func(key string, col ui.Color) ui.Color {
		if !on {
			col = col.Alpha(0)
		}
		return e.AnimateColor(key, col, tweenTw)
	}
	if k.th.Elevation(e, pick) { // 主题自己的抬升画法
		return
	}
	e.Shadow(0, 1, 2, 0, pick("e2a", k.floatShadowA)).Shadow(0, 6, 16, -4, pick("e2b", k.floatShadowB)).InsetShadow(0, 1, 0, 0, pick("e2i", k.floatInset))
}

// cardOverlays 画卡面之上的选中柔光（.list-selection-glow）与捕获闪烁（flash-highlight：琥珀 30% → 透明，1800ms ease-out）。
func (a *app) cardOverlays(c *ui.Context, k tokens, n store.Note, checked, compact bool) {
	a.deliveryBandOverlay(c, k, n.ID, compact)
	r := k.th.CardRadius(10)
	if checked {
		glow := float32(24)
		if compact {
			glow = 8
		}
		selectionGlow(c, k, r, glow)
	}
	if n.ID != a.flashID {
		return
	}
	if a.flashAt.IsZero() {
		a.flashAt = c.Now()
	}
	t := float32(c.Now().Sub(a.flashAt)) / float32(flashDur)
	if t >= 1 {
		a.flashID = ""
		return
	}
	amber := oklch(0.72, 0.15, 60, 0.3)
	op := 1 - easeMOut(t)
	if c.Preferences().ReduceMotion { // 减弱动效：静态 22% 琥珀底，同样 1.8s 后撤掉
		amber, op = oklch(0.72, 0.15, 60, 0.22), 1
	}
	c.AnimationFrame()
	ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Radius(r).Background(amber).Opacity(op).PassThrough()
}

const flashDur = 1800 * time.Millisecond

// compactCard 是紧凑密度的单行卡（Tauri cardDensity=compact：40 高，左侧拖拽把手，单行省略，悬停操作钮垂直居中）。
func (a *app) compactCard(c *ui.Context, k tokens, n store.Note, hovered, active bool) {
	ui.Box(c).Size(18, 18).Margin(0, 0, 0, 4).Padding(2).Opacity(0.6).Children(func() { licon(c, "grip-vertical", 14, k.muted.Alpha(0.5)) })
	ui.Row(c).Grow(1).Basis(0).Padding(0, 8).Gap(6).AlignItems(ui.Center).Children(func() {
		if !(n.Kind == "link" && a.favicon(n.LinkIcon) != nil) {
			a.sourceIcon(c, n, 20)
		}
		line := strings.Join(strings.Fields(previewCap(n.Text)), " ")
		if n.Blur {
			line = ""
		}
		files := n.MediaFiles()
		if n.Kind == "image" { // 同 Tauri imageListLabel：真实备注优先，否则「图片 ×N」
			line = cardTitle(n)
			if s := strings.TrimSpace(imageNoteText(n)); s != "" && !store.IsImagePlaceholder(s) {
				line = s
			}
		}
		if len(files) > 0 && !n.Blur { // 带图行：首图 24pt 缩略
			if img := a.thumb(files[0]); img != nil {
				iw, ih := ui.ImageSize(img)
				ui.Image(c, img).Size(min(24*iw/max(ih, 1), 40), 24).Radius(4)
			}
		}
		if n.Kind == "link" && !n.Blur {
			a.linkFavicon(c, n, 16)
			if n.LinkTitle != "" {
				line = n.LinkTitle
			}
		}
		a.marqueeLine(c, n.ID, active, func() ui.Element { // 悬停行文字溢出时跑马灯（同 Tauri MarqueeLine）
			switch title := strings.TrimSpace(n.Title); {
			case title != "" && !n.Blur: // 同 Tauri CompactRow：命名过的卡「标题 — 摘要」，摘要淡色
				spans := []ui.Span{{Text: title, Weight: 500, Color: k.fg}}
				if line != "" {
					spans = append(spans, ui.Span{Text: " — " + line, Color: k.muted})
				}
				return doneText(ui.RichText(c, spans...).Font(fontSans).FontSize(11).FixedLineHeight(16), k, n)
			case isCode(n):
				return doneText(highlightText(c, k, line, a.query, 10.5, 15, k.fg).Font(fontMono), k, n)
			}
			return doneText(highlightText(c, k, line, a.query, 11, 16, k.fg), k, n)
		})
		if !hovered { // 尾部元数据，悬停让位给操作钮
			a.inboxSugChip(c, k, n) // 收件箱：建议分组
			if n.Kept {
				liconFilled(c, "star", 12, amber400).Shrink(0)
			}
			if n.Provenance != nil {
				tipOf(c, licon(c, "link-2", 12, stok(c).primary).Shrink(0), tr("来自发送结果"))
			}
			if n.Kind != "image" && len(files) > 0 { // 同 Tauri CompactRow「N图」
				text(c, fmt.Sprintf(tr("%d图"), len(files)), 10, 14, 400, k.muted).Shrink(0)
			}
		}
	})
	if n.Blur {
		blurOverlay(c, k, 16)
	}
	if hovered {
		a.cardActionsAt(c, k, n, 9)
	}
}

// cardActions 是悬停时出现在卡片右下角的浮动操作钮组（22×22，间距 2）。
func (a *app) cardActions(c *ui.Context, k tokens, n store.Note) {
	a.cardActionsAt(c, k, n, 4+a.bandLift(n.ID, false))
}

func (a *app) cardActionsAt(c *ui.Context, k tokens, n store.Note, bottom float32) {
	right := float32(8)
	if bottom == 9 { // 紧凑行：垂直居中
		right = 4
	}
	fade := ui.ElementTransition{Duration: 100 * time.Millisecond, Ease: easeTw, Enter: &ui.Motion{}, Exit: &ui.Motion{}} // reveal="hover-focus"：opacity 100ms
	ui.Row(c).Absolute().Right(right).Bottom(bottom).Gap(2).Key("acts").Transition(fade).Children(func() {
		a.noteActions(c, k, n, func(key, icon, tip string, danger bool) ui.Element {
			return floatIconButton(c, k, key, icon, tip, danger, false)
		})
	})
}

// noteActions：卡片 / 行的操作钮（同 Tauri 顺序：发送 · [恢复化名] · 预览 / 打开页面 · 编辑 · 模糊 · 删除），mk 决定按钮外观。
func (a *app) noteActions(c *ui.Context, k tokens, n store.Note, mk func(key, icon, tip string, danger bool) ui.Element) {
	{
		link := noteLink(n)
		alias := a.aliasCount(n) > 0
		// 同 Tauri 顺序：发送 · [恢复化名] · 预览 / 打开页面 · 编辑 · 模糊 · 删除
		for _, act := range []struct{ icon, tip string }{
			{"send", "发送到对话（双击卡片同效）"}, {"venetian-mask", "恢复化名"}, {"expand", "预览（Space）"}, {"pencil", "编辑"}, {"eye-off", "模糊内容"}, {"trash-2", "删除"},
		} {
			if act.icon == "venetian-mask" && !alias {
				continue
			}
			if act.icon == "expand" && link != "" { // 同 Tauri openPreview：链接卡打开网页
				act.icon, act.tip = "external-link", "打开页面（Space）"
			}
			if act.icon == "pencil" && n.Kind == "image" {
				act.tip = "添加文字备注"
				if imageNoteText(n) != "" {
					act.tip = "编辑文字备注"
				}
			}
			if act.icon == "eye-off" && n.Blur {
				act.icon, act.tip = "eye", "取消模糊"
			}
			b := mk("na-"+act.icon, act.icon, tr(act.tip), act.icon == "trash-2")
			if b.Clicked() {
				switch act.icon {
				case "send": // 同 Tauri sendSelfOrChecked：在多选里就发整组
					a.sendFromList(a.clipMoveTargets(n))
				case "venetian-mask":
					a.restoreCardAliases(n)
				case "expand":
					a.openDetail(n)
				case "external-link":
					_ = exec.Command("/usr/bin/open", link).Start()
				case "pencil":
					a.editInDetail(n)
				case "eye-off", "eye":
					_ = a.store.SetBlur(n.ID, !n.Blur)
				case "trash-2":
					a.deleteSelfOrChosen(n)
				}
			}
		}
	}
}

// codeText：卡面代码着色（同 Tauri 卡面 highlightCode，只算可见头部 600 字节）。
// codeText：代码卡卡面着色；搜索时让位给命中高亮（同 Tauri note.codeLang && !query），完成态弱化。
func (a *app) codeText(c *ui.Context, k tokens, n store.Note, lines int) {
	if a.query != "" {
		doneText(highlightText(c, k, n.Text, a.query, 11, 16.5, k.fg).Font(fontMono).Wrap().MaxLines(lines), k, n)
		return
	}
	doneText(ui.RichText(c, codeSpans(k, n.Text, n.CodeLang, 600)...).Font(fontMono).FontSize(11).FixedLineHeight(16.5).Wrap().MaxLines(lines), k, n)
}

func codeSpans(k tokens, src, lang string, limit int) []ui.Span {
	if limit > 0 && len(src) > limit {
		cut := limit
		for cut > 0 && !utf8.RuneStart(src[cut]) {
			cut--
		}
		src = src[:cut]
	}
	toks := codehl.Highlight(src, lang)
	spans := make([]ui.Span, len(toks))
	for i, t := range toks {
		col := k.fg
		switch t.Kind {
		case codehl.Keyword:
			col = k.codeKeyword
		case codehl.String:
			col = k.codeString
		case codehl.Number:
			col = k.codeNumber
		case codehl.Comment:
			col = k.muted
		}
		spans[i] = ui.Span{Text: t.Text, Color: col}
	}
	return spans
}

func isWord(b byte) bool {
	return b == '_' || b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}

func (a *app) hintsRow(c *ui.Context, k tokens) {
	ui.Row(c).Height(20).Margin(0, 12).Gap(10).AlignItems(ui.Center).Children(func() { a.hintItems(c, k) })
}

func (a *app) hintItems(c *ui.Context, k tokens) {
	ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
		for _, h := range a.keyHints() {
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
				text(c, h[0], 10, 14, 400, k.muted).Opacity(0.7)
				text(c, h[1], 10, 14, 400, k.muted)
			})
		}
	})
}

func (a *app) composerBar(c *ui.Context, k tokens) {
	// 同 Tauri PillInput multiline：输入框随行数长高（最少 42，正文最多 6 行再内部滚动），两侧控件贴底对齐。
	// 之前外层定死 60、框定死 42，第 3 行起文字溢出到面板外。
	ui.Column(c).Shrink(0).Padding(6, 12, 12, 12).Children(func() {
		box := ui.Row(c).MinHeight(42).Padding(8, 10).Gap(6).Radius(rr(14)).Background(k.track).Border(1, k.inputBorder).
			InsetShadow(0, 1, 2, 0, k.insetShadow).AlignItems(ui.End)
		box.Children(func() { a.composerRow(c, k) })
		if files := box.DroppedFiles(); len(files) > 0 { // 拖入图片文件：暂存为草稿图（同 Tauri 输入框拖入）
			a.addDraftImages(a.importImagePaths(files), tr("没有可导入的图片"))
		}
		if box.FileDragOver() {
			box.Border(1, c.Theme().Accent)
		}
	})
}

// composerRow 是输入区内容：分组选择 · 多行输入 · 处理草稿 · 转大窗编辑。
func (a *app) composerRow(c *ui.Context, k tokens) {
	ui.Row(c).Grow(1).Gap(6).AlignItems(ui.End).Children(func() {
		pick := ui.Row(c).Height(24).Padding(0, 6).Gap(4).Radius(rr(8)).AlignItems(ui.Center)
		pc := hoverLink(pick, k)
		pick.Children(func() {
			licon(c, "folder-input", 12, pc)
			text(c, sectionName(a.composerSection()), 11, 16, 400, pc)
			licon(c, "chevron-up", 10, pc)
		})
		pick.Menu(func(m *ui.Menu) {
			for _, s := range a.store.Sections() {
				if s.ID != store.SectionClipboard && m.Item(sectionName(s)).Radio(s.ID == a.section).Chosen() {
					a.section = s.ID
					a.saveDraftState()
				}
			}
		})
		a.draftImageChips(c, k)
		ui.TextAreaBase(c, &a.draft).Bind(&a.draftIn).Grow(1).Basis(0).Margin(2, 0).Lines(1, 6).Font(fontSans).FontSize(13).FixedLineHeight(19.5).
			TextColor(k.fg).PlaceholderColor(k.muted).Placeholder(tr("添加笔记或提示词…")).
			OnPaste(a.pasteIntoDraft).
			OnTextKey(func(key ui.TextKey) bool {
				if key.Key == ui.KeyEnter && key.Mods == 0 {
					a.draft = key.Text()
					a.addDraft()
					key.SetText(a.draft)
					return true
				}
				return false
			})
		if strings.TrimSpace(a.draft) != "" { // 处理当前草稿（同 Tauri DraftInput 魔棒菜单）
			w := tipOf(c, ui.Box(c).Size(22, 22).Radius(rr(8)).Center(), tr("处理新增草稿")).Role(ui.RoleButton).Label(tr("处理新增草稿"))
			if w.Hovered() {
				w.Background(k.track)
			}
			w.Children(func() { licon(c, "wand-sparkles", 14, k.muted) })
			w.Menu(func(m *ui.Menu) {
				m.Item(tr("处理当前草稿")).Disabled(true)
				for i, op := range textOps {
					if m.Item(tr(op.label)).Chosen() {
						a.applyDraftOp(i)
					}
				}
			})
		}
		if a.iconButton(c, k, "arrow-up-right", 22, 14, tr("转大窗编辑")) { // 同 Tauri：↵ 入队，↗ 把草稿带去详情窗写
			a.expandDraft()
		}
	})
}

func (a *app) composerSection() store.Section {
	for _, s := range a.store.Sections() {
		if s.ID == a.section && s.ID != store.SectionClipboard {
			return s
		}
	}
	return store.Section{ID: store.SectionInbox}
}

// keyHints 按 Tauri keyHintsFor（src/lib/commandItems.ts）的优先级挑提示：编辑 → 搜索 → 任务页 → 秘文 → 多选 → 键盘焦点 → 默认。
func (a *app) keyHints() [][2]string {
	_, focused := a.current()
	switch {
	case a.titleEditID != "" || a.tagEditID != "" || a.taskSecRename != "": // 行内改名 / 标签输入
		return [][2]string{{"⏎", tr("保存")}, {"Esc", tr("取消")}}
	case a.page == pageTasks && a.taskOpen != "":
		return [][2]string{{"Esc", tr("收起")}, {"⌘⌫", tr("删除")}, {"⌘K", tr("命令")}}
	case a.searchOpen:
		return [][2]string{{"Esc", tr("关闭搜索")}, {"↑↓", tr("移动焦点")}}
	case a.page == pageTasks:
		return [][2]string{{"⏎", tr("记下待办")}, {"⌘K", tr("命令")}, {tr("长按 ⌥ Option"), tr("全部快捷键")}}
	case a.page == pageNotes && a.noteSub != subNotes:
		return [][2]string{{"⌘K", tr("命令")}, {tr("长按 ⌥ Option"), tr("全部快捷键")}}
	case a.chosen.Len() > 1: // 多选：合并只对 ≥ 2 张有意义
		return [][2]string{{"⌘⏎", fmt.Sprintf(tr("发送 %d 张"), a.chosen.Len())}, {"⌘M", tr("合并")}, {"⌘C", tr("复制为列表")}, {"Esc", tr("取消勾选")}}
	case a.chosen.Len() > 0:
		return [][2]string{{"⌘⏎", fmt.Sprintf(tr("发送 %d 张"), a.chosen.Len())}, {"⌘C", tr("复制为列表")}, {"Esc", tr("取消勾选")}, {"⌘K", tr("命令")}}
	case focused && a.focusList:
		return [][2]string{{"⌘⏎", tr("发送")}, {"Space", tr("预览")}, {"⏎", tr("编辑")}, {"x", tr("勾选")}, {"d", tr("完成")}}
	}
	return [][2]string{{"↑↓", tr("选卡片")}, {"⌘F", tr("搜索")}, {"⌘K", tr("命令")}, {tr("长按 ⌥ Option"), tr("全部快捷键")}}
}

// selectionBar 是勾选 ≥1 条时出现在面板最下方的批量操作条（Tauri SelectionBar，停靠形态）：
// 已选 N · 合并 · 删除 · 清除选择 · 发送 ⌘⏎ 分体钮。
func (a *app) selectionBar(c *ui.Context, k tokens) {
	n := a.chosen.Len()
	if n == 0 || a.page == pageTasks || (a.page == pageNotes && a.noteSub != subNotes) {
		return
	}
	if len(a.pending) > 0 && !a.hbar() { // 预检对话框盖住整个面板：底下的批量条不画（也免得同名的「发送」钮被误点）
		return
	}
	s := stok(c)
	bar, themed := k.th.SelectionBar(c)
	if !themed {
		bar = ui.Row(c).Margin(0, 8, 8, 8).Padding(6, 8).Gap(2).Radius(12).Background(k.floatBtn.Alpha(0.95)).Border(1, k.fg.Alpha(0.1)).
			Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).InsetShadow(0, 1, 0, 0, k.floatInset).AlignItems(ui.Center).
			Key("selection-bar").Transition(ui.ElementTransition{Duration: 160 * time.Millisecond, Ease: easeStandard, Enter: &ui.Motion{Y: 8}})
	}
	bar.Children(func() {
		text(c, fmt.Sprintf(tr("已选 %d"), n), 11, 16, 400, k.muted).FontFeatures("tnum").Padding(0, 4).SingleLine()
		ui.Spacer(c)
		act := func(icon, tip string, enabled bool) bool {
			b := tipOf(c, ui.Box(c).Size(22, 22).Radius(rr(8)).Center(), tip).Key("sel-" + icon)
			if enabled {
				if col, ok := k.th.IconFace(b, k.muted, k.fg, false); ok {
					b.Children(func() { licon(c, icon, 14, col) })
					return b.Clicked()
				}
			}
			col := k.muted
			bg := ui.Transparent
			if enabled && b.Hovered() {
				bg, col = k.hoverBg, k.fg
			}
			fadeColor(b, "bg", bg, tweenControl)
			if !enabled {
				b.Opacity(0.45)
			}
			b.AnimatePose(ui.Pose{Scale: pressScale(enabled && b.Pressed(), 0.94)}, tweenControl)
			b.Children(func() { licon(c, icon, 14, b.AnimateColor("fg", col, tweenControl)) })
			return enabled && b.Clicked()
		}
		chosen := a.chosenNotes()
		mergeTip, mixed := tr("合并笔记"), store.MergeDomainsMixed(chosen)
		switch {
		case mixed:
			mergeTip = tr("剪贴卡与笔记不能混合合并")
		case len(chosen) > 0 && chosen[0].Section == store.SectionClipboard:
			mergeTip = tr("合并为新卡（原剪贴卡保留）")
		}
		if act("merge", mergeTip, n >= 2 && !mixed) {
			a.mergeChosen(c)
		}
		if act("trash-2", tr("删除"), true) {
			a.deleteSelected(c)
		}
		if act("x", tr("清除选择"), true) {
			a.chosen.Clear()
		}
		ui.Row(c).Margin(0, 0, 0, 4).Height(24).Children(func() {
			send := ui.Row(c).Height(24).Padding(0, 8).Gap(4).Radius(rr(10), 0, 0, rr(10)).Border(1, s.btnBorder).AlignItems(ui.Center).Key("sel-send")
			fg, weight := s.btnFg, 500
			pfg, pw, pushed := k.th.PushButton(send)
			if pushed { // 主题的默认动作推钮
				fg, weight = pfg, pw
			} else {
				bg, sh := s.btn, s.btnShadow
				if send.Hovered() {
					bg = s.btnHover
				}
				if send.Pressed() {
					sh = ui.Transparent
				}
				ctl := tw(100, easeStandard)
				fadeColor(send, "bg", bg, ctl).Shadow(0, 1, 2, 0, send.AnimateColor("sh", sh, ctl))
				send.AnimatePose(ui.Pose{Y: pressY(send.Pressed())}, ctl)
			}
			label := tr("发送")
			insert := a.insertsIntoOpenCard(a.chosenNotes())
			blocked := ""
			if !insert {
				blocked = a.targetBlockedReason()
			}
			switch {
			case insert: // 目的地如实：编辑器开着时内容进卡片而非外发
				label = tr("添加到卡片")
				tipOf(c, send, tr("添加到打开的卡片光标处（有选中文字则替换）"))
			case blocked != "": // 同 Tauri disabled={!targetReady}：置灰并说明原因
				tipOf(c, send.Opacity(0.45), fmt.Sprintf(tr("发送不可用：%s"), blocked)).Label(fmt.Sprintf(tr("发送不可用：%s"), blocked))
			default:
				r, _ := a.resolution()
				send.Label(fmt.Sprintf(tr("发送到当前目标，发送方案 %s，粘贴后动作 %s"), profileName(r.Profile), enterPolicyLabel(r.Profile.EnterPolicy)))
			}
			send.Children(func() {
				k.th.DefaultRing(c)
				licon(c, "send", 12, fg)
				text(c, label, 11, 16, weight, fg)
				if pushed {
					text(c, "⌘⏎", 9, 16, 600, fg).Opacity(0.7)
				} else {
					text(c, "⌘⏎", 9, 12, 400, fg).Opacity(0.7)
				}
			})
			if send.Clicked() && blocked == "" {
				a.sendSelected()
			}
			more := ui.Box(c).Height(24).Padding(0, 4).Radius(0, rr(10), rr(10), 0).BorderWidth(1, 1, 1, 0).BorderColor(s.btnBorder).Center()
			if !k.th.PopupButton(c, more) {
				if more.Hovered() {
					more.Background(s.btnHover)
				} else {
					more.Background(s.btn)
				}
				more.Children(func() {
					ui.Box(c).Absolute().Left(0).Top(0).Bottom(0).Width(1).Background(s.inputBorder)
					licon(c, "chevron-down", 12, s.btnFg)
				})
			}
			more.Menu(func(m *ui.Menu) {
				if m.Item(tr("发送")).Chosen() {
					a.sendSelected()
				}
				if m.Item(tr("复制为列表")).Chosen() {
					a.copyChosenAsList()
				}
				if m.Item(tr("检查后发送…")).Chosen() {
					a.checkSend(a.chosenNotes())
				}
				if a.page == pageNotes && m.Item(tr("导出笔记包…")).Chosen() {
					a.exportNotes(a.chosenNotes())
				}
				m.Separator()
				a.outputModeItems(m, a.chosenNotes)
				m.Separator()
				a.profileMenuItems(m)
				m.Separator()
				a.templateMenu(m, tr("用模板发送 · 常用"), a.chosenNotes)
			})
		})
	})
}

// copyChosenAsList：勾选项按列表顺序复制为编号列表（Tauri copyNotesAsList；单条复制原文）。
func (a *app) copyChosenAsList() {
	notes := a.chosenNotes()
	if len(notes) == 0 {
		return
	}
	if a.copyNotesRich(notes) { // 含图片：文字与图片一起复制
		return
	}
	texts := make([]string, len(notes))
	for i, n := range notes {
		texts[i] = n.Text
	}
	a.copyPrivate(sendText(texts))
	if len(texts) == 1 {
		a.showHUD("ok", tr("已复制原文（未脱敏）"))
	} else {
		a.showHUD("ok", fmt.Sprintf(tr("已复制 %d 条原文为列表（未脱敏）"), len(texts)))
	}
}

// sendText 同 Tauri buildSendText：单条保持原文，多条转编号列表。
func sendText(texts []string) string {
	if len(texts) == 1 {
		return texts[0]
	}
	var b strings.Builder
	for i, t := range texts {
		if i > 0 {
			b.WriteByte('\n')
		}
		fmt.Fprintf(&b, "%d. %s", i+1, t)
	}
	return b.String()
}

// blurOverlay：卡面模糊（同 Tauri data-card-privacy）：不透明底遮住原文，中间闭眼图标；详情窗不受影响。
func blurOverlay(c *ui.Context, k tokens, icon float32) {
	ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Radius(rr(10)).Background(k.card).Center().PassThrough().Key("privacy").Children(func() {
		ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Radius(rr(10)).LinearGradient(ui.LinearGradient{From: k.track.Alpha(0.7), To: k.track.Alpha(0.4), Angle: 135})
		licon(c, "eye-closed", icon, k.muted.Alpha(0.6))
	})
}

// cardInlineInput：卡片标题栏里的就地输入（右键「重命名…」/「新标签…」），返回是否占用了标题栏。
// cardInlineInput 用通栏白字；剪贴票据头底色浅，用 cardInlineInputOn 传正文色。
func (a *app) cardInlineInput(c *ui.Context, k tokens, n store.Note) bool {
	return a.cardInlineInputOn(c, k, n, k.cardHeadText)
}

func (a *app) cardInlineInputOn(c *ui.Context, k tokens, n store.Note, fg ui.Color) bool {
	switch {
	case a.titleEditID == n.ID:
		ui.TextInputBase(c, &a.titleText).Grow(1).Font(fontSans).FontSize(11).TextColor(fg).Placeholder(tr("卡片标题，↵ 保存，留空清除")).
			Label(tr("卡片标题")).Focus().OnTextKey(func(key ui.TextKey) bool {
			switch key.Key {
			case ui.KeyEnter:
				_ = a.store.SetTitle(n.ID, key.Text())
				a.titleEditID = ""
				return true
			case ui.KeyEscape:
				a.titleEditID = ""
				return true
			}
			return false
		})
		return true
	case a.tagEditID == n.ID:
		ui.TextInputBase(c, &a.tagText).Grow(1).Font(fontSans).FontSize(11).TextColor(fg).Placeholder(tr("新标签，↵ 添加")).
			Label(tr("新标签")).Focus().OnTextKey(func(key ui.TextKey) bool {
			switch key.Key {
			case ui.KeyEnter:
				if t := strings.TrimSpace(key.Text()); t != "" && !slices.Contains(n.Tags, t) && len(n.Tags) < 8 {
					_ = a.store.SetTags(n.ID, append(slices.Clone(n.Tags), t))
				}
				a.tagEditID = ""
				return true
			case ui.KeyEscape:
				a.tagEditID = ""
				return true
			}
			return false
		})
		return true
	}
	return false
}

// newNoteIn：组内「新笔记」（同 Tauri SectionGroup addContent）——折叠则展开，落一张「新笔记」草稿卡并直接在详情窗编辑。
func (a *app) newNoteIn(sec store.Section) {
	a.section = sec.ID // 同 Tauri addContent：底部输入框的分组跟着切过去
	a.saveDraftState()
	if sec.Collapsed {
		sec.Collapsed = false
		_ = a.store.UpdateSection(sec)
	}
	n, dup, err := a.store.Add(store.Note{Section: sec.ID, Text: tr("新笔记")})
	if err != nil {
		return
	}
	a.reload()
	a.editInDetail(n)
	a.detail.editSel = [2]int{0, len([]rune(n.Text))} // 同 Tauri openNoteDetail(id, true, true)：全选占位文字，直接打字替换
	a.detail.blank = !dup                             // 关窗时一字未改就回收（已有的同名卡不动）
}

var openDetailFn func(*app, store.Note) // 测试替换（真窗口需要运行中的应用）；在 init 里赋值，避免与 runAI → startAIReview 形成初始化环

func init() { openDetailFn = (*app).openDetail }

// sectionHeadName：分组头组名（同 Tauri SectionGroup h3）——单击 220ms 后折叠 / 展开（与双击区分），双击就地改名；
// 改名框 ↵ 提交、Esc 放弃、失焦提交。
func (a *app) sectionHeadName(c *ui.Context, k tokens, s store.Section) {
	if a.headRename == s.ID {
		in := ui.TextInputBase(c, &a.headRenameText).Height(20).Width(128).Font(fontSans).FontSize(11).TextColor(k.fg).
			Label(tr("分组名称")).Focus().OnTextKey(func(key ui.TextKey) bool {
			switch key.Key {
			case ui.KeyEnter:
				a.headRenameText = key.Text()
				a.commitHeadRename()
				return true
			case ui.KeyEscape:
				a.headRename, a.headRenameFocused = "", false
				return true
			}
			return false
		})
		switch f := in.Focused(); {
		case f:
			a.headRenameFocused = true
		case a.headRenameFocused: // 上一帧还聚焦、这一帧失焦 = 点到别处
			a.commitHeadRename()
		}
		return
	}
	name := tipOf(c, ui.Row(c).Key("secname-"+s.ID).Role(ui.RoleButton).Label(sectionName(s)), fmt.Sprintf(tr("%s · 拖动调整分组顺序 · 点击折叠/展开（吸顶时回到组首） · 双击重命名"), sectionName(s)))
	name.Children(func() { text(c, sectionName(s), 11, 16, 600, k.muted).LetterSpacing(0.88).SingleLine() })
	switch {
	case name.DoubleClicked():
		a.secClickSeq++
		a.headRename, a.headRenameText, a.headRenameFocused = s.ID, sectionName(s), false
	case name.Clicked():
		a.secClickSeq++
		seq, id := a.secClickSeq, s.ID
		lpAfter(220*time.Millisecond, func() {
			a.onMain(func() {
				if a.secClickSeq != seq {
					return
				}
				if top, ok := a.stick.top[id]; ok { // 同 Tauri scrollToStartIfStuck：吸顶中点标题先回到组首
					a.noteScroll.Y = top
					return
				}
				for _, x := range a.store.Sections() {
					if x.ID == id {
						x.Collapsed = !x.Collapsed
						_ = a.store.UpdateSection(x)
					}
				}
			})
		})
	}
}

func (a *app) commitHeadRename() {
	id, name := a.headRename, strings.TrimSpace(a.headRenameText)
	a.headRename, a.headRenameFocused = "", false
	for _, s := range a.store.Sections() {
		if s.ID == id && name != "" && name != s.Name && name != sectionName(s) {
			s.Name = name
			_ = a.store.UpdateSection(s)
		}
	}
}
