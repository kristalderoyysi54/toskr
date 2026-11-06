package main

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/glass"
	"github.com/egoist/mygo/ui"
)

// glassOn 报告设置里是否启用窗内玻璃（任务/账单/秘文页卡片的 glass 插件材质）。
func (a *app) glassOn() bool { return a.store.Settings().Glass != "none" }

func (a *app) glassMaterial(clarity float32) glass.Glass {
	g := glass.Glass{Clarity: clarity}
	if a.store.Settings().Glass == "clear" {
		g.Style = glass.Clear
	}
	return g
}

// surface 给块元素上玻璃材质或普通底色。
func (a *app) surface(c *ui.Context, e ui.Element, clarity float32) ui.Element {
	if a.glassOn() {
		return e.Material(a.glassMaterial(clarity))
	}
	return e.Background(c.Theme().Surface)
}

// panelView 与 Tauri 主面板同构：标题栏 → 目标条 → 页签 → 内容 → 快捷键提示 → 输入区。
// 面板底色是 Tauri 叠在模糊材质上的半透明色；材质本身换成原生模糊 / 液态玻璃。
func (a *app) panelView(c *ui.Context) {
	registerFonts()
	a.drainUpdates()
	k := tok(c)
	a.panelKeys(c)
	a.notePanelKeys(c)
	shell := ui.Column(c).Fill()
	p := a.panelPresence(c, shell)
	// 底色是内容自绘的半透明膜（Tauri 同样画在 webview 里），随内容一起淡入淡出；系统材质本身不动
	tint := float32(1)
	if !k.pt { // 内容底色浓度（Tauri panelOpacity，默认 0.62 = 方案自带浓度）；Platinum 整窗不透明
		tint = float32(a.store.Settings().PanelAlpha() / 0.62)
	}
	c.Root().Background(k.window.Alpha(min(p, 1) * tint)) // Alpha 是相乘
	if k.pt {
		shell.Children(func() {
			a.platinumPanel(c, k)
			a.panelVHandles(c, k)
			a.recentDrawer(c, k)
			a.shortcutHelp(c, k)
			a.commandPalette(c, k)
		})
		return
	}

	shell.Radius(14).Children(func() {
		a.mainHeader(c, k)
		if a.searchOpen {
			a.searchRow(c, k)
		}
		a.targetBar(c, k)
		a.permissionBanner(c, k)
		a.tabs(c, k)
		if len(a.pending) > 0 {
			ui.Column(c).Margin(0, 12, 6, 12).Children(func() { a.preflightBar(c) })
		}
		if len(a.enterAsk) > 0 {
			ui.Column(c).Margin(0, 12, 6, 12).Children(func() { a.enterAskBar(c) })
		}
		a.pageSlide(c, func(p int) { a.pageBody(c, k, p) })
		a.hintsRow(c, k)
		if a.page == pageNotes && a.noteSub == 0 { // 发送输入区只在笔记视图，与 Tauri 一致
			a.composerBar(c, k)
		}
		a.selectionBar(c, k) // 勾选时的批量条留在面板最下方
		a.panelVHandles(c, k)
		a.verifySheet(c, k)
		a.recentDrawer(c, k)
		a.shortcutHelp(c, k) // 长按 ⌥ 的快捷键速查层压在最上
		a.commandPalette(c, k)
	})
	if a.menuOpen {
		a.panelMenu(c, k)
	}
}

// panelPresence 复刻 Tauri 面板进出场：显示时从停靠边（右侧）外 16px 滑入并淡入（springSnappy），
// 收起时退回 16px 并淡出（tweenExit 140ms easeIn）。返回当前不透明度进度。
func (a *app) panelPresence(c *ui.Context, shell ui.Element) float32 {
	target, anim := float32(1), springSnappy
	if a.panelHiding {
		target, anim = 0, tweenExit
	}
	if a.presenceArm { // 本次显示从 0 起播（含首次显示、以及 hidePanelNow 直接藏窗后再显示）
		shell.Jump("presence", 0)
		a.presenceArm = false
	}
	p := shell.AnimateTo("presence", target, anim)
	dx := 16 * (1 - p)
	if c.Preferences().ReduceMotion {
		dx = 0
	}
	shell.Opacity(min(max(p, 0), 1)).Translate(dx, 0)
	return max(p, 0)
}

