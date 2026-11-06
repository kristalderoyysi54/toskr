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
	stripH                 map[string]float32 // 各卡串上次用的栏高：变了（输入区开合 / 预检出现）就再排一帧
	followClip, followNote string             // 上次已滚进视口的焦点卡
}

// barHeader：横栏单行头部——左「Toskr + 页签」，中分组胶囊，右工具钮（同 Tauri horizontalBar 头部）。
func (a *app) barHeader(c *ui.Context, k tokens) {
	ui.Row(c).Height(40).Padding(8, 12, 4, 16).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Row(c).Grow(1).Basis(0).Gap(10).AlignItems(ui.Center).Children(func() {
			text(c, "Toskr", 13, 18, 600, k.fg).LetterSpacing(-0.325).Cursor(ui.CursorGrab).
				Tooltip(tr("拖动此处可移动面板（未吸附时）")).DragWindow()
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
			p.ContextMenu(func(m *ui.Menu) { a.sectionMenu(m, s, i, len(secs)) })
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
	if a.bar.stripH == nil {
		a.bar.stripH = map[string]float32{}
	}
	if a.bar.stripH[key] != b.H { // 卡高取自上一帧栏高：栏高变了要再排一帧，否则卡底被裁
		a.bar.stripH[key] = b.H
		c.Invalidate()
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
	shell.Radius(14).Children(func() {
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
		a.strip(c, k, "strip-tasks", &a.bar.tasks, len(tasks), -1, nil, "", tr("没有进行中的任务"), func(i int, h float32) {
			a.taskTile(c, k, tasks[i], h)
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
				a.strip(c, k, "strip-notes", &a.bar.notes, len(notes), a.focusIdx(pageNotes), &a.bar.followNote, a.focusID(), empty, func(i int, h float32) {
					a.stripNoteTile(c, k, notes[i], h, false)
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
	box := ui.Column(c).Size(h*16/17, h).Radius(10).Clip().Key(n.ID)
	cardFill(box, k)
	hovered := box.Hovered()
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
		head := ui.Row(c).Height(36).Padding(0, 8).Gap(6).AlignItems(ui.Center)
		if !clip {
			from, to := a.bandColors(k, n)
			head.LinearGradient(ui.LinearGradient{From: from, To: to, Angle: 135})
		}
		head.Children(func() {
			fg := k.cardHeadText
			title := cardTitle(n)
			if n.Title != "" {
				title = n.Title
			}
			if clip {
				fg, title = k.muted, ago(n.CreatedAt, a.now())
			}
			text(c, title, 11, 16, 600, fg).SingleLine().Grow(1).Basis(0)
			if n.Kept {
				liconFilled(c, map[bool]string{true: "pin", false: "star"}[clip], 12, fg)
			}
			if img := a.appIcon(n.BundleID); img != nil { // 应用图标嵌在头部右端（strip：44×36 露出 52 大图标的左半）
				ui.Box(c).Width(44).Height(36).Margin(0, -8, 0, 0).Clip().AlignItems(ui.Center).Children(func() {
					ui.Image(c, img).Size(52, 52)
				})
			}
		})
		ui.Column(c).Grow(1).Basis(0).Margin(6, 8, 0, 8).Clip().Children(func() {
			if n.Blur {
				return
			}
			switch {
			case n.Kind == "image":
				if img := a.thumb(n.ImageFile); img != nil {
					iw, ih := ui.ImageSize(img)
					mw, mh := h*16/17-16, h-36-30
					s := min(mw/max(float32(iw), 1), mh/max(float32(ih), 1))
					ui.Image(c, img).Size(float32(iw)*s, float32(ih)*s).Radius(6)
				}
			case isLink:
				a.linkBlock(c, k, n)
			case isCode(n):
				a.codeText(c, k, n)
			default:
				highlightText(c, k, n.Text, a.query, 12, 18, k.fg).Wrap().MaxLines(6)
			}
		})
		ui.Row(c).Height(16).Margin(0, 8, 6, 8).AlignItems(ui.Center).Children(func() {
			src := ""
			if n.SourceApp != "" {
				src = tr("来自 ") + n.SourceApp
			}
			text(c, src, 10, 14, 400, k.muted).SingleLine().Grow(1)
			a.aiBusyMark(c, k, n.ID)
			if !clip {
				text(c, ago(n.CreatedAt, a.now()), 10, 14, 400, k.muted)
			}
		})
		if n.Blur {
			blurOverlay(c, k, 20)
		}
		if hovered || focused {
			if clip {
				a.clipActions(c, k, n, isLink, -1, true)
			} else {
				a.cardActions(c, k, n)
			}
		}
		a.cardOverlays(c, k, n, checked, false)
		a.quickBadge(c, k, idx, 4)
	})
	if box.Clicked() && !(box.ClickModifiers()&ui.Shift != 0 && a.rangeSelect(n.ID)) {
		a.cardClick(n.ID, idx, box.ClickModifiers())
	}
	if box.DoubleClicked() && idx >= 0 {
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
	card := ui.Column(c).Size(w, h).Padding(6, 8).Gap(6).Radius(10).Clip().Key("ttile-" + t.ID)
	if t.Spark && !done {
		card.Background(k.sparkRow)
	} else {
		cardFill(card, k)
	}
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
			st := ui.Box(c).Size(16, 16).Role(ui.RoleButton).Label(stLabel).Tooltip(stLabel)
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
