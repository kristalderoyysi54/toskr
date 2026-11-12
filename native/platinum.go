package main

import (
	"github.com/egoist/mygo/ui"
)

// 配色方案 · Platinum（Mac OS 8/9 Appearance Manager）按 Tauri index.css 的 platinum 段复刻：
// 整窗不透明、直角、斜面（bevel）立体边；主面板换成经典窗框：条纹标题栏 → 文件夹页签 + 工具钮 → 内容井 → 白色列表井（经典 16px 滚动条）→ 输入框 → 状态栏。
// 盒阴影逐条照抄浏览器实测的计算值（mygo 的 Shadow / InsetShadow 与 CSS box-shadow 同语义、同叠放顺序）。

var (
	ptBlack   = ui.RGB(38, 38, 38)
	ptG200    = ui.RGB(238, 238, 238)
	ptG300    = ui.RGB(221, 221, 221)
	ptG400    = ui.RGB(204, 204, 204)
	ptG500    = ui.RGB(187, 187, 187)
	ptG600    = ui.RGB(153, 153, 153)
	ptG700    = ui.RGB(128, 128, 128)
	ptG800    = ui.RGB(102, 102, 102)
	ptMuted   = ui.RGB(85, 85, 85)
	ptWhite   = ui.RGB(255, 255, 255)
	ptLavHi   = ui.RGB(238, 238, 255)
	ptLav     = ui.RGB(204, 204, 255)
	ptLavDeep = ui.RGB(153, 153, 204)
)

func platinumTokens() tokens {
	t := lightTokens // 固定浅色
	t.window = ptG300
	t.fg, t.muted = ptBlack, ptMuted
	t.track, t.pill, t.chip = ptG400, ptG200, ptG200
	t.ok = ui.RGB(51, 153, 51)
	t.card, t.cardBottom = ptWhite, ui.Color{}
	head := srgbf(0.78298, 0.789882, 0.803686)
	t.cardHeadFrom, t.cardHeadTo, t.cardHeadText = head, head, ptBlack
	t.floatBtn, t.floatBorder = ptG300, ptBlack.Alpha(0.1)
	t.inputBorder = ptG700
	t.pillShadow, t.pillHighlight, t.insetShadow = ui.Transparent, ui.Transparent, ui.Transparent // 斜面由 ptSegTrack / ptSegThumb 画
	t.danger = ui.RGB(204, 51, 51)
	return t
}

// ptBevel：凸起斜面（左上白、右下深）。
func ptBevel(e ui.Element, dark ui.Color) ui.Element {
	return e.InsetShadow(1, 1, 0, 0, ptWhite).InsetShadow(-1, -1, 0, 0, dark)
}