// pageBody 是一页的内容（剪贴 / 笔记·消息·秘文 / 任务）。
func (a *app) pageBody(c *ui.Context, k tokens, p int) {
	switch p {
	case pageClip:
		a.clipPage(c, k)
	case pageTasks:
		ui.Column(c).Grow(1).Children(func() { a.tasksPage(c) })
	default:
		sub := a.contentTabs(c, k)
		a.swapView(ui.Column(c).Grow(1), "csub", sub).Children(func() {
			switch sub {
			case subSecret:
				a.secretsPage(c, k)
			case subMessages:
				a.messagesPage(c, k)
			default:
				a.notesPage(c, k)
			}
		})
	}
}

// pageSlide 复刻 Tauri PageSlide：新页从换页方向 ±24 滑入并淡入，旧页向反方向滑出并淡出（springSnappy）；
// 旧页在动画期间继续构建、不接收指针，约 0.4s 后释放。
func (a *app) pageSlide(c *ui.Context, build func(p int)) {
	if a.prevPage >= 0 && a.pageAt.IsZero() {
		a.pageAt = c.Now()
	}
	if a.prevPage >= 0 && c.Now().Sub(a.pageAt) > 400*time.Millisecond {
		a.prevPage = -1
	}
	order := a.visiblePages() // 方向按页签的显示顺序（可拖动重排）
	pos := func(p int) int { return slices.Index(order, p) }
	ui.Box(c).Grow(1).Clip().Children(func() {
		for _, p := range []int{a.prevPage, a.page} {
			if p < 0 || (p == a.page && p == a.prevPage) {
				continue
			}
			pg := ui.Column(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Key(pageKey(p))
			pose := ui.Pose{}
			if p != a.page {
				pose = ui.Pose{X: 24 * sign(pos(p)-pos(a.page)), Fade: 1}
				pg.PassThrough()
			} else {
				pg.Transition(ui.ElementTransition{Animation: &springSnappy, Position: true, Enter: &ui.Motion{X: 24 * sign(pos(a.page)-pos(max(a.prevPage, 0)))}})
			}
			pg.AnimatePose(pose, springSnappy).Children(func() { build(p) })
		}
	})
}

func pageKey(p int) string { return "page-" + itoa(p) }

func sign(n int) float32 {
	switch {
	case n > 0:
		return 1
	case n < 0:
		return -1
	}
	return 0
}

// textTabs 是 Tauri 的二级文字页签（今天 · 任务 · 订阅 / 笔记 · 秘文）：选中加粗 + 22×2 短下划线。
func (a *app) textTabs(c *ui.Context, k tokens, labels []string, sel int, right func()) (int, bool) {
	return a.textTabsBadged(c, k, labels, nil, sel, right)
}

// textTabsBadged：badges[i] > 0 时在该页签文字后挂计数（同 Tauri ContentTabs 的消息未处理数）。
func (a *app) textTabsBadged(c *ui.Context, k tokens, labels []string, badges []int, sel int, right func()) (int, bool) {
	picked, changed := sel, false
	ui.Row(c).Height(34).Padding(4, 14, 8, 16).AlignItems(ui.Start).Children(func() {
		ui.Row(c).Gap(2).Grow(1).AlignItems(ui.Center).Children(func() {
			for i, label := range labels {
				if i > 0 {
					text(c, "·", 10, 14, 400, k.muted.Alpha(0.45)).Padding(0, 2)
				}
				on := sel == i
				b := ui.Column(c).Height(22).Padding(2, 8, 4, 8).Radius(8).AlignItems(ui.Center).Key("sub-" + label)
				bg := ui.Transparent
				if !on && b.Hovered() {
					bg = k.track
				}
				fadeColor(b, "bg", bg, tweenControl)
				b.Children(func() {
					w, col := 400, k.muted
					if on {
						w, col = 600, k.fg
					}
					ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
						text(c, tr(label), 11, 16, w, b.AnimateColor("fg", col, tweenControl))
						if i < len(badges) && badges[i] > 0 {
							text(c, itoa(badges[i]), 10, 14, 600, k.danger).FontFeatures("tnum")
						}
					})
					if on { // 共享布局下划线（layoutId content-subtab-line / reminders-subtab-line）
						ui.Box(c).Absolute().Bottom(0).Left(8).Right(8).Height(2).Radius(1).Background(k.fg.Alpha(0.85)).PassThrough().
							Transition(ui.ElementTransition{Match: layoutID{"subtab-line-" + labels[0]}, Animation: &springControl, Position: true, Size: true})
					}
				})
				if b.Clicked() && !on {
					picked, changed = i, true
				}
			}
		})
		if right != nil {
			ui.Row(c).Children(right)
		}
	})
	return picked, changed
}

