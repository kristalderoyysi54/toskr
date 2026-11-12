package main

import (
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// platinumTheme：Mac OS 8/9 Platinum（Appearance Manager）主题。styleTheme 的各个接入点在这里转给
// platinum.go / platinum_settings.go 里的画法；共用界面代码不直接引用任何 pt* 名字。
type platinumTheme struct{ baseTheme }

func init() { registerTheme(platinumTheme{}) }

func (platinumTheme) ID() string    { return "platinum" }
func (platinumTheme) Label() string { return "Platinum" }
func (platinumTheme) Hint() string {
	return "Mac OS 9 经典外观：固定浅色、整窗不透明；切回现代恢复颜色、模式与毛玻璃"
}
func (platinumTheme) FixedLight() bool     { return true }
func (platinumTheme) Opaque() bool         { return true }
func (platinumTheme) SquareWindows() bool  { return true }
func (platinumTheme) RadiusScale() float32 { return 0.3 } // 同 Tauri：--radius 10px → 3px
func (platinumTheme) ClassicScroll() bool  { return ptClassicScroll }

func (platinumTheme) Apply(st store.Settings) { setPlatinumDetail(st.PtHighlight, st.PtScrollbar) }

// SettingsRows：高亮颜色、滚动条款式。
func (platinumTheme) SettingsRows(a *app, c *ui.Context, k tokens, st store.Settings) []setRow {
	save := func(fn func(*store.Settings)) {
		cur := a.store.Settings()
		fn(&cur)
		_ = a.store.SetSettings(cur)
		applyAppearance(cur)
		a.invalidateAll()
	}
	return []setRow{
		{title: tr("高亮颜色"), hint: tr("选中卡片与菜单高亮的颜色"), control: func() {
			i := max(0, slices.Index(ptHighlightNames, st.PtHighlight))
			if segmented(c, k, &i, ptHighlightLabels...) {
				save(func(x *store.Settings) { x.PtHighlight = ptHighlightNames[i] })
			}
		}},
		{title: tr("滚动条"), hint: tr("经典款带箭头和条纹滑块"), control: func() {
			i := 0
			if st.PtScrollbar == "thin" {
				i = 1
			}
			if segmented(c, k, &i, "经典 Platinum", "细条") {
				save(func(x *store.Settings) { x.PtScrollbar = []string{"classic", "thin"}[i] })
			}
		}},
	}
}

func (platinumTheme) Tokens(tokens) tokens                         { return platinumTokens() }
func (platinumTheme) SettingsTokens(settingsTokens) settingsTokens { return platinumSet() }

// LibTheme：库的提示气泡 / 吐司底色（Help Tag 黄底黑字）。
func (platinumTheme) LibTheme(t *ui.Theme) bool {
	if t.Inverse == ptPaper {
		return false
	}
	t.Inverse, t.InverseText = ptPaper, ptBlack
	return true
}

// —— 整块接管 ——

func (platinumTheme) Panel(a *app, c *ui.Context, k tokens) bool {
	a.platinumPanel(c, k)
	return true
}

func (platinumTheme) SettingsShell(a *app, c *ui.Context, k tokens, s settingsTokens, pages []setPage) bool {
	a.ptSettingsShell(c, k, s, pages)
	return true
}

func (platinumTheme) SettingsSection(c *ui.Context, k tokens, s settingsTokens, sec setSection) bool {
	ptSection(c, k, s, sec)
	return true
}

// DetailHeader：详情窗标题栏（.platinum-detail-titlebar）：灰条、底边黑线、左上白高光；
// 关闭框 · 条纹 · 居中粗体标题 · 条纹 · 斜面图标钮（来源 / 存入分组 / 固定）· 缩放框 · 收起框。
func (platinumTheme) DetailHeader(a *app, c *ui.Context, k tokens, n store.Note) bool {
	title := strings.TrimSpace(n.Title)
	if title == "" {
		title = preview(n.Text, 24)
	}
	ui.Row(c).Padding(4, 6, 3, 6).Gap(4).AlignItems(ui.Center).Background(ptG300).BorderWidth(0, 0, 1, 0).BorderColor(ptBlack).
		InsetShadow(1, 1, 0, 0, ptWhite).DragWindow().Children(func() {
		if ptWidgetTip(c, "close", tr("关闭窗口")) {
			a.closeDetailWin()
		}
		ptStripes(c)
		text(c, title, 12, 14, 700, ptBlack).SingleLine().Padding(0, 3).Shrink(1).MaxWidth(320)
		ptStripes(c)
		a.detailSourceAndSave(c, k, n)
		pinTip := tr("固定窗口：发送后保持打开，新开的卡另开一扇窗")
		if a.detail.pinned {
			pinTip = tr("取消固定（发送后恢复自动关窗）")
		}
		pin := tipOf(c, ui.Box(c).Size(20, 18).Background(ptG300).Border(1, ptG800).Center(), pinTip).Role(ui.RoleButton).Label(pinTip)
		col := ptBlack
		switch {
		case a.detail.pinned || pin.Pressed():
			pin.Background(ptG700).Border(1, ptBlack).InsetShadow(1, 1, 0, 0, ptMuted).InsetShadow(-1, -1, 0, 0, ptG600)
			col = ptWhite
		case pin.Hovered():
			ptBevel(pin.Background(ptG200), ptG600)
		default:
			ptBevel(pin, ptG600)
		}
		pin.Children(func() { licon(c, "pin", 12, col) })
		if pin.Clicked() {
			a.detail.pinned = !a.detail.pinned
		}
		win := a.detailWin
		if ptWidgetTip(c, "zoom", tr("最大化 / 还原")) && win != nil { // 缩放框：最大化 ⇄ 还原
			a.onMain(win.ToggleMaximize)
		}
		if ptWidgetTip(c, "collapse", tr("最小化")) && win != nil { // 收起框：最小化
			a.onMain(win.Minimize)
		}
	})
	return true
}

// DetailFrame：没有顶部晕光；整窗 1px 黑框（.detail-window-frame__surface 的 outline），压在内容之上。
func (platinumTheme) DetailFrame(c *ui.Context) (func(), bool) {
	return func() { ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Border(1, ptBlack).PassThrough() }, true
}

func (platinumTheme) DetailChromePinned() bool { return true } // 同 Tauri：Platinum 标题栏常驻

// SelectionBar：停靠条（[data-selection-bar="docked"]）——通栏灰底、上缘黑线、内斜面，夹在输入框与状态栏之间。
func (platinumTheme) SelectionBar(c *ui.Context) (ui.Element, bool) {
	return ui.Row(c).Margin(0, 2).Padding(8, 10, 9, 10).Gap(2).Background(ptG300).BorderWidth(1, 0, 0, 0).BorderColor(ptBlack).
		InsetShadow(1, 1, 0, 0, ptWhite.Alpha(0.7)).InsetShadow(-1, -1, 0, 0, ui.RGB(170, 170, 170)).AlignItems(ui.Center).Key("selection-bar"), true
}

// PreflightFrame：对话框形态是整面板灰底黑框内斜面；内嵌形态同目标条的斜面框（状态色只留在文字与图标上）。
func (platinumTheme) PreflightFrame(box ui.Element, sheet bool) bool {
	if sheet {
		box.Absolute().Top(0).Left(0).Right(0).Bottom(0).Padding(0).Gap(0).Radius(0).Background(ptG300).Border(1, ptBlack).
			InsetShadow(1, 1, 0, 0, ptWhite).InsetShadow(-1, -1, 0, 0, ptG600)
		return true
	}
	ptBevel(box.Radius(0).Background(ptG200).Border(1, ptG700), ptG500)
	return true
}

// Scrolled：把滚动区放进一行，右侧挂经典 16px 滚动条（细条设置下不接管）。build 里建 ui.Scroll 并 TrackScroll(s)。
func (platinumTheme) Scrolled(c *ui.Context, s *ui.ScrollState, build func()) bool {
	if !ptClassicScroll {
		return false
	}
	ui.Row(c).Fill().AlignItems(ui.Stretch).Children(func() {
		ui.Column(c).Grow(1).Basis(0).Children(build)
		ptScrollbar(c, s)
	})
	return true
}

// —— 控件：整个替换 ——

// Tooltip：Help Tag（同 Tauri [data-slot="tooltip-content"] 的 platinum 规则）——黄底黑字、1px 黑边、直角、1px 硬投影、无箭头。
// 出现时机、位置与无障碍描述同库的 Tooltip。
func (platinumTheme) Tooltip(c *ui.Context, e ui.Element, s string) bool {
	if s == "" {
		return true
	}
	e.Description(s)
	ui.TooltipBase(c, e, func(tip ui.Element) {
		tip.MaxWidth(320).Padding(6, 12).Background(ptPaper).Border(1, ptBlack).Shadow(1, 1, 0, 0, ptBlack.Alpha(0.5))
		tip.AttachTo(e, ui.AnchorTop, ui.AnchorBottom).Margin(0, 0, 6, 0)
		tip.Children(func() { text(c, s, 12, 16, 400, ptBlack).Wrap() })
	})
	return true
}

// Button：斜面推钮（同 Tauri [data-button] 的 platinum 规则：黑框圆角 3、双层内斜面、粗体字，按下 #666 底反白）。
func (platinumTheme) Button(c *ui.Context, label string) (ui.Element, bool) {
	b := ui.Row(c).Padding(6, 12).Justify(ui.Center).AlignItems(ui.Center).Role(ui.RoleButton).Label(label).Key("btn-" + label)
	fg := ptPush(b)
	b.Children(func() { text(c, label, 12, 17, 600, fg).SingleLine() })
	return b, true
}

func (platinumTheme) TextButton(c *ui.Context, label string) (bool, bool) {
	return ptButton(c, label), true
}

// Popover：浮层底（灰底、1px 黑边、直角、斜面、2px 硬投影）。
func (platinumTheme) Popover(c *ui.Context, anchor ui.Element, open *bool, fn func()) (ui.Element, bool) {
	return ui.PopoverBase(c, anchor, open, func(p ui.Element) {
		ptFloat(p.MinWidth(anchor.Bounds().W).Margin(4, 0, 0, 0).Padding(4)).Border(1, ptBlack)
		fn()
	}), true
}

// Segmented：两项为单选钮，三项以上为弹出菜单（Tauri Segmented 的 platinum 分支）。
func (platinumTheme) Segmented(c *ui.Context, sel *int, labels ...string) (bool, bool) {
	if len(labels) == 2 {
		return ptRadios(c, sel, labels...), true
	}
	return ptPopup(c, sel, labels...), true
}

func (platinumTheme) Checkbox(c *ui.Context, on *bool) (bool, bool) { return ptCheckbox(c, on), true }

func (platinumTheme) Slider(c *ui.Context, v *float64, lo, hi, step float64) (bool, bool) {
	return ptSlider(c, v, lo, hi, step), true
}

// FloatIconButton：直角斜面钮 + 2px 硬投影（.floating-surface 的 elevation-2），悬停 / 按下同图标钮三态。
func (platinumTheme) FloatIconButton(c *ui.Context, k tokens, key, icon, tip string, danger, on bool) (ui.Element, bool) {
	b := tipOf(c, ui.Box(c).Size(22, 22).Center().Key(key), tip).Role(ui.RoleButton).Label(tip)
	ptFloat(b).Border(1, ptBlack.Alpha(0.1))
	hot := ptBlack
	if danger {
		hot = k.danger
	}
	col := ptIconFace(b, ptMuted, hot, on)
	b.Children(func() { licon(c, icon, 12, col) })
	return b, true
}

func (platinumTheme) IconFace(b ui.Element, rest, hot ui.Color, on bool) (ui.Color, bool) {
	return ptIconFace(b, rest, hot, on), true
}

func (platinumTheme) PushButton(b ui.Element) (ui.Color, int, bool) { return ptPush(b), 600, true }

// PopupButton：独立的 21 宽推钮，双向箭头。
func (platinumTheme) PopupButton(c *ui.Context, b ui.Element) bool {
	arrow := ptPush(b.Width(21).Padding(0).Margin(0, 0, 0, 8).BorderWidth(1, 1, 1, 1))
	b.Children(func() { ui.Icon(c, ptPopupArrows).Size(7, 10).TextColor(arrow) })
	return true
}

// CheckGlyph：12×12 斜面方框 + 溢出框外的像素勾。
func (platinumTheme) CheckGlyph(c *ui.Context, box ui.Element, on bool) bool {
	box.Size(12, 12).Radius(0).Border(1, ptBlack)
	ptBevel(box.Background(ptG200), ptG500)
	if on {
		box.Children(func() { ui.Icon(c, ptCheckMark).Absolute().Top(-5).Left(-1).Size(14, 13).TextColor(ptBlack) })
	}
	return true
}

// KeyHint：键位是不带框的小字。
func (platinumTheme) KeyHint(c *ui.Context, label string, fg ui.Color) bool {
	text(c, label, 10, 14, 400, fg).Opacity(0.7)
	return true
}

// MenuSeparator：蚀刻分隔线，上 #999、下白。
func (platinumTheme) MenuSeparator(c *ui.Context) bool {
	ui.Column(c).Height(2).Margin(4, 0).Children(func() {
		ui.Box(c).Height(1).Background(ptG600)
		ui.Box(c).Height(1).Background(ptWhite)
	})
	return true
}

// SelectionGlow：高亮淡底由 Card / BandColors 用 ptMul 叠进卡面与通栏（库里没有混合模式，盖一层半透明会冲淡文字），这里只画 2px 高亮内框。
func (platinumTheme) SelectionGlow(c *ui.Context) bool {
	ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).PassThrough().Border(2, ptHL)
	return true
}