func init() { // Platinum 窗口控件提示的英文（已有的键不覆盖）
	for k, v := range map[string]string{"关闭窗口": "Close window", "最大化 / 还原": "Zoom", "最小化": "Minimize"} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

// ptPaper：Help Tag 提示气泡的黄底（--paper）。
var ptPaper = ui.RGB(255, 255, 225)

// ptMul：正片叠底（同 CSS mix-blend-mode: multiply），选中卡把高亮色叠到卡面 / 通栏上而不冲淡文字。
func ptMul(a, b ui.Color) ui.Color {
	f := func(x, y uint8) uint8 { return uint8((int(x)*int(y) + 127) / 255) }
	return ui.RGBA(f(a.R, b.R), f(a.G, b.G), f(a.B, b.B), float32(a.A)/255)
}

// ptIconFace：Platinum 图标钮三态（同 [data-icon-button]）：静息无框直角；悬停 #eee 底 + #808080 框 + 斜面；
// 按下 / 开启（aria-pressed）#808080 底黑框、图标反白。返回图标该用的颜色（rest = 静息色，hot = 悬停色）。
func ptIconFace(b ui.Element, rest, hot ui.Color, on bool) ui.Color {
	b.Radius(0)
	switch {
	case on || b.Pressed():
		b.Background(ptG700).Border(1, ptBlack).InsetShadow(1, 1, 0, 0, ptMuted)
		return ptWhite
	case b.Hovered():
		b.Background(ptG200).Border(1, ptG700).InsetShadow(1, 1, 0, 0, ptWhite).InsetShadow(-1, -1, 0, 0, ptG500)
		return hot
	}
	return rest
}

// ptFloat：Platinum 浮层 / 卡面悬浮钮的底（同 .floating-surface）：灰底、斜面、2px 硬投影；边框由调用方给。
func ptFloat(b ui.Element) ui.Element {
	return b.Radius(0).Background(ptG300).InsetShadow(1, 1, 0, 0, ptWhite).InsetShadow(-1, -1, 0, 0, ptG500).
		Shadow(2, 2, 0, 0, ptBlack.Alpha(0.85))
}

// ptPush：斜面推钮（同 [data-button]）：黑框圆角 3、双层内斜面（外圈 #ddd / #777，内圈白 / #aaa），按下 #666 底反白。
// 后加的内阴影画在上面，所以先加 2px 的内圈、再加 1px 的外圈。返回文字该用的颜色。
func ptPush(b ui.Element) ui.Color {
	b.Radius(3).Border(1, ptBlack)
	if b.Pressed() {
		b.Background(ptG800).InsetShadow(2, 2, 0, 0, ptMuted).InsetShadow(-2, -2, 0, 0, ui.RGB(119, 119, 119)).
			InsetShadow(1, 1, 0, 0, ui.RGB(68, 68, 68)).InsetShadow(-1, -1, 0, 0, ui.RGB(136, 136, 136))
		return ptWhite
	}
	bg := ptG300
	if b.Hovered() {
		bg = ptG200
	}
	b.Background(bg).InsetShadow(2, 2, 0, 0, ptWhite).InsetShadow(-2, -2, 0, 0, ui.RGB(170, 170, 170)).
		InsetShadow(1, 1, 0, 0, ptG300).InsetShadow(-1, -1, 0, 0, ui.RGB(119, 119, 119))
	return ptBlack
}

// ptSegTrack：分段控件的槽（.surface-inset）：#ccc 底、圆角 3、内凹（左上 #999、右下白）。
func ptSegTrack(e ui.Element) ui.Element {
	return e.Radius(3).Background(ptG400).InsetShadow(1, 1, 0, 0, ptG600).InsetShadow(-1, -1, 0, 0, ptWhite)
}

// ptSegThumb：分段控件的选中块：#eee 底、圆角 2.4、外圈 1px 黑环 + 内斜面（左上白、右下 #999）。
func ptSegThumb(e ui.Element) ui.Element {
	return e.Radius(2.4).Background(ptG200).Shadow(0, 0, 0, 1, ptBlack).InsetShadow(1, 1, 0, 0, ptWhite).InsetShadow(-1, -1, 0, 0, ptG600)
}

// ptWell：凹陷白井（黑框 + 外侧左上灰、右下白），用于列表与输入框。
func ptWell(e ui.Element) ui.Element {
	return e.Background(ptWhite).Border(1, ptBlack).Shadow(-1, -1, 0, 0, ptG600).Shadow(1, 1, 0, 0, ptWhite)
}

// platinumPanel 是 Platinum 方案下的主面板（380 宽，坐标取自参照）。
func (a *app) platinumPanel(c *ui.Context, k tokens) {
	ui.Box(c).Fill().Background(ptG300).Children(func() { // 不透明底画在内容层，随进出场一起淡入淡出
		// 窗框：1px 黑环 + 内侧左上白、右下 #999
		ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Border(1, ptBlack).
			InsetShadow(1, 1, 0, 0, ptWhite).InsetShadow(-1, -1, 0, 0, ptG600)
		ui.Column(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Children(func() {
			a.ptTitleBar(c)
			a.ptTabRow(c, k)
			// 内容井（6,46 起，368 宽）：#ddd 底、上下黑边、内侧斜面
			ui.Column(c).Grow(1).Margin(-1, 6, 0, 6).Padding(7, 7, 7, 7).Background(ptG300).Border(1, ptBlack).
				InsetShadow(1, 0, 0, 0, ptWhite).InsetShadow(-1, -1, 0, 0, ptG600).Children(func() {
				a.ptTargetBar(c, k)
				if st := a.permState(); st == "ax" || st == "stuck" {
					ui.Column(c).Margin(6, -12, -8, -12).Children(func() { a.permissionBanner(c, k) })
				}
				if a.store.Conflict() || a.adoptErr != "" {
					ui.Column(c).Margin(6, -12, -8, -12).Children(func() { a.conflictBanner(c, k) })
				}
				if a.searchOpen {
					ui.Box(c).Height(6)
					a.searchRow(c, k)
				}
				if a.focus != nil { // 专注胶囊（同默认布局，放在内容井上方）
					ui.Column(c).Margin(6, -12, -6, -12).Children(func() { a.focusCapsule(c, k) })
				}
				well := ui.Column(c).Grow(1).Margin(6, 0, 0, 0)
				ptWell(well).Children(func() { a.ptPage(c, k) })
			})
			if a.page == pageNotes && a.noteSub == 0 {
				a.ptComposer(c, k)
			}
			a.selectionBar(c, k) // 勾选时的批量条停靠在输入框与状态栏之间
			if !a.store.Settings().KeyHintsOff {
				a.ptStatusBar(c, k)
			}
		})
	})
	if a.menuOpen {
		a.panelMenu(c, k)
	}
}

func (a *app) ptTitleBar(c *ui.Context) {
	ui.Row(c).Height(21).Padding(5, 6, 3, 6).Gap(4).DragWindow().Children(func() {
		if ptWidget(c, "close") {
			a.hidePanel()
		}
		ptStripes(c)
		text(c, "Toskr", 12, 13, 700, ptBlack).Padding(0, 3)
		ptStripes(c)
		if ptWidget(c, "zoom") { // 同 Tauri PlatinumBox zoom：复位自动高度
			a.resetPanelVertical()
		}
		if ptWidget(c, "collapse") { // 同 Tauri PlatinumBox shade：舒适 ⇄ 紧凑
			a.toggleDensity()
		}
	})
}

// ptStripes：标题栏横纹（同 .platinum-stripe：2px 一个周期，上 1px 白、下 1px #777，共 6 组；左缘白、右缘 #ccc 各 1px）。
// 逐行画实线而不是合成成一块灰：Retina 下每条线正好落在整像素上，与原版一样看得出条纹。
func ptStripes(c *ui.Context) {
	ui.Column(c).Grow(1).Basis(0).Height(12).Margin(0.5, 0, 0, 0).Children(func() {
		for i := 0; i < 6; i++ {
			ui.Box(c).Height(1).Background(ptWhite)
			ui.Box(c).Height(1).Background(ui.RGB(119, 119, 119))
		}
		ui.Box(c).Absolute().Top(0).Bottom(0).Left(0).Width(1).Background(ptWhite)
		ui.Box(c).Absolute().Top(0).Bottom(0).Right(0).Width(1).Background(ptG400)
	})
}

// ptWidget：标题栏 13×13 窗口控件（关闭 / 缩放 / 收起），同 .platinum-tbox 的五层盒阴影，自外向内：
// 外圈凹（左上 #808080、右下白）→ 1px 黑环 → 内圈凸（左上白、右下 #808080）→ 9×9 的 135° 灰渐变。
// 分层画盒而不叠 InsetShadow：带扩展量的黑环会被后面的偏移阴影盖住。按下时芯部压一层深色渐变。
func ptWidget(c *ui.Context, kind string) bool {
	return ptWidgetTip(c, kind, map[string]string{"close": tr("收起面板"), "zoom": tr("复位自动高度"), "collapse": tr("舒适 / 紧凑切换")}[kind])
}

// ptWidgetTip：同 ptWidget，提示文字由调用方给（详情窗 / 设置窗的三个框含义与主面板不同）。
func ptWidgetTip(c *ui.Context, kind, label string) bool {
	b := tipOf(c, ui.Box(c).Size(13, 13).Role(ui.RoleButton).Label(label), label).Shrink(0)
	down := b.Pressed()
	b.InsetShadow(1, 1, 0, 0, ptG700).InsetShadow(-1, -1, 0, 0, ptWhite)
	b.Children(func() {
		ui.Box(c).Absolute().Left(2).Top(2).Size(9, 9).PassThrough().
			LinearGradient(ui.LinearGradient{From: ui.RGB(154, 154, 154), To: ui.RGB(241, 241, 241), Angle: 135}).
			InsetShadow(1, 1, 0, 0, ptWhite).InsetShadow(-1, -1, 0, 0, ptG700)
		if down { // :active::after
			ui.Box(c).Absolute().Left(2).Top(2).Size(9, 9).PassThrough().
				LinearGradient(ui.LinearGradient{From: ui.RGBA(53, 53, 53, 0.8), To: ui.RGBA(156, 156, 156, 0.8), Angle: 135})
		}
		ui.Box(c).Absolute().Left(1).Top(1).Size(11, 11).Border(1, ptBlack).PassThrough()
		switch kind {
		case "zoom": // ::before：左上 6×6 的 1px 黑框
			ui.Box(c).Absolute().Left(2).Top(2).Size(6, 6).Border(1, ptBlack).PassThrough()
		case "collapse": // ::before：第 5、7 行两条黑线
			ui.Box(c).Absolute().Left(2).Top(5).Size(9, 1).Background(ptBlack).PassThrough()
			ui.Box(c).Absolute().Left(2).Top(7).Size(9, 1).Background(ptBlack).PassThrough()
		}
	})
	return b.Clicked()
}

func (a *app) ptTabRow(c *ui.Context, k tokens) {
	st := a.store.Settings()
	ui.Row(c).Height(24).Margin(2, 6, 0, 6).Padding(0, 0, 0, 8).AlignItems(ui.Stretch).Children(func() {
		ui.Row(c).Grow(1).Padding(2, 0, 0, 0).AlignItems(ui.End).Children(func() {
			for i, label := range tabLabels {
				if i == pageNotes && (st.SecretEnabled || st.MessagesEnabled) {
					label = "内容"
				}
				if i == pageTasks && st.SubscriptionsEnabled {
					label = "提醒"
				}
				on := a.page == i
				t := ui.Row(c).Width(48).Radius(5, 5, 0, 0).Justify(ui.Center).AlignItems(ui.Start).Key("pt-tab-" + label)
				if i > 0 {
					t.Margin(0, 0, 0, -1)
				}
				if on {
					t.Height(22).Padding(3, 11, 0, 11).Background(ptG300).BorderWidth(1, 1, 0, 1).BorderColor(ptBlack).
						InsetShadow(1, 1, 0, 0, ptWhite).InsetShadow(-1, 0, 0, 0, ptG600)
				} else {
					t.Height(19).Padding(1, 11, 0, 11).Background(ptG400).BorderWidth(1, 1, 1, 1).BorderColor(ptBlack).
						InsetShadow(1, 1, 0, 0, ptG200)
				}
				t.Children(func() { text(c, tr(label), 12, 16, 600, ptBlack).SingleLine() })
				if t.Clicked() && !on {
					a.switchPage(i)
				}
			}
		})
		ui.Row(c).Gap(3).Padding(0, 0, 4, 0).AlignItems(ui.Start).Children(func() {
			if a.page != pageTasks && ptToolButton(c, "search", tr("搜索（⌘F）"), a.searchOpen) { // 同 Tauri：任务页没有搜索钮
				a.searchOpen = !a.searchOpen
			}
			if ptToolButton(c, "menu", tr("更多"), a.menuOpen) {
				a.menuOpen = !a.menuOpen
			}
			if ptToolButton(c, "settings-2", tr("设置（⌘,）"), false) {
				a.openSettings()
			}
		})
	})
}

// ptToolButton：22×20 斜面工具钮（#666 描边），按下态凹陷。
// on = 开启态（aria-pressed / aria-expanded，如搜索栏开着、菜单开着）：#808080 底黑框、图标反白。
func ptToolButton(c *ui.Context, icon, tip string, on bool) bool {
	b := tipOf(c, ui.Box(c).Size(22, 20).Background(ptG300).Border(1, ptG800).Center(), tip).Role(ui.RoleButton).Label(tip)
	col := ptBlack
	switch {
	case on || b.Pressed():
		b.Background(ptG700).Border(1, ptBlack).InsetShadow(1, 1, 0, 0, ptMuted).InsetShadow(-1, -1, 0, 0, ptG600)
		col = ptWhite
	case b.Hovered():
		ptBevel(b.Background(ptG200), ptG600)
	default:
		ptBevel(b, ptG600)
	}
	b.Children(func() { licon(c, icon, 14, col) })
	return b.Clicked()
}

func (a *app) ptTargetBar(c *ui.Context, k tokens) {
	bar := ui.Column(c).Padding(0, 6).Background(ptG200).Border(1, ptG700)
	ptBevel(bar, ptG500).Children(func() {
		ui.Row(c).Height(28).AlignItems(ui.Center).Children(func() {
			ui.Row(c).Gap(6).Grow(1).AlignItems(ui.Center).Children(func() {
				ui.Box(c).Size(16, 16).Radius(1.8).Background(ptG200).Center().Children(func() { licon(c, "app-window", 8, ptMuted) })
				if a.target.PID == 0 {
					text(c, tr("未识别目标"), 11, 16, 600, ptBlack)
					return
				}
				text(c, a.target.Name, 11, 16, 600, ptBlack).SingleLine()
				text(c, "·", 10, 14, 400, ptMuted)
				ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
					ui.Box(c).Size(6, 6).Radius(3).Background(k.ok)
					text(c, tr("可发送"), 10, 14, 500, ptMuted)
				})
			})
			ui.Row(c).Gap(2).Children(func() {
				if a.iconButton(c, k, "rotate-ccw-clock", 20, 12, tr("最近发送")) {
					a.drawerOpen = !a.drawerOpen
				}
				a.lensChevron(c, k)
			})
		})
		if a.lensOpen { // 展开区收在同一个斜面框里（同 Tauri [data-target-lens] section）
			a.lensDetail(c, k)
		}
	})
}

