package main

import (
	"fmt"
	"slices"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 屏幕顶部 / 底部横栏（同 Tauri rightSidebar + sidebarEdge top|bottom）：面板铺满所在屏宽，
// 高 = 可用高 32%（夹在 260–420），三页改成横向方形卡串，页签并入标题行、分组胶囊居中。

// barEdge：当前是否横栏布局，返回 "top" / "bottom"；竖栏 / 自由移动返回 ""。
func barEdge(st store.Settings) string {
	if st.FreeMove {
		return ""
	}
	if st.SidebarEdge == "top" || st.SidebarEdge == "bottom" {
		return st.SidebarEdge
	}
	return ""
}

// hbar：本次唤出是横栏形态（伴随停靠接管时仍按竖栏画）。
func (a *app) hbar() bool { return barEdge(a.store.Settings()) != "" && !a.docked }

// barRect 同 Tauri window.rs sidebar_rect 的 2|3 分支。
func barRect(wa mygo.Rectangle, edge string) mygo.Rectangle {
	gap := panelMargin
	maxH := max(wa.Height-2*gap, 200)
	h := min(max(wa.Height*32/100, min(260, maxH)), 420, maxH)
	w := max(wa.Width-2*gap, 320)
	y := wa.Y + wa.Height - h - gap
	if edge == "top" {
		y = wa.Y + gap
	}
	return mygo.Rectangle{X: wa.X + gap, Y: y, Width: w, Height: h}
}

// applySizeLimits：横栏要突破竖栏的宽度上限 / 高度下限。
func (a *app) applySizeLimits() {
	if a.hbar() {
		a.panel.SetMinimumSize(panelMinW, 200)
		a.panel.SetMaximumSize(0, 0)
		return
	}
	a.panel.SetMinimumSize(panelMinW, panelMinH)
	a.panel.SetMaximumSize(panelMaxW, 0)
}

const doneFilter = "__done__" // 横栏分组胶囊「已完成」（同 Tauri DONE_FILTER）

type barState struct {
	draftOpen              bool // 「添加笔记」唤出的输入区
	taskFilter             string
	clip, notes, tasks     ui.ScrollState
	secret, msgs           ui.ScrollState
	followClip, followNote string // 上次已滚进视口的焦点卡
}

// barHeader：横栏单行头部——左「Toskr + 页签」，中分组胶囊，右工具钮（同 Tauri horizontalBar 头部）。
func (a *app) barHeader(c *ui.Context, k tokens) {
	ui.Row(c).Height(40).Padding(8, 12, 4, 16).Gap(8).AlignItems(ui.Center).DragWindow().Key("bar-header").Children(func() { // 整个头部可拖（同 Tauri header drag-region）
		ui.Row(c).Grow(1).Basis(0).Gap(10).AlignItems(ui.Center).Children(func() {
			tipOf(c, text(c, "Toskr", 13, 18, 600, k.fg).LetterSpacing(-0.325).Cursor(ui.CursorGrab), tr("拖动此处可移动面板（未吸附时）")).DragWindow()
			a.tabStrip(c, k)
		})
		ui.ScrollHorizontal(c).Scrollbars(false).Shrink(1).MaxWidth(560).Children(func() {
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() { a.barPills(c, k) })
		})
		ui.Row(c).Grow(1).Basis(0).Gap(2).Justify(ui.End).AlignItems(ui.Center).Children(func() {
			if a.page == pageNotes && a.noteSub == 0 {
				tip := tr("添加笔记")
				if a.bar.draftOpen {
					tip = tr("收起输入")
				}
				if a.toggleIconButton(c, k, "plus", tip, a.bar.draftOpen) {
					a.bar.draftOpen = !a.bar.draftOpen
					if a.bar.draftOpen {
						a.draftIn.Focus()
					}
				}
			}
			a.updatePill(c, k)
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

// barPills：笔记页 / 任务页的分组过滤胶囊（全部 · 各组 · 已完成）。
func (a *app) barPills(c *ui.Context, k tokens) {
	switch {
	case a.page == pageNotes && a.noteSub == 0:
		done := len(a.done)
		if a.barPill(c, k, "", tr("全部"), "", a.noteFilter == "") {
			a.pickNoteGroup("")
		}
		secs := a.noteSections()
		for i, s := range secs {
			p := a.barPillEl(c, k, s.ID, sectionName(s), s.Color, a.noteFilter == s.ID)
			p.ContextMenu(func(m *ui.Menu) { a.secMenuSrc = "bar"; a.sectionMenu(m, s, i, len(secs)) })
			a.sectionColorPopover(c, k, s, p, "bar")
			if d, ok := ui.Drop[noteDrag](p); ok {
				_ = a.store.MoveToAt(d.id, s.ID, 0)
			}
			if p.Clicked() {
				if a.noteFilter == s.ID {
					a.pickNoteGroup("")
				} else {
					a.pickNoteGroup(s.ID)
				}
			}
		}
		if done > 0 || a.noteFilter == doneFilter {
			if a.barPill(c, k, doneFilter, tr("已完成")+" "+itoa(done), "", a.noteFilter == doneFilter) {
				if a.noteFilter == doneFilter {
					a.pickNoteGroup("")
				} else {
					a.pickNoteGroup(doneFilter)
				}
			}
		}
	case a.page == pageTasks:
		if a.barPill(c, k, "", tr("全部"), "", a.bar.taskFilter == "") {
			a.bar.taskFilter = ""
		}
		for _, s := range a.store.TaskSections() {
			if a.barPill(c, k, "t-"+s.ID, sectionTitle(s), s.Color, a.bar.taskFilter == s.ID) {
				a.bar.taskFilter = map[bool]string{true: "", false: s.ID}[a.bar.taskFilter == s.ID]
			}
		}
		done := 0
		for _, t := range a.tasks {
			if t.Status == "done" {
				done++
			}
		}
		if done > 0 && a.barPill(c, k, "t-done", tr("已完成")+" "+itoa(done), "", a.bar.taskFilter == doneFilter) {
			a.bar.taskFilter = map[bool]string{true: "", false: doneFilter}[a.bar.taskFilter == doneFilter]
		}
	}
}

func (a *app) barPill(c *ui.Context, k tokens, id, label, color string, on bool) bool {
	return a.barPillEl(c, k, id, label, color, on).Clicked()
}

// barPillEl 同 Tauri pillCls：圆角胶囊，选中浅主色底 + 描边、字重 500。
func (a *app) barPillEl(c *ui.Context, k tokens, id, label, color string, on bool) ui.Element {
	b := ui.Row(c).Height(22).Padding(0, 10).Gap(6).Radius(11).AlignItems(ui.Center).Border(1, ui.Transparent).
		Role(ui.RoleButton).Label(label).Key("bpill-" + id)
	fg, w := k.muted, 400
	switch {
	case on:
		b.Background(stok(c).primary.Alpha(0.1)).Border(1, k.inputBorder)
		fg, w = k.fg, 500
	case b.Hovered():
		b.Background(k.hoverBg)
		fg = k.fg
	}
	b.Children(func() {
		if color != "" {
			ui.Box(c).Size(6, 6).Radius(3).Background(hexColor(color))
		}
		text(c, label, 11, 16, w, fg).SingleLine()
	})
	return b
}

const (
	stripGap  = 10
	stripPadX = 12
)

// strip 同 Tauri StripScroller：横向滚动、竖向滚轮转横向，只构建视口附近的卡。
// n 张卡等宽 w（由栏高按 16:17 推出），tile(i, h) 画第 i 张。
func (a *app) strip(c *ui.Context, k tokens, key string, st *ui.ScrollState, n int, follow int, followKey *string, followID string, empty string, tile func(i int, h float32)) {
	sc := ui.ScrollHorizontal(c).Grow(1).Basis(0).Scrollbars(false).TrackScroll(st).Key(key)
	b := sc.Bounds()
	h := b.H - 12
	if h < 80 {
		h = 200
	}
	w := h * 16 / 17
	sc.HandleInput(func(ev ui.InputEvent) bool {
		if ev.Kind == ui.InputScroll && abs32(ev.DY) > abs32(ev.DX) {
			st.X = min(max(st.X+ev.DY, 0), st.MaxX)
			a.panel.Invalidate()
			return true
		}
		return false
	})
	if followKey != nil && follow >= 0 && followID != *followKey && b.W > 0 { // 键盘焦点卡滚进视口（同 Tauri scrollIntoView nearest）
		*followKey = followID
		left := stripPadX + float32(follow)*(w+stripGap)
		switch {
		case left < st.X:
			st.X = max(left-stripPadX, 0)
		case left+w > st.X+b.W:
			st.X = left + w + stripPadX - b.W
		}
	}
	sc.Children(func() {
		ui.Row(c).Padding(4, stripPadX, 8, stripPadX).Gap(stripGap).AlignItems(ui.Stretch).FillHeight().Children(func() {
			if n == 0 {
				text(c, empty, 12, 18, 400, k.muted).Padding(20, 4)
				return
			}
			lo, hi := st.X-600, st.X+max(b.W, 1600)+600
			skip := float32(0)
			flush := func(at int) {
				if skip > 0 {
					ui.Box(c).Width(skip - stripGap).Key("strip-gap-" + itoa(at))
					skip = 0
				}
			}
			for i := 0; i < n; i++ {
				x := stripPadX + float32(i)*(w+stripGap)
				if x+w < lo || x > hi {
					skip += w + stripGap
					continue
				}
				flush(i)
				tile(i, h)
			}
			flush(n)
		})
	})
}

func abs32(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}

// barView：横栏形态的整块面板（Platinum 在横栏下不生效，同 Tauri platinumLayout && !horizontalBar）。
func (a *app) barView(c *ui.Context, k tokens, shell ui.Element) {
	shell.Radius(rr(14)).Children(func() {
		a.barHeader(c, k)
		if a.searchOpen {
			a.searchRow(c, k)
		}
		a.targetBar(c, k)
		a.permissionBanner(c, k)
		a.conflictBanner(c, k)
		if len(a.pending) > 0 { // 横栏高度有限：预检区限高可滚，卡串至少留一行
			ui.Scroll(c).MaxHeight(200).Scrollbars(false).Margin(0, 12, 6, 12).Children(func() { a.preflightBar(c) })
		}
		if len(a.enterAsk) > 0 {
			ui.Column(c).Margin(0, 12, 6, 12).Children(func() { a.enterAskBar(c) })
		}
		a.pageSlide(c, func(p int) { a.barPageBody(c, k, p) })
		if a.page == pageNotes && a.noteSub == 0 && a.bar.draftOpen { // 横栏：输入区默认收起，「添加笔记」唤出
			a.composerBar(c, k)
		}
		a.selectionBar(c, k)
		a.verifySheet(c, k)
		a.recentDrawer(c, k)
		a.shortcutHelp(c, k)
		a.commandPalette(c, k)
		a.updateDialog(c, k)
		a.welcomeTour(c, k)
		a.migrateWizard(c, k)
	})
}

func (a *app) barPageBody(c *ui.Context, k tokens, p int) {
	switch p {
	case pageClip:
		list := a.clipList
		if a.page != pageClip {
			list = nil
		}
		empty := tr("还没有剪贴板记录")
		if !a.store.Settings().ClipboardWatch {
			empty = tr("剪贴板历史未开启")
		}
		a.strip(c, k, "strip-clip", &a.bar.clip, len(list), a.focusIdx(pageClip), &a.bar.followClip, a.focusID(), empty, func(i int, h float32) {
			a.stripNoteTile(c, k, list[i], h, true)
		})
	case pageTasks:
		tasks := a.stripTasks()
		a.swapView(ui.Column(c).Grow(1), "bar-task-filter", a.barFilterIdx(a.bar.taskFilter, a.store.TaskSections())).Children(func() { // 分组胶囊切换带过渡
			a.strip(c, k, "strip-tasks", &a.bar.tasks, len(tasks), -1, nil, "", tr("没有进行中的任务"), func(i int, h float32) {
				a.taskTile(c, k, tasks[i], h)
			})
		})
		ui.Column(c).Padding(0, 0, 8, 0).Children(func() { a.taskQuickAdd(c, k) })
	default:
		sub := a.contentTabs(c, k)
		a.swapView(ui.Column(c).Grow(1), "csub", sub).Children(func() {
			switch sub {
			case subSecret:
				a.secretsPage(c, k)
			case subMessages:
				a.messagesPage(c, k)
			default:
				notes := a.notes
				if a.page != pageNotes {
					notes = nil
				}
				empty := tr("没有未完成的笔记卡片")
				if a.noteFilter == doneFilter {
					empty = tr("没有已完成的卡片")
				}
				strip := func() {
					a.strip(c, k, "strip-notes", &a.bar.notes, len(notes), a.focusIdx(pageNotes), &a.bar.followNote, a.focusID(), empty, func(i int, h float32) {
						a.stripNoteTile(c, k, notes[i], h, false)
					})
				}
				if !a.coachVisible() {
					a.swapView(ui.Column(c).Grow(1), "bar-note-filter", a.barFilterIdx(a.noteFilter, a.noteSections())).Children(strip) // 分组胶囊切换带过渡
					return
				}
				ui.Row(c).Grow(1).AlignItems(ui.Stretch).Children(func() { // 同 Tauri：演练 / 课程卡在左侧 w-80 一栏
					ui.Scroll(c).Width(320).Scrollbars(false).Children(func() {
						ui.Column(c).Padding(4, 4, 8, 12).Gap(8).Children(func() { a.coachCards(c, k) })
					})
					strip()
				})
			}
		})
	}
}

func (a *app) focusIdx(p int) int {
	if a.page != p || !a.focusList || a.selected >= len(a.notes) {
		return -1
	}
	return a.selected
}

func (a *app) focusID() string {
	if a.focusList && a.selected < len(a.notes) {
		return a.notes[a.selected].ID
	}
	return ""
}

// stripTasks 同 Tauri stripTasks：已到期 → 灵感 → 各组；胶囊选组只留该组，「已完成」只列已完成。
func (a *app) stripTasks() []store.Task {
	secs := a.store.TaskSections()
	b := bucketTasks(a.tasks, secs, a.now())
	if a.bar.taskFilter == doneFilter {
		return b.done
	}
	flat := append(slices.Clone(b.overdue), b.sparks...)
	for _, g := range b.groups {
		flat = append(flat, g.tasks...)
	}
	if a.bar.taskFilter == "" {
		return flat
	}
	inbox := ""
	if len(secs) > 0 {
		inbox = secs[0].ID
	}
	return slices.DeleteFunc(flat, func(t store.Task) bool {
		sec := t.Section
		if sec == "" || !slices.ContainsFunc(secs, func(s store.Section) bool { return s.ID == sec }) {
			sec = inbox
		}
		return sec != a.bar.taskFilter
	})
}

// stripNoteTile 同 Tauri NoteCard strip：16:17 近方形卡，通栏（笔记）/ 时间头（剪贴）+ 6 行正文 + 来源脚注。
// 单击选择、双击发送、右键同列表卡菜单，悬停出操作钮。
func (a *app) stripNoteTile(c *ui.Context, k tokens, n store.Note, h float32, clip bool) {
	idx, ok := a.noteIdx[n.ID]
	if !ok {
		idx = -1
	}
	focused := idx >= 0 && idx == a.selected && a.focusList
	checked := a.chosen.Has(n.ID)
	box := ui.Column(c).Width(h * 16 / 17).FillHeight().Radius(rr(10)).Clip().Key(n.ID)
	cardFill(box, k)
	k.th.Card(box, checked)
	hovered := box.Hovered()
	a.bandHover(n.ID, hovered)
	elevated(box, k, hovered || checked || focused)
	box.ContextMenu(func(m *ui.Menu) {
		if idx >= 0 {
			a.selected = idx
		}
		a.cardMenu(c, m, max(idx, 0), n)
	})
	if !clip && !n.Done {
		box.Drag(noteDrag{n.ID})
		if d, ok := ui.Drop[noteDrag](box); ok && d.id != n.ID {
			_ = a.store.MoveNoteBefore(d.id, n.ID)
		}
	}
	isLink := n.Kind == "link"
	box.Children(func() {
		// 同 Tauri 横栏串通栏（笔记与剪贴同款）：应用主色渐变底，标题（点击重命名）+ 相对时间副行，右端应用图标
		head := ui.Row(c).Height(36).Padding(0, 8).Gap(6).AlignItems(ui.Center)
		from, to := a.stripBandColors(k, n)
		head.LinearGradient(ui.LinearGradient{From: from, To: to, Angle: 135})
		head.Children(func() {
			fg := k.cardHeadText
			if !a.cardInlineInput(c, k, n) {
				title := cmpOr(n.Title, cardTitle(n))
				tb := tipOf(c, ui.Column(c).Grow(1).Basis(0).Key("strip-title").Role(ui.RoleButton).Label(title), tr("点击重命名"))
				tb.Children(func() {
					text(c, title, 11, 15, 600, fg).SingleLine()
					text(c, ago(n.CreatedAt, a.now()), 10, 13, 400, fg).SingleLine().Opacity(0.7)
				})
				if tb.Clicked() {
					a.titleEditID, a.titleText = n.ID, n.Title
				}
			}
			if n.Kept {
				liconFilled(c, map[bool]string{true: "pin", false: "star"}[clip], 12, fg)
			}
			if img := a.appIcon(n.BundleID); img != nil { // 应用图标嵌在头部右端（strip：44×36 露出 52 大图标的左半）
				ui.Row(c).Width(44).Height(36).Margin(0, -8, 0, 0).Clip().AlignItems(ui.Center).Shrink(0).Children(func() {
					ui.Image(c, img).Size(52, 52)
				})
			}
		})
		ui.Column(c).Grow(1).Basis(0).Margin(6, 8, 0, 8).Clip().Children(func() {
			if n.Blur {
				return
			}
			switch {
			case n.Kind == "image" && len(n.MediaFiles()) > 1: // 同 Tauri：多张并排 3 张 +N
				a.cardImages(c, k, n.MediaFiles(), h*16/17-16, h-36-30)
			case n.Kind == "image":
				if img := a.thumb(n.ImageFile); img != nil {
					iw, ih := ui.ImageSize(img)
					mw, mh := h*16/17-16, h-36-30
					s := min(mw/max(float32(iw), 1), mh/max(float32(ih), 1))
					ui.Image(c, img).Size(float32(iw)*s, float32(ih)*s).Radius(rr(6))
				}
			case len(n.MediaFiles()) > 0 && !isLink: // 图文：正文 + 下方缩略条
				doneText(highlightText(c, k, n.Text, a.query, 12, 18, k.fg).Wrap().MaxLines(max(1, int((h-36-30-36)/18))), k, n) // 按可用高度取整行
				a.cardThumbStrip(c, k, n.MediaFiles())
			case isLink:
				a.linkBlock(c, k, n)
			case isCode(n):
				a.codeText(c, k, n, 6)
			default:
				doneText(highlightText(c, k, n.Text, a.query, 12, 18, k.fg).Wrap().MaxLines(6), k, n)
			}
		})
		ui.Row(c).Height(16).Margin(0, 8, 6, 8).AlignItems(ui.Center).Children(func() {
			a.cardFooterLead(c, k, n)
			a.aiBusyMark(c, k, n.ID)
			if right := clipFootMeta(n); right != "" {
				text(c, right, 10, 14, 400, k.muted).SingleLine().Shrink(0).MaxWidth(150)
			}
		})
		if n.Blur {
			blurOverlay(c, k, 20)
		}
		if hovered || focused {
			if clip {
				a.clipActions(c, k, n, isLink, -1) // 同 Tauri：横栏剪贴卡不是网格瓷砖，给完整操作钮
			} else {
				a.cardActions(c, k, n)
			}
		}
		a.cardOverlays(c, k, n, checked, false)
		k.th.CardOutline(c)
		a.quickBadge(c, k, idx, 4)
	})
	clk, dbl, mods := cardPressed(box, n.ID) // 正文是拖出源，点在正文上也算点卡片
	if clk && !(mods&ui.Shift != 0 && a.rangeSelect(n.ID)) {
		a.cardClick(n.ID, idx, mods)
	}
	if dbl && idx >= 0 {
		a.cardDoubleClick(n, idx, clip)
	}
}

// taskTile 同 Tauri TaskTile：近方形卡，单击聚焦，双击展开为 384 宽编辑（点卡外保存收起），右键同任务菜单。
func (a *app) taskTile(c *ui.Context, k tokens, t store.Task, h float32) {
	done := t.Status == "done"
	open := a.taskOpen == t.ID
	w := h * 16 / 17
	if open {
		w = 384
	}
	card := ui.Column(c).Width(w).FillHeight().Padding(6, 8).Gap(6).Radius(rr(10)).Clip().Key("ttile-" + t.ID)
	if t.Spark && !done {
		card.Background(k.sparkRow)
	} else {
		cardFill(card, k)
	}
	k.th.ListRow(card)
	if a.taskFocus == t.ID {
		card.Border(2, stok(c).primary.Alpha(0.6))
	}
	hovered := card.Hovered()
	elevated(card, k, hovered)
	card.ContextMenu(func(m *ui.Menu) { a.taskMenu(c, m, t) })
	if open && card.PressedOutside() {
		id := t.ID
		a.onMain(func() {
			if a.taskOpen == id {
				a.commitTaskEdit()
				a.taskOpen = ""
			}
		})
	}
	if card.Clicked() {
		a.taskFocus = t.ID
	}
	if card.DoubleClicked() && !open {
		a.openTaskEdit(t)
	}
	card.Children(func() {
		ui.Row(c).Height(18).Gap(6).AlignItems(ui.Center).Children(func() {
			icon, col := "circle", k.muted.Alpha(0.5)
			switch {
			case done:
				icon, col = "circle-check", k.muted
			case t.Spark:
				icon, col = "lightbulb", k.violetIcon
			case t.Status == "doing":
				icon, col = "circle-dot", stok(c).primary
			}
			stLabel := fmt.Sprintf(tr("状态：%s（点击切换）"), taskStatusLabel(t.Status))
			st := tipOf(c, ui.Box(c).Size(16, 16).Role(ui.RoleButton).Label(stLabel), stLabel)
			st.Children(func() { licon(c, icon, 16, col) })
			if st.Clicked() {
				if t.Spark && !done {
					t.Spark = false
					_ = a.store.UpdateTask(t)
				} else {
					a.cycleTaskStatus(t)
				}
			}
			pri := ui.Transparent
			switch t.Priority {
			case "high":
				pri = k.danger
			case "mid":
				pri = k.amberBar
			case "low":
				pri = k.tealBar
			}
			ui.Box(c).Size(16, 3).Radius(1.5).Background(pri)
			ui.Spacer(c)
			if t.Recurrence != "" {
				licon(c, "repeat", 12, k.repeatIcon)
			}
			if ghostIconButton(c, k, "tdel-"+t.ID, "trash-2", tr("删除任务"), 16, 12, true, hovered).Clicked() {
				if removed, pos, ok := a.store.DeleteTask(t.ID); ok {
					a.showHUDUndo("ok", tr("已删除 1 个任务"), func() { _ = a.store.RestoreTask(removed, pos) })
				}
			}
		})
		if open {
			ui.Scroll(c).Grow(1).Basis(0).Scrollbars(false).Children(func() {
				ui.Column(c).Gap(6).Children(func() {
					ti := ui.TextInputBase(c, &a.taskTitle).Font(fontSans).FontSize(13).TextColor(k.fg).Label(tr("任务标题"))
					if a.taskTitleFocus {
						ti.Focus()
						a.taskTitleFocus = false
					}
					ti.OnTextKey(func(key ui.TextKey) bool {
						if key.Key == ui.KeyEnter || key.Key == ui.KeyEscape {
							a.commitTaskEdit()
							a.taskOpen = ""
							return true
						}
						return false
					})
					a.taskEditor(c, k, t)
				})
			})
			return
		}
		title := text(c, t.Text, 13, 18, 500, k.fg).Wrap().MaxLines(5)
		if done {
			title.TextColor(k.muted).Strikethrough()
		}
		ui.Spacer(c)
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			if n := len(t.Checklist); n > 0 {
				d := 0
				for _, it := range t.Checklist {
					if it.Done {
						d++
					}
				}
				text(c, fmt.Sprintf("%d/%d", d, n), 10, 14, 400, k.muted)
			}
			ui.Spacer(c)
			a.dueTrigger(c, k, t, a.now(), hovered)
		})
	})
}

// barFilterIdx：横栏分组胶囊的序号（全部 0，各组按顺序，「已完成」最后），决定切换过渡方向。
func (a *app) barFilterIdx(filter string, secs []store.Section) int {
	switch filter {
	case "":
		return 0
	case doneFilter:
		return len(secs) + 1
	}
	return 1 + slices.IndexFunc(secs, func(s store.Section) bool { return s.ID == filter })
}