// Elevation：左上白 / 右下 #bbb 斜面 + 2px 硬投影。
func (platinumTheme) Elevation(e ui.Element, pick func(string, ui.Color) ui.Color) bool {
	e.InsetShadow(1, 1, 0, 0, pick("e2i", ptWhite)).InsetShadow(-1, -1, 0, 0, pick("e2j", ptG500)).Shadow(2, 2, 0, 0, pick("e2a", ptBlack.Alpha(0.85)))
	return true
}

func (platinumTheme) Etched(b ui.Element) bool {
	b.InsetShadow(1, 1, 0, 0, ptWhite).Shadow(1, 1, 0, 0, ptWhite)
	return true
}

func (platinumTheme) SelectTrigger(b ui.Element) bool {
	b.Radius(3).Border(1, ptG600)
	return true
}

// —— 控件：修饰 ——

func (platinumTheme) Well(e ui.Element)        { ptWell(e.Radius(0)) }
func (platinumTheme) SearchRow(row ui.Element) { ptWell(row.Margin(0).Padding(0, 8).Radius(0)) } // 与目标条、列表井同宽
func (platinumTheme) SegTrack(e ui.Element)    { ptSegTrack(e) }
func (platinumTheme) SegThumb(e ui.Element)    { ptSegThumb(e) }
func (platinumTheme) OptionChip(b ui.Element)  { b.Radius(10).Padding(0, 8) } // 原版是 rounded-full 胶囊，不随 --radius 变小