// ptPage 是白井里的当前页；笔记页带经典滚动条。
func (a *app) ptPage(c *ui.Context, k tokens) {
	a.pageSlide(c, func(p int) { a.ptPageBody(c, k, p) })
}

func (a *app) ptPageBody(c *ui.Context, k tokens, p int) {
	switch p {
	case pageClip:
		ui.Row(c).Grow(1).AlignItems(ui.Stretch).Children(func() {
			ui.Column(c).Grow(1).Basis(0).Children(func() { a.clipPage(c, k) })
			if ptClassicScroll {
				ptScrollbar(c, &a.clipScroll)
			}
		})
	case pageTasks:
		ui.Column(c).Grow(1).Children(func() { a.tasksPage(c) })
	default:
		switch a.contentTabs(c, k) {
		case subSecret:
			ui.Column(c).Grow(1).Children(func() { a.secretsPage(c, k) })
			return
		case subMessages:
			ui.Column(c).Grow(1).Children(func() { a.messagesPage(c, k) })
			return
		}
		ui.Row(c).Grow(1).AlignItems(ui.Stretch).Children(func() {
			ui.Column(c).Grow(1).Basis(0).Children(func() { a.notesPage(c, k) })
			if ptClassicScroll {
				ptScrollbar(c, &a.noteScroll)
			}
		})
	}
}

