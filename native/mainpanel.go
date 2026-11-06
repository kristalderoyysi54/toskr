package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

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
	ui.Row(c).Height(44).Padding(14, 16, 8, 16).Gap(8).AlignItems(ui.Start).Children(func() {
		// 标题与留白是拖动区（Tauri data-tauri-drag-region）：拖动移动面板
		text(c, "Toskr", 13, 18, 600, k.fg).LetterSpacing(-0.325).Grow(1).Margin(2, 0, 0, 0).Cursor(ui.CursorGrab).
			Tooltip(tr("拖动此处可移动面板（未吸附时）")).DragWindow()
		ui.Row(c).Gap(2).Children(func() {
			if a.page != pageTasks && a.iconButton(c, k, "search", 22, 14, "搜索（⌘F）") {
				a.searchOpen = !a.searchOpen
			}
			if a.iconButton(c, k, "menu", 22, 14, "更多") {
				a.menuOpen = !a.menuOpen
			}
			if a.iconButton(c, k, "settings-2", 22, 14, "设置（⌘,）") {
				a.openSettings()
			}
		})
	})
}

// iconButton 是 Tauri 的 IconButton：透明底、圆角 8、悬停浅底。
func (a *app) iconButton(c *ui.Context, k tokens, icon string, box, size float32, tip string) bool {
	b := ui.Box(c).Size(box, box).Radius(8).Center().Tooltip(tip).Role(ui.RoleButton).Label(tip)
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
	b := ui.Box(c).Size(22, 22).Radius(8).Center().Tooltip(tip).Role(ui.RoleButton).Label(tip)
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
				ui.Box(c).Size(16, 16).Radius(6).Background(k.chip).Center().Children(func() { licon(c, "app-window", 8, k.muted) })
				if a.target.PID == 0 {
					text(c, tr("未识别目标"), 11, 16, 600, k.fg)
					return
				}
				text(c, a.target.Name, 11, 16, 600, k.fg).SingleLine()
				text(c, "·", 10, 14, 400, k.muted)
				ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
					ui.Box(c).Size(6, 6).Radius(3).Background(k.ok)
					text(c, tr("可发送"), 10, 14, 500, k.muted)
				})
			})
			ui.Row(c).Gap(2).Children(func() {
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

func (a *app) tabs(c *ui.Context, k tokens) {
	ui.Row(c).Height(30).Margin(6, 12, 6, 12).AlignItems(ui.Start).Children(func() {
		ui.Row(c).Padding(2).Radius(10).Background(k.track).Children(func() {
			st := a.store.Settings()
			for i, label := range tabLabels {
				if i == pageNotes && st.SecretEnabled {
					label = "内容" // 秘文开启后笔记页升格为「内容」域（笔记 · 秘文），与 Tauri 一致
				}
				if i == pageTasks && st.SubscriptionsEnabled {
					label = "提醒"
				}
				sel := a.page == i
				badge := 0
				if i == pageTasks {
					badge = a.overdueCount()
				}
				w := float32(44)
				if badge > 0 {
					w = 66 // 文字 22 + 间距 6 + 徽标 16 + 内边距 20 + 边框 2
				}
				b := ui.Box(c).Size(w, 26).Padding(1).Radius(8).Key("tab-" + label)
				hover := !sel && b.Hovered()
				if hover { // 悬停底色不在 Tauri 的过渡列表里：即时
					b.Background(k.hoverBg)
				}
				b.AnimatePose(ui.Pose{Scale: pressScale(b.Pressed(), 0.97)}, tweenControl)
				b.Children(func() {
					if sel { // 选中胶囊是共享布局指示器（layoutId page-tab-thumb）：换页时从旧页签滑过来
						thumb := ui.Box(c).Absolute().Top(1).Left(1).Right(1).Bottom(1).Radius(8).Background(k.pill).Shadow(0, 1, 2, 0, k.pillShadow).
							PassThrough().Transition(ui.ElementTransition{Match: layoutID{"page-tab-thumb"}, Animation: &springControl, Position: true, Size: true})
						if !k.dark {
							thumb.InsetShadow(0, 1, 0, 0, k.pillHighlight)
						}
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
			}
		})
	})
}

// groups 重建笔记页的分组块（剪贴板分组只在「剪贴」页出现）。
func (a *app) groups() []noteGroup {
	all := store.Search(a.store.Notes(), a.query)
	var out []noteGroup
	for _, s := range a.store.Sections() {
		if s.ID == store.SectionClipboard || (a.noteFilter != "" && s.ID != a.noteFilter) {
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
		out = append(out, g)
	}
	return out
}

func (a *app) notesPage(c *ui.Context, k tokens) {
	ui.Row(c).Grow(1).Children(func() {
		if a.noteRailOpen {
			a.noteRail(c, k)
		}
		a.notesList(c, k)
	})
}

func (a *app) notesList(c *ui.Context, k tokens) {
	ui.Box(c).Grow(1).Basis(0).Children(func() {
		pad := float32(10)
		if k.pt && ptClassicScroll {
			pad = 4 // 右侧让给经典滚动条（井内左 10 / 右 4）
		}
		ui.Scroll(c).Fill().Scrollbars(false).TrackScroll(&a.noteScroll).Children(func() {
			ui.Column(c).Padding(4, pad, 8, 10).Gap(8).Children(func() {
				if a.newSecOn {
					ui.TextInputBase(c, &a.newSec).Height(28).Padding(0, 10).Radius(10).Background(k.track).Font(fontSans).FontSize(12).
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
				// 卡片高度固定（舒适 116 / 紧凑 40），按滚动位置只构建视口附近的卡，其余用等高占位（长列表换页不卡）
				_, vh := c.Size()
				a.vis = visWindow{top: a.noteScroll.Y - 600, bottom: a.noteScroll.Y + vh + 600}
				y := float32(4)
				for _, g := range a.noteGroups {
					y += a.sectionBlock(c, k, g, y) + 8
				}
			})
		})
		// 左缘分组侧栏开关（Tauri：12×20，右侧圆角 8，图标 35% 透明度）
		a.noteRailToggle(c, k)
	})
}

// visWindow：笔记列表内容坐标下需要真实构建的纵向范围。
type visWindow struct{ top, bottom float32 }

func (a *app) cardHeight() float32 {
	if a.store.Settings().CardDensity == "compact" {
		return 40
	}
	return 116
}

// sectionBlock 构建一个分组块，top 为它在列表内容里的纵坐标，返回块高（与布局一致：区头 20 + 间距 6 + 卡片列 + 底 4）。
func (a *app) sectionBlock(c *ui.Context, k tokens, g noteGroup, top float32) float32 {
	collapsed := g.sec.Collapsed
	cardH := a.cardHeight()
	height := float32(20 + 4)
	switch {
	case collapsed:
	case len(g.open) == 0 && len(g.done) == 0:
		height += 6 + 32
	default:
		n := len(g.open)
		height += 6 + float32(n)*cardH + float32(max(n-1, 0))*4
		if len(g.done) > 0 {
			if n > 0 {
				height += 4
			}
			height += 18
			if a.doneOpen[g.sec.ID] {
				height = -1 // 已完成展开：高度不固定，不做窗口化
			}
		}
	}
	ui.Column(c).Gap(6).Padding(0, 0, 4, 0).Key("sec-" + g.sec.ID).Children(func() {
		head := ui.Row(c).Height(20).Padding(0, 4, 0, 2).Gap(4).Radius(6).AlignItems(ui.Center)
		if _, ok := ui.DragOver[noteDrag](head); ok {
			head.Background(stok(c).primary.Alpha(0.12))
		}
		if d, ok := ui.Drop[noteDrag](head); ok {
			_ = a.store.MoveToAt(d.id, g.sec.ID, 0)
		}
		head.ContextMenu(func(m *ui.Menu) {
			if len(g.done) > 0 && m.Item(tr("清理已完成")).Chosen() {
				a.section = g.sec.ID
				a.clearDone(c)
			}
			m.Separator()
			secs := a.noteSections()
			i := slices.IndexFunc(secs, func(x store.Section) bool { return x.ID == g.sec.ID })
			a.sectionMenu(m, g.sec, i, len(secs))
		})
		head.Children(func() {
			chev := "chevron-down"
			if collapsed {
				chev = "chevron-right"
			}
			b := ui.Box(c).Size(16, 16).Radius(6).Center()
			b.Children(func() { licon(c, chev, 12, k.muted) })
			if b.Clicked() {
				g.sec.Collapsed = !collapsed
				_ = a.store.UpdateSection(g.sec)
			}
			text(c, sectionName(g.sec), 11, 16, 600, k.muted).LetterSpacing(0.88)
			text(c, itoa(len(g.open)+len(g.done)), 10, 14, 400, k.muted).Grow(1)
		})
		if collapsed {
			return
		}
		if len(g.open) == 0 && len(g.done) == 0 {
			text(c, tr("此分组为空"), 11, 16, 400, k.muted).Padding(8, 0).TextAlign(ui.Center).FillWidth()
			return
		}
		ui.Column(c).Gap(4).Children(func() {
			y := top + 26
			skip := float32(0)
			flush := func() {
				if skip > 0 {
					ui.Box(c).Height(skip - 4).Key("gap-" + itoa(int(y))) // 占位：跳过的卡片 + 卡间距（减去它自己的一个间距）
					skip = 0
				}
			}
			for _, n := range g.open {
				if height >= 0 && (y+cardH < a.vis.top || y > a.vis.bottom) && !a.chosen.Has(n.ID) && a.editing != n.ID {
					skip += cardH + 4
				} else {
					flush()
					a.noteCard(c, k, n)
				}
				y += cardH + 4
			}
			flush()
			if len(g.done) > 0 {
				a.doneRow(c, k, g)
			}
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
		chev := "chevron-right"
		if open {
			chev = "chevron-down"
		}
		licon(c, chev, 10, k.muted)
		text(c, tr("已完成 ")+itoa(len(g.done)), 10, 14, 400, k.muted)
	})
	if r.Clicked() {
		a.doneOpen[g.sec.ID] = !open
	}
	if open {
		for _, n := range g.done {
			a.noteCard(c, k, n)
		}
	}
}

func cardTitle(n store.Note) string {
	switch {
	case n.Kind == "image":
		return tr("图片")
	case n.Kind == "code" || looksLikeSQL(n.Text):
		return "sql"
	}
	return tr("文本")
}

func looksLikeSQL(s string) bool {
	s = strings.TrimLeft(s, " \t\r\n")
	if len(s) > 7 {
		s = s[:7] // 只看开头：整段转大写在长列表上每帧都很贵
	}
	u := strings.ToUpper(s)
	return strings.HasPrefix(u, "SELECT ") || strings.HasPrefix(u, "INSERT ") || strings.HasPrefix(u, "UPDATE ")
}

func (a *app) noteCard(c *ui.Context, k tokens, n store.Note) {
	idx, ok := a.noteIdx[n.ID]
	if !ok {
		idx = -1
	}
	focused := idx >= 0 && idx == a.selected && a.focusList
	checked := a.chosen.Has(n.ID)
	compact := a.store.Settings().CardDensity == "compact"
	var box ui.Element
	if compact {
		box = ui.Row(c).Height(40).Radius(10).AlignItems(ui.Center).Key(n.ID)
	} else {
		box = ui.Column(c).Height(116).Radius(10).Key(n.ID)
	}
	cardFill(box, k)
	if k.pt {
		box.Radius(0)
	}
	hovered := box.Hovered()
	// Tauri：舒适卡悬停上移 1px + elevation-2（transform / box-shadow 150ms）；紧凑卡悬停只给影子；
	// 多选（checked）为内发光，舒适卡同时保持抬升；键盘焦点只抬升不描边。
	elevated(box, k, hovered || (checked && !compact) || (focused && !checked))
	lift := float32(0)
	if hovered && !compact {
		lift = -1
	}
	box.AnimatePose(ui.Pose{Y: lift}, tweenTw)
	box.ContextMenu(func(m *ui.Menu) {
		if idx >= 0 {
			a.selected = idx
		}
		a.cardMenu(c, m, max(idx, 0), n)
	})
	// 拖拽排序（同 Tauri dnd-kit）：拖起卡片，放到另一张卡上 = 插到它前面（可跨分组）；放到分组头 / 侧栏分组 = 移入该组
	if a.editing != n.ID && a.titleEditID != n.ID && a.tagEditID != n.ID {
		box.Drag(noteDrag{n.ID})
	}
	dropOver := false
	if d, ok := ui.DragOver[noteDrag](box); ok && d.id != n.ID {
		dropOver = true
	}
	if d, ok := ui.Drop[noteDrag](box); ok && d.id != n.ID {
		_ = a.store.MoveNoteBefore(d.id, n.ID)
	}
	box.Children(func() {
		if dropOver {
			ui.Box(c).Absolute().Top(-4).Left(6).Right(6).Height(2).Radius(1).Background(stok(c).primary).PassThrough()
		}
		if compact {
			a.compactCard(c, k, n, hovered)
			a.cardOverlays(c, k, n, checked, true)
			return
		}
		head := ui.Row(c).Height(28).Padding(0, 8).Gap(6).AlignItems(ui.Center).Radius(10, 10, 0, 0)
		from, to := a.bandColors(k, n)
		head.LinearGradient(ui.LinearGradient{From: from, To: to, Angle: 135})
		if k.pt {
			head.Radius(0).InsetShadow(0, -1, 0, 0, ptBlack).InsetShadow(1, 1, 0, 0, ui.RGBA(255, 255, 255, 0.6))
		}
		head.Children(func() {
			if !a.cardInlineInput(c, k, n) {
				title := cardTitle(n)
				if n.Title != "" {
					title = n.Title
				}
				text(c, title, 11, 16, 600, k.cardHeadText).SingleLine()
			}
		})
		ui.Column(c).Height(62).Margin(4, 8, 0, 8).Clip().Children(func() {
			if a.editing == n.ID {
				ui.TextAreaBase(c, &a.editText).Fill().Font(fontSans).FontSize(12).FixedLineHeight(18).TextColor(k.fg).Focus().
					OnTextKey(func(key ui.TextKey) bool {
						switch {
						case key.Key == ui.KeyEnter && key.Mods == ui.Cmd:
							a.commitEdit()
							return true
						case key.Key == ui.KeyEscape:
							a.editing = ""
							return true
						}
						return false
					})
				return
			}
			if n.Blur {
				return // 模糊卡不构建正文（旁白与截图都读不到）
			}
			if n.Kind == "image" {
				if img := a.thumb(n.ImageFile); img != nil {
					w, h := ui.ImageSize(img)
					ui.Image(c, img).Size(62*w/max(h, 1), 62).Radius(6)
				}
				return
			}
			if cardTitle(n) == "sql" {
				a.codeText(c, k, n.Text)
				return
			}
			text(c, n.Text, 12, 18, 400, k.fg).Wrap().MaxLines(3)
		})
		ui.Row(c).Height(16).Margin(0, 8, 6, 8).AlignItems(ui.Center).Children(func() {
			src := ""
			if n.SourceApp != "" {
				src = tr("来自 ") + n.SourceApp
			}
			text(c, src, 10, 14, 400, k.muted).SingleLine().Grow(1)
			text(c, ago(n.CreatedAt, time.Now()), 10, 14, 400, k.muted)
		})
		if n.Blur {
			blurOverlay(c, k, 20)
		}
		if hovered {
			a.cardActions(c, k, n)
		}
		a.cardOverlays(c, k, n, checked, false)
		if k.pt { // Platinum 卡片 1px #999 描边（压在通栏之上）
			ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Border(1, ptG600).PassThrough()
		}
	})
	if box.Clicked() {
		mods := box.ClickModifiers()
		if mods&ui.Cmd != 0 {
			if a.chosen.Len() == 0 { // 第一次 ⌘点击：把当前选中项也纳入多选
				if cur, ok := a.current(); ok && cur.ID != n.ID && a.focusList {
					a.chosen.Add(cur.ID)
				}
			}
			if a.chosen.Has(n.ID) {
				a.chosen.Remove(n.ID)
			} else {
				a.chosen.Add(n.ID)
			}
		} else {
			a.chosen.Clear()
		}
		if idx >= 0 {
			a.selected, a.focusList = idx, true
		}
	}
	if box.DoubleClicked() && idx >= 0 {
		a.selected = idx
		a.openDetail(n)
	}
}

// elevated 按 on 在 150ms 内淡入 / 淡出 elevation-2（贴身影 + 环境影 + 顶缘高光）。
func elevated(e ui.Element, k tokens, on bool) {
	pick := func(key string, col ui.Color) ui.Color {
		if !on {
			col = col.Alpha(0)
		}
		return e.AnimateColor(key, col, tweenTw)
	}
	e.Shadow(0, 1, 2, 0, pick("e2a", k.floatShadowA)).Shadow(0, 6, 16, -4, pick("e2b", k.floatShadowB)).InsetShadow(0, 1, 0, 0, pick("e2i", k.floatInset))
}

// cardOverlays 画卡面之上的选中柔光（.list-selection-glow）与捕获闪烁（flash-highlight：琥珀 30% → 透明，1800ms ease-out）。
func (a *app) cardOverlays(c *ui.Context, k tokens, n store.Note, checked, compact bool) {
	r := float32(10)
	if k.pt {
		r = 0
	}
	if checked {
		glow := float32(24)
		if compact {
			glow = 8
		}
		ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Radius(r).PassThrough().
			InsetShadow(0, 0, 8, 1, k.selRim).InsetShadow(0, 0, glow, 2, k.selHalo)
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
func (a *app) compactCard(c *ui.Context, k tokens, n store.Note, hovered bool) {
	ui.Box(c).Size(18, 18).Margin(0, 0, 0, 4).Padding(2).Opacity(0.6).Children(func() { licon(c, "grip-vertical", 14, k.muted.Alpha(0.5)) })
	ui.Row(c).Grow(1).Basis(0).Padding(0, 8).Children(func() {
		if a.editing == n.ID {
			ui.TextInputBase(c, &a.editText).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).TextColor(k.fg).Focus().
				OnTextKey(func(key ui.TextKey) bool {
					switch key.Key {
					case ui.KeyEnter:
						a.editText = key.Text()
						a.commitEdit()
						return true
					case ui.KeyEscape:
						a.editing = ""
						return true
					}
					return false
				})
			return
		}
		line := strings.Join(strings.Fields(n.Text), " ")
		if n.Blur {
			line = ""
		}
		if n.Kind == "image" {
			line = tr("图片")
		}
		if cardTitle(n) == "sql" {
			text(c, line, 11, 16, 400, k.fg).Font(fontMono).SingleLine().Grow(1).Basis(0)
		} else {
			text(c, line, 12, 17, 400, k.fg).SingleLine().Grow(1).Basis(0)
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
func (a *app) cardActions(c *ui.Context, k tokens, n store.Note) { a.cardActionsAt(c, k, n, 4) }

func (a *app) cardActionsAt(c *ui.Context, k tokens, n store.Note, bottom float32) {
	right := float32(8)
	if bottom != 4 {
		right = 4
	}
	fade := ui.ElementTransition{Duration: 100 * time.Millisecond, Ease: easeTw, Enter: &ui.Motion{}, Exit: &ui.Motion{}} // reveal="hover-focus"：opacity 100ms
	ui.Row(c).Absolute().Right(right).Bottom(bottom).Gap(2).Key("acts").Transition(fade).Children(func() {
		for _, act := range []struct{ icon, tip string }{
			{"send", "发送（⌘↵）"}, {"expand", "在详情窗打开"}, {"pencil", "编辑"}, {"eye-off", "模糊内容"}, {"trash-2", "删除"},
		} {
			if act.icon == "eye-off" && n.Blur {
				act.icon, act.tip = "eye", "取消模糊"
			}
			b := ui.Box(c).Size(22, 22).Radius(8).Center().Background(k.floatBtn).Border(1, k.floatBorder).
				Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).InsetShadow(0, 1, 0, 0, k.floatInset).Tooltip(tr(act.tip))
			b.Children(func() { licon(c, act.icon, 12, k.muted) })
			if b.Clicked() {
				switch act.icon {
				case "send":
					a.send([]store.Note{n})
				case "expand":
					a.openDetail(n)
				case "pencil":
					a.editing, a.editText = n.ID, n.Text
				case "eye-off", "eye":
					_ = a.store.SetBlur(n.ID, !n.Blur)
				case "trash-2":
					if r, pos, ok := a.store.Delete(n.ID); ok {
						a.showHUDUndo("ok", tr("已删除 · ")+preview(r.Text, 14), func() { _ = a.store.Restore(r, pos) })
					}
				}
			}
		}
	})
}

// codeText 做最小的 SQL 关键字着色（与 Tauri 版的配色一致：关键字 / 字符串 / 数字）。
func (a *app) codeText(c *ui.Context, k tokens, src string) {
	kw := map[string]bool{"SELECT": true, "FROM": true, "WHERE": true, "ORDER": true, "BY": true, "DESC": true, "ASC": true, "LIMIT": true,
		"INSERT": true, "INTO": true, "VALUES": true, "UPDATE": true, "SET": true, "AND": true, "OR": true, "JOIN": true, "ON": true}
	var spans []ui.Span
	for _, tokn := range sqlTokens(src) {
		col := k.fg
		switch {
		case kw[strings.ToUpper(tokn)]:
			col = k.codeKeyword
		case strings.HasPrefix(tokn, "'"):
			col = k.codeString
		case tokn != "" && tokn[0] >= '0' && tokn[0] <= '9':
			col = k.codeNumber
		}
		spans = append(spans, ui.Span{Text: tokn, Color: col})
	}
	ui.RichText(c, spans...).Font(fontMono).FontSize(11).FixedLineHeight(16.5).Wrap().MaxLines(3)
}

func sqlTokens(s string) []string {
	var out []string
	for i := 0; i < len(s); {
		j := i
		switch ch := s[i]; {
		case ch == '\'':
			j++
			for j < len(s) && s[j] != '\'' {
				j++
			}
			j = min(j+1, len(s))
		case isWord(ch):
			for j < len(s) && isWord(s[j]) {
				j++
			}
		default:
			j++
		}
		out = append(out, s[i:j])
		i = j
	}
	return out
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
	ui.Column(c).Height(60).Padding(6, 12, 12, 12).Children(func() {
		box := ui.Row(c).Height(42).Padding(8, 10).Gap(6).Radius(14).Background(k.track).Border(1, k.inputBorder).
			InsetShadow(0, 1, 2, 0, k.insetShadow).AlignItems(ui.Center)
		box.Children(func() { a.composerRow(c, k) })
	})
}

// composerRow 是输入区内容：分组选择 · 多行输入 · 加入队列钮。
func (a *app) composerRow(c *ui.Context, k tokens) {
	ui.Row(c).Grow(1).Gap(6).AlignItems(ui.Center).Children(func() {
		pick := ui.Row(c).Height(24).Padding(0, 6).Gap(4).Radius(8).AlignItems(ui.Center)
		pick.Children(func() {
			licon(c, "folder-input", 12, k.muted)
			text(c, sectionName(a.composerSection()), 11, 16, 400, k.muted)
			licon(c, "chevron-up", 10, k.muted)
		})
		pick.Menu(func(m *ui.Menu) {
			for _, s := range a.store.Sections() {
				if s.ID != store.SectionClipboard && m.Item(sectionName(s)).Radio(s.ID == a.section).Chosen() {
					a.section = s.ID
				}
			}
		})
		ui.TextAreaBase(c, &a.draft).Bind(&a.draftIn).Grow(1).Lines(1, 6).Font(fontSans).FontSize(13).FixedLineHeight(19.5).
			TextColor(k.fg).PlaceholderColor(k.muted).Placeholder(tr("添加笔记或提示词…")).
			OnTextKey(func(key ui.TextKey) bool {
				if key.Key == ui.KeyEnter && key.Mods == 0 {
					a.draft = key.Text()
					a.addDraft()
					key.SetText(a.draft)
					return true
				}
				return false
			})
		if a.iconButton(c, k, "arrow-up-right", 22, 14, tr("加入队列（↵）")) {
			a.addDraft()
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
	case a.editing != "":
		return [][2]string{{"⌘⏎", tr("保存")}, {"Esc", tr("取消")}}
	case a.searchOpen:
		return [][2]string{{"Esc", tr("关闭搜索")}, {"↑↓", tr("移动焦点")}}
	case a.page == pageTasks:
		return [][2]string{{"⏎", tr("记下待办")}, {"⌘K", tr("命令")}, {tr("长按 ⌥ Option"), tr("全部快捷键")}}
	case a.page == pageNotes && a.noteSub == 1:
		return [][2]string{{"⌘K", tr("命令")}, {tr("长按 ⌥ Option"), tr("全部快捷键")}}
	case a.chosen.Len() > 0:
		return [][2]string{{"⌘⏎", fmt.Sprintf(tr("发送 %d 张"), a.chosen.Len())}, {"⌘C", tr("复制为列表")}, {"Esc", tr("取消勾选")}, {"⌘K", tr("命令")}}
	case focused && a.focusList:
		return [][2]string{{"⌘⏎", tr("发送")}, {"Space", tr("预览")}, {"⏎", tr("编辑")}, {"x", tr("勾选")}, {"⌘K", tr("命令")}}
	}
	return [][2]string{{"↑↓", tr("选卡片")}, {"⌘F", tr("搜索")}, {"⌘K", tr("命令")}, {tr("长按 ⌥ Option"), tr("全部快捷键")}}
}

// selectionBar 是勾选 ≥1 条时出现在面板最下方的批量操作条（Tauri SelectionBar，停靠形态）：
// 已选 N · 合并 · 删除 · 清除选择 · 发送 ⌘⏎ 分体钮。
func (a *app) selectionBar(c *ui.Context, k tokens) {
	n := a.chosen.Len()
	if n == 0 || a.page == pageTasks || (a.page == pageNotes && a.noteSub == 1) {
		return
	}
	s := stok(c)
	bar := ui.Row(c).Margin(0, 8, 8, 8).Padding(6, 8).Gap(2).Radius(12).Background(k.floatBtn.Alpha(0.95)).Border(1, k.fg.Alpha(0.1)).
		Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).InsetShadow(0, 1, 0, 0, k.floatInset).AlignItems(ui.Center).
		Key("selection-bar").Transition(ui.ElementTransition{Duration: 160 * time.Millisecond, Ease: easeStandard, Enter: &ui.Motion{Y: 8}})
	bar.Children(func() {
		text(c, fmt.Sprintf(tr("已选 %d"), n), 11, 16, 400, k.muted).Padding(0, 4).SingleLine()
		ui.Spacer(c)
		act := func(icon, tip string, enabled bool) bool {
			b := ui.Box(c).Size(22, 22).Radius(8).Center().Tooltip(tip).Key("sel-" + icon)
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
		if act("merge", tr("合并笔记"), n >= 2) {
			a.mergeChosen(c)
		}
		if act("trash-2", tr("删除"), true) {
			a.deleteSelected(c)
		}
		if act("x", tr("清除选择"), true) {
			a.chosen.Clear()
		}
		ui.Row(c).Margin(0, 0, 0, 4).Height(24).Children(func() {
			send := ui.Row(c).Height(24).Padding(0, 8).Gap(4).Radius(10, 0, 0, 10).Border(1, s.btnBorder).AlignItems(ui.Center).Key("sel-send")
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
			send.Children(func() {
				licon(c, "send", 12, s.btnFg)
				text(c, tr("发送"), 11, 16, 500, s.btnFg)
				text(c, "⌘⏎", 9, 12, 400, s.btnFg).Opacity(0.7)
			})
			if send.Clicked() {
				a.sendSelected()
			}
			more := ui.Box(c).Height(24).Padding(0, 4).Radius(0, 10, 10, 0).Background(s.btn).BorderWidth(1, 1, 1, 0).BorderColor(s.btnBorder).Center()
			more.Children(func() {
				ui.Box(c).Absolute().Left(0).Top(0).Bottom(0).Width(1).Background(s.inputBorder)
				licon(c, "chevron-down", 12, s.btnFg)
			})
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
	ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Radius(10).Background(k.card).Center().PassThrough().Key("privacy").Children(func() {
		ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Radius(10).LinearGradient(ui.LinearGradient{From: k.track.Alpha(0.7), To: k.track.Alpha(0.4), Angle: 135})
		licon(c, "eye-closed", icon, k.muted.Alpha(0.6))
	})
}

// cardInlineInput：卡片标题栏里的就地输入（右键「重命名…」/「新标签…」），返回是否占用了标题栏。
func (a *app) cardInlineInput(c *ui.Context, k tokens, n store.Note) bool {
	switch {
	case a.titleEditID == n.ID:
		ui.TextInputBase(c, &a.titleText).Grow(1).Font(fontSans).FontSize(11).TextColor(k.cardHeadText).Placeholder(tr("卡片标题，↵ 保存，留空清除")).
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
		ui.TextInputBase(c, &a.tagText).Grow(1).Font(fontSans).FontSize(11).TextColor(k.cardHeadText).Placeholder(tr("新标签，↵ 添加")).
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