// Card：直角（.material-card）；选中时把高亮色正片叠底到卡面（.list-selection-glow），文字不被冲淡。
func (platinumTheme) Card(box ui.Element, checked bool) {
	box.Radius(0)
	if checked {
		box.Background(ptMul(ptWhite, ptLav))
	}
}

// CardOutline：1px #999 描边（outline-offset -1px，压在内容之上）。
func (platinumTheme) CardOutline(c *ui.Context) {
	ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Border(1, ptG600).PassThrough()
}

func (platinumTheme) CardHead(head ui.Element) {
	head.Radius(0).InsetShadow(0, -1, 0, 0, ptBlack).InsetShadow(1, 1, 0, 0, ui.RGBA(255, 255, 255, 0.6))
}

func (platinumTheme) ListRow(card ui.Element) { card.Radius(0).Border(1, ptG600) } // 直角白卡 + 1px #999 描边

// DefaultRing：默认动作钮外侧 2px 黑环（outline 2px、offset 1px）。
func (platinumTheme) DefaultRing(c *ui.Context) {
	ui.Box(c).Absolute().Top(-4).Left(-4).Right(-4).Bottom(-4).Radius(rr(6)).Border(2, ptBlack).PassThrough()
}

// PanelMenu：灰底黑边直角 + 斜面 + 硬投影，贴在 ☰ 工具钮下方（原版 [125,47] 224 宽）。
func (platinumTheme) PanelMenu(menu ui.Element) { ptFloat(menu.Top(47).Right(31)).Border(1, ptBlack) }