var (
	ptArrowUp   = ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 4"><path fill="currentColor" d="M3 0h1v1H3zM2 1h3v1H2zM1 2h5v1H1zM0 3h7v1H0z"/></svg>`))
	ptArrowDown = ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 4"><path fill="currentColor" d="M0 0h7v1H0zM1 1h5v1H1zM2 2h3v1H2zM3 3h1v1H3z"/></svg>`))
	ptGripW     = ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path fill="currentColor" d="M0 0h7v1H0zM0 2h7v1H0zM0 4h7v1H0zM0 6h7v1H0z"/></svg>`))
	ptGripD     = ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path fill="currentColor" d="M1 1h7v1H1zM1 3h7v1H1zM1 5h7v1H1zM1 7h7v1H1z"/></svg>`))
)

// ptScrollbar：经典 16px 竖滚动条（左黑边 #bbb 槽 + 上下 16×16 箭头框 + 薰衣草滑块，内容放得下时无滑块）。
func ptScrollbar(c *ui.Context, s *ui.ScrollState) {
	ui.Column(c).Width(16).Background(ptG500).BorderWidth(0, 0, 0, 1).BorderColor(ptBlack).
		InsetShadow(2, 1, 0, 0, ptG700).InsetShadow(-1, -1, 0, 0, ptG300).Children(func() {
		arrow := func(svg *ui.SVG, top bool, dy float32) {
			b := ui.Box(c).Height(16).Background(ptG300)
			if top {
				b.BorderWidth(0, 0, 1, 0)
			} else {
				b.BorderWidth(1, 0, 0, 0)
			}
			b.BorderColor(ptBlack)
			ptBevel(b, ptG600).Children(func() {
				ui.Icon(c, svg).Absolute().Left(4).Top(dy).Size(7, 4).TextColor(ui.RGB(0, 0, 0))
			})
			if b.Clicked() {
				step := float32(40)
				if top {
					step = -step
				}
				s.Y = max(0, min(s.MaxY, s.Y+step))
			}
		}
		arrow(ptArrowUp, true, 5)
		track := ui.Box(c).Grow(1)
		track.Children(func() {
			if s.MaxY <= 0 {
				return
			}
			h := track.Bounds().H
			if h <= 0 {
				return
			}
			view := h + 32 // 视口 = 槽 + 上下两个 16 高箭头框
			thumb := max(16, h*view/(view+s.MaxY))
			top := (h - thumb) * s.Y / s.MaxY
			th := ui.Box(c).Absolute().Left(0).Right(0).Top(top).Height(thumb).BorderWidth(1, 0, 1, 1).BorderColor(ptBlack).
				LinearGradient(ui.LinearGradient{Stops: []ui.GradientStop{{Color: ptLavHi, At: 0}, {Color: ptLav, At: 0.45}, {Color: ptLavDeep, At: 1}}, Angle: 90}).
				InsetShadow(1, 1, 0, 0, ptWhite.Alpha(0.7)).InsetShadow(-1, -1, 0, 0, ui.RGBA(0, 0, 0, 0.25))
			th.Children(func() {
				ui.Box(c).Fill().Center().Children(func() {
					ui.Box(c).Size(8, 8).Children(func() {
						ui.Icon(c, ptGripW).Absolute().Fill().TextColor(ptWhite)
						ui.Icon(c, ptGripD).Absolute().Fill().TextColor(ptMuted)
					})
				})
			})
		})
		arrow(ptArrowDown, false, 6)
	})
}