func (a *app) searchRow(c *ui.Context, k tokens) {
	ui.Row(c).Height(30).Margin(0, 12, 6, 12).Padding(0, 10).Gap(6).Radius(10).Background(k.track).AlignItems(ui.Center).Children(func() {
		licon(c, "search", 12, k.muted)
		if ui.TextInputBase(c, &a.query).Bind(&a.search).Grow(1).Font(fontSans).FontSize(12).Placeholder(tr("搜索（⌘F）")).Focus().Changed() {
			a.selected = 0
			a.reload()
		}
		if strings.TrimSpace(a.query) != "" { // 命中计数（同 Tauri matchCount）
			text(c, strconv.Itoa(a.searchMatchCount()), 10, 14, 400, k.muted).Key("search-count")
		}
		if ghostIconButton(c, k, "search-close", "x", tr("关闭搜索"), 18, 12, false, true).Clicked() {
			a.searchOpen, a.query = false, ""
			a.reload()
		}
	})
}

// panelMenu 是标题栏 ☰「面板选项」（Tauri PanelOptionsMenu）：当前列表 / 面板 两组，位置与停靠为二级页。
func (a *app) panelMenu(c *ui.Context, k tokens) {
	st := a.store.Settings()
	if ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Clicked() { // 点菜单外关闭
		a.menuOpen, a.placementOpen = false, false
		return
	}
	menu := ui.Column(c).Absolute().Top(40).Right(40).Width(224).Padding(4).Radius(10).Background(k.floatBtn.Alpha(0.95)).Border(1, k.floatBorder).
		Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).InsetShadow(0, 1, 0, 0, k.floatInset).
		// SimpleMenu：fade + zoom 0.95 → 1（自上缘展开），160ms ease-standard；关闭反向。菜单项悬停底色即时
		Key("panel-menu").TransformOrigin(0.5, 0).Transition(ui.ElementTransition{Duration: 160 * time.Millisecond, Ease: easeStandard,
		Enter: &ui.Motion{Scale: 0.95}, Exit: &ui.Motion{Scale: 0.95}})
	label := func(s string) { text(c, s, 10, 14, 500, k.muted).Padding(4, 8) }
	sep := func() { ui.Box(c).Height(1).Margin(4, 0).Background(stok(c).inputBorder) }
	item := func(icon, s string, checked, radio bool, trail string, fn func()) {
		row := ui.Row(c).Height(29).Padding(6, 8).Gap(8).Radius(6).AlignItems(ui.Center).Key("pm-" + s)
		if row.Hovered() {
			row.Background(k.track)
		}
		row.Children(func() {
			if icon != "" {
				licon(c, icon, 14, k.fg)
			}
			text(c, s, 12, 17, 400, k.fg).Grow(1).SingleLine()
			switch {
			case trail != "":
				if trail == ">" {
					licon(c, "chevron-right", 14, k.fg)
				} else {
					text(c, trail, 10, 14, 400, k.muted)
				}
			case checked && radio:
				ui.Box(c).Size(14, 14).Center().Children(func() { ui.Box(c).Size(6, 6).Radius(3).Background(k.fg) })
			case checked:
				licon(c, "check", 14, k.fg)
			default:
				ui.Box(c).Size(14, 14)
			}
		})
		if row.Clicked() {
			fn()
		}
	}
	closeMenu := func() { a.menuOpen, a.placementOpen = false, false }
	menu.Children(func() {
		if a.placementOpen {
			item("arrow-left", tr("返回面板选项"), false, false, "", func() { a.placementOpen = false })
			sep()
			place := tr("屏幕右侧")
			side := tr("右侧")
			if st.SidebarEdge == "left" {
				side = tr("左侧")
			}
			if !st.CompanionOff && len(st.Companion) > 0 {
				place = tr("跟随应用 · ") + side
			} else if st.FreeMove {
				place = tr("自由移动")
			}
			label(fmt.Sprintf(tr("当前位置：%s"), place))
			item("magnet", tr("跟随应用"), !st.CompanionOff, false, "", func() {
				st.CompanionOff = !st.CompanionOff
				_ = a.store.SetSettings(st)
			})
			if !st.CompanionOff {
				label(tr("跟随位置"))
				for _, e := range [][2]string{{"left", "应用左侧"}, {"right", "应用右侧"}} {
					on := (st.SidebarEdge == "left") == (e[0] == "left")
					item("", tr(e[1]), on, true, "", func() {
						st.SidebarEdge = e[0]
						_ = a.store.SetSettings(st)
						closeMenu()
						a.repositionPanel()
					})
				}
			}
			label(tr("屏幕位置"))
			item("move", tr("自由移动"), st.FreeMove, true, "", func() {
				st.FreeMove = true
				_ = a.store.SetSettings(st)
				closeMenu()
			})
			item("", tr("屏幕右侧"), !st.FreeMove, true, "", func() {
				st.FreeMove = false
				_ = a.store.SetSettings(st)
				closeMenu()
				a.repositionPanel()
			})
			return
		}
		done := 0
		switch {
		case a.page == pageNotes && a.noteSub == 0:
			done = len(a.done)
		case a.page == pageTasks:
			for _, t := range a.tasks {
				if t.Status == "done" {
					done++
				}
			}
		}
		density := a.page == pageClip || (a.page == pageNotes && a.noteSub == 0)
		if density || done > 0 {
			label(tr("当前列表"))
		}
		if density { // 卡片密度开关（Tauri：Rows3「紧凑列表」，勾选 = 紧凑）
			compact := st.CardDensity == "compact"
			item("rows-3", tr("紧凑列表"), compact, false, "", func() {
				st.CardDensity = "comfortable"
				if !compact {
					st.CardDensity = "compact"
				}
				_ = a.store.SetSettings(st)
				closeMenu()
			})
		}
		if done > 0 {
			item("eraser", fmt.Sprintf(tr("清理已完成（%d）"), done), false, false, "⇧⌘⌫", func() {
				closeMenu()
				a.clearAllDone(c)
			})
		}
		if density || done > 0 {
			sep()
		}
		label(tr("面板"))
		item("pin", tr("保持面板展开"), a.pinned, false, "", func() { a.pinned = !a.pinned; closeMenu() })
		item("move", tr("位置与停靠"), false, false, ">", func() { a.placementOpen = true })
	})
	if c.Shortcut(0, ui.KeyEscape) {
		closeMenu()
	}
}