// LensDetail：展开区在目标条的斜面框内，浅底圆角 3。
func (platinumTheme) LensDetail(box ui.Element) {
	box.Margin(3, 0, 0, 0).Radius(3).Background(ui.RGBA(242, 242, 242, 0.3))
}

func (platinumTheme) LensButton(btn ui.Element) { btn.Padding(2, 6).Radius(2.4).Border(1, ptG600) }

// —— 取值 ——

func (platinumTheme) SheetBg() (ui.Color, bool) { return ptG300, true } // 固定浅色灰底，不随系统深色

func (platinumTheme) FloatSurface(b ui.Element) (ui.Element, bool) {
	return ptFloat(b).Border(1, ptBlack), true
}

func (platinumTheme) Line() (ui.Color, bool) { return ptG600, true }

// MenuItem：当前项是高亮色底反白；命令面板的行 25 高、圆角 2.4，面板菜单的高亮行直角。
func (platinumTheme) MenuItem(row ui.Element, kind string, active bool) (ui.Color, bool) {
	if kind == "command" {
		row.Height(25).Radius(2.4)
	}
	if !active {
		return ui.Color{}, false
	}
	if kind == "menu" {
		row.Radius(0)
	}
	row.Background(ptHL)
	return ptWhite, true
}

func (platinumTheme) Highlight() (ui.Color, ui.Color, bool) { return ptHL, ptWhite, true }