func (a *app) ptComposer(c *ui.Context, k tokens) {
	ui.Column(c).Height(57).Padding(7, 12, 8, 12).Children(func() {
		box := ui.Row(c).Height(42).Padding(8, 10).Gap(6).AlignItems(ui.Center)
		ptWell(box).Children(func() { a.composerRow(c, k) })
	})
}

func (a *app) ptStatusBar(c *ui.Context, k tokens) {
	ui.Row(c).Height(23).Margin(0, 2, 2, 2).Padding(1, 12).Background(ptG300).BorderWidth(1, 0, 0, 0).BorderColor(ptBlack).
		InsetShadow(1, 1, 0, 0, ptWhite.Alpha(0.6)).InsetShadow(-1, -1, 0, 0, ui.RGB(170, 170, 170)).AlignItems(ui.Center).
		Children(func() { a.hintItems(c, k) })
}

// platinumSet：设置窗在 Platinum 下的底色（控件另绘）。
func platinumSet() settingsTokens {
	s := lightSet
	s.bg, s.input, s.card, s.aside = ptG300, ptWhite, ptG300, ptG300
	s.asideBorder, s.cardBorder, s.rowBorder, s.inputBorder = ptBlack, ptG600, ptG600, ptG700
	s.primary = ui.RGB(51, 51, 153)
	s.navSel, s.navSelBorder = s.primary, s.primary
	s.toggleOff, s.toggleOffBorder, s.knob, s.knobOn = ptG500, ptBlack, ptWhite, ptWhite
	s.btn, s.btnFg, s.btnBorder = ptG300, ptBlack, ptBlack
	s.primary, s.navSel, s.navSelBorder = ptHL, ptHL, ptHL
	return s
}