// panelKeys：面板级快捷键（同 Tauri App.tsx 键盘处理）：⌃Tab / ⌘←→ 切页、Esc 逐层退出、⌘F 搜索、⌘Z 撤销、⇧⌘⌫ 清理已完成。
func (a *app) panelKeys(c *ui.Context) {
	typing := a.editing != "" || a.titleEditID != "" || a.tagEditID != "" || a.renamingSec != "" || a.taskOpen != "" || a.taskSecRename != ""
	if c.Shortcut(ui.Ctrl, ui.KeyTab) { // 按页签顺序循环（页签可拖动重排，剪贴历史关闭时跳过剪贴页）
		a.pageStep(1, true)
	}
	if !typing && c.Shortcut(ui.Cmd, ui.KeyLeft) {
		a.pageStep(-1, false)
	}
	if !typing && c.Shortcut(ui.Cmd, ui.KeyRight) {
		a.pageStep(1, false)
	}
	if !typing && c.Shortcut(ui.Cmd, ui.KeyK) {
		a.cmdOpen, a.cmdQuery, a.cmdCursor = !a.cmdOpen, "", 0
	}
	if a.cmdOpen { // 命令面板打开时独占键盘（输入框处理 ↑↓↵ Esc）
		return
	}
	if !typing && a.kbDragKeys(c) { // 键盘拖拽排序：拾起后独占方向键 / Space / Esc
		return
	}
	if c.Shortcut(0, ui.KeyEscape) {
		switch {
		case a.verify.noteID != "": // 回复检查浮层先关
			a.closeVerify()
		case a.clipPick != "": // 长按弹出的分组选择先关
			a.clipPick = ""
		case a.billForm.open: // 盖住面板的对话框先退（同 Tauri Dialog Esc）
			a.billForm = billForm{}
		case a.billAnalytics:
			a.billAnalytics = false
		case a.titleEditID != "" || a.tagEditID != "" || a.renamingSec != "":
			a.titleEditID, a.tagEditID, a.renamingSec = "", "", ""
		case a.editing != "":
			a.editing = ""
		case a.taskSecRename != "":
			a.taskSecRename = ""
		case a.taskOpen != "":
			a.commitTaskEdit()
			a.taskOpen = ""
		case a.menuOpen:
			a.menuOpen = false
		case a.quickOpen:
			a.quickOpen = false
		case len(a.enterAsk) > 0:
			a.cancelEnterAsk()
		case a.drawerOpen:
			a.drawerOpen = false
		case a.noteRailOpen:
			a.noteRailOpen = false
		case a.searchOpen:
			a.searchOpen = false
			a.query = ""
			a.reload()
		case a.chosen.Len() > 0:
			a.chosen.Clear()
		case a.page == pageNotes && a.noteSub == subMessages && len(a.msgChosen) > 0:
			a.clearMsgChosen()
		default:
			a.hidePanel()
		}
	}
	if c.Shortcut(ui.Cmd, ui.KeyF) && a.page != pageTasks {
		a.searchOpen = true
		a.search.Focus()
	}
	if !typing && c.Shortcut(ui.Cmd, ui.KeyZ) && a.hudUndo != nil { // HUD「撤销」的键盘入口
		fn := a.hudUndo
		a.hudUndo = nil
		fn()
		a.showHUD("undone", tr("已撤销"))
	}
	if c.Shortcut(ui.Cmd|ui.Shift, ui.KeyBackspace) && (a.page == pageTasks || (a.page == pageNotes && a.noteSub == 0)) {
		a.clearAllDone(c)
	}
	if c.Shortcut(ui.Cmd, ui.KeyP) {
		a.pinned = !a.pinned
	}
	if c.Shortcut(ui.Cmd, ui.KeyComma) {
		a.openSettings()
	}
	c.OnShortcut(ui.Cmd, ui.KeyQ, mygo.App.Quit)
	if a.page == pageClip || (a.page == pageNotes && a.noteSub == 0) {
		a.queueKeys(c)
	}
	if !typing && a.page == pageTasks {
		a.taskKeys(c)
	}
	if !typing && a.page == pageNotes && a.noteSub == subMessages && c.Shortcut(ui.Cmd, ui.KeyA) { // ⌘A 全选当前栏（同 Tauri messageSelectAllIds）
		a.clearMsgChosen()
		for _, m := range a.visibleMessages() {
			a.msgChosen[m.ID] = true
		}
	}
}

func (a *app) switchPage(p int) {
	if a.page != p {
		a.prevPage, a.pageAt = a.page, time.Time{}
		a.page, a.editing, a.selected = p, "", 0
		a.chosen.Clear()
		a.clearMsgChosen()
		a.reload()
	}
}

func targetName(name string) string {
	if name == "" {
		return tr("（未知应用）")
	}
	return name
}

func itoa(n int) string {
	if n > 999 {
		return "999+"
	}
	b := []byte{}
	if n == 0 {
		return "0"
	}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