func (platinumTheme) SelectedRow(box ui.Element) (ui.Color, bool) {
	box.Radius(0)
	return ptLav, true
}

func (platinumTheme) BandColors(from, to ui.Color, checked bool) (ui.Color, ui.Color) {
	if checked {
		return ptMul(from, ptLav), ptMul(to, ptLav)
	}
	return from, to
}

// TintBand：分组色 22% 叠在 G300 上（同 Tauri .asset-band 的 platinum 规则）。
func (platinumTheme) TintBand(band ui.Color) (ui.Color, bool) { return mix(band, ptG300, 0.22), true }

func (platinumTheme) CardRadius(float32) float32 { return 0 }

// —— HUD：Balloon Help 黄底黑字（--paper #ffffe1），1px 黑描边 + 2px 硬投影 ——

func (platinumTheme) HudColors() (ui.Color, ui.Color, ui.Color, bool) {
	return ptPaper, ptBlack, ui.RGB(238, 238, 204), true
}

// HudPill（.hud-pill）：圆角 6、1px 黑环、2px 硬投影。
func (platinumTheme) HudPill(e ui.Element) bool {
	e.Radius(rr(6)).Border(1, ptBlack).Shadow(2, 2, 0, 0, ui.RGBA(0, 0, 0, 0.45))
	return true
}

// HudBalloon（.hud-balloon-shape）：沿气泡 1px 黑描边 + 2px 硬投影。
func (platinumTheme) HudBalloon(e ui.Element) bool {
	e.Shadow(0, 0, 0, 1, ptBlack).Shadow(2, 2, 0, 1, ui.RGBA(0, 0, 0, 0.45))
	return true
}

// HudTail：尾巴跟气泡同一圈 1px 黑描边 + 2px 硬投影（四向各偏 1px 的黑色剪影垫底）。
func (platinumTheme) HudTail(c *ui.Context) bool {
	ui.Icon(c, hudTail).Absolute().Top(2).Left(2).Size(22, 13).TextColor(ui.RGBA(0, 0, 0, 0.45))
	for _, d := range [][2]float32{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
		ui.Icon(c, hudTail).Absolute().Top(d[1]).Left(d[0]).Size(22, 13).TextColor(ptBlack)
	}
	return true
}
