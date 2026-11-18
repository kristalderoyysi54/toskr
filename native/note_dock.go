package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 拖动一行时弹出的「放到哪个分组」坞（用户 2026-11-17，同 tasks/clip-inbox.frag.html 的 .dock）：
//   - 钉在笔记列表最上方（用户 2026-11-17：插在行旁边常被跟手的卡挡住）：列表视口让出这一条、滚动量同步补上，内容原地不跳
//   - 跟手的副本是一行小卡（图标 + 标题 + 「N 条」），不再是整张卡，挡不住分组格
//   - 格里写组内条数；放入后坞停留片刻，数字跳到新值并冒「+N」，确认放进去了
//   - 分组按「放入次数多 → 最近放入」排（常去的在第一页），没用过的保持原顺序；文件夹图标带分组色（未设色按位置给默认色）
//   - 一页 4 个分组格 + 末尾「新建分组」格；分组多于一页时两侧是翻页格，拖上去停 400ms 翻页（停着继续翻）
//   - 松手在分组格上 = 移入该组顶部（多选时整组一起走），气泡可撤销；松手在「新建分组」上 = 坞留下来就地起名，↵ 建组并放入
// 拖起的行原位淡到 0.4，跟手的副本是带卡片底与阴影的浮起卡，多选时带「N 条」角标。

const (
	dockPerPage  = 4
	dockTileH    = 50
	dockArrowW   = 22
	dockGap      = 6
	dockH        = 8 + 14 + 6 + dockTileH + 8 + 2 // 内边距 + 标题行 + 间距 + 格 + 内边距 + 描边
	dockSlotH    = 4 + dockH + 4                  // 坞在列表顶上实占的高（上下留缝）
	dockPageWait = 400 * time.Millisecond
	dockNewID    = "__new__"
	dockQuickID  = "__quick__" // 「常用」格：松手 = 设为常用（卡仍留在原分组）
)

type dockEdge struct {
	dir  int // -1 左 / 1 右 / 0 无
	from time.Time
}

// dragNotes：拖起 id 时实际带走的卡——它在多选里就是整组（按列表顺序），否则只有它自己。
func (a *app) dragNotes(id string) []store.Note {
	n, ok := a.store.Note(id)
	if !ok {
		return nil
	}
	return a.clipMoveTargets(n)
}

// sectionColorOf：分组色；未设色的按它在分组列表里的位置给一个默认色（坞里的文件夹图标用，不写回分组）。
func (a *app) sectionColorOf(s store.Section) ui.Color {
	if c, ok := sectionTint(s); ok {
		return c
	}
	i := slices.IndexFunc(a.noteSections(), func(x store.Section) bool { return x.ID == s.ID })
	return hexColor(sectionColors[(max(i, 0)+5)%len(sectionColors)]) // 从蓝色起排
}

// noteDockUse：记一次放入（坞排序用）。
func (a *app) noteDockUse(sec string) {
	cur := a.store.Settings()
	if cur.DockUse == nil {
		cur.DockUse = map[string]int{}
	}
	if cur.DockLast == nil {
		cur.DockLast = map[string]int64{}
	}
	cur.DockUse[sec]++
	cur.DockLast[sec] = a.now().Unix()
	_ = a.store.SetSettings(cur)
}

// dockSections：可放入的分组（拖起的卡都已在的组不列），常用的在前。
func (a *app) dockSections(id string) []store.Section {
	from := map[string]bool{}
	for _, n := range a.dragNotes(id) {
		from[n.Section] = true
	}
	var out []store.Section
	for _, s := range a.noteSections() {
		if !(len(from) == 1 && from[s.ID]) {
			out = append(out, s)
		}
	}
	st := a.store.Settings()
	slices.SortStableFunc(out, func(x, y store.Section) int {
		if d := st.DockUse[y.ID] - st.DockUse[x.ID]; d != 0 {
			return d
		}
		return int(st.DockLast[y.ID] - st.DockLast[x.ID])
	})
	return out
}

// moveNotesTo：把 ns 按顺序移到 sec 顶部；气泡可撤销（撤销 = 各回原组原位置）。
func (a *app) moveNotesTo(ns []store.Note, sec string) {
	type spot struct {
		id, sec string
		pos     int
	}
	var back []spot
	for _, n := range ns {
		if n.Section == sec {
			continue
		}
		pos := slices.IndexFunc(a.store.Section(n.Section), func(x store.Note) bool { return x.ID == n.ID })
		back = append(back, spot{n.ID, n.Section, pos})
	}
	if len(back) == 0 {
		return
	}
	for i, b := range back {
		_ = a.store.MoveToAt(b.id, sec, i)
	}
	a.noteDockUse(sec)
	a.reload()
	name := sec
	for _, s := range a.store.Sections() {
		if s.ID == sec {
			name = sectionName(s)
		}
	}
	msg := fmt.Sprintf(tr("已移到「%s」"), name)
	if len(back) > 1 {
		msg = fmt.Sprintf(tr("%d 条已移到「%s」"), len(back), name)
	}
	a.showHUDUndo("ok", msg, func() {
		slices.SortStableFunc(back, func(x, y spot) int { return x.pos - y.pos }) // 由前往后插回，位置才对得上
		for _, b := range back {
			_ = a.store.MoveToAt(b.id, b.sec, b.pos)
		}
		a.reload()
	})
}

type dockFlash struct {
	sec   string
	n     int
	until time.Time
}

// dockOn：本帧坞是否在列表顶上（按上一帧的拖动判断：要在建列表之前定下视口）。
func (a *app) dockOn() bool {
	return a.rowDragLast != "" || len(a.dockNaming) > 0 || dragNow().Before(a.dockFlash.until)
}

// noteDock：列表顶上的分组坞（pad 为列表左右内边距，与卡片框对齐）。
func (a *app) noteDock(c *ui.Context, k tokens, padL, padR float32) {
	naming := len(a.dockNaming) > 0
	p := stok(c).primary
	dock := ui.Column(c).Absolute().Top(4).Left(padL).Right(padR).Height(dockH).Padding(8).Gap(6).Radius(rr(12)).Background(k.card).Shrink(0).
		Border(1, p.Alpha(0.35)).Shadow(0, 2, 6, 0, k.floatShadowA).Shadow(0, 10, 24, -10, k.floatShadowB).Key("note-dock").
		Transition(ui.ElementTransition{Animation: &springControl, Enter: &ui.Motion{Y: -10, Opacity: 0}})
	if dragNow().Before(a.dockFlash.until) {
		c.Invalidate() // 停留计时
	}
	if _, py, ok := dock.PointerPosition(); ok {
		a.dockUnder = py >= 0 && py <= dockH
	}
	if _, py, ok := dock.PointerPosition(); ok {
		a.dockUnder = py >= 0 && py <= dockH
	}
	if naming {
		dock.Children(func() { a.dockNameRow(c, k) })
		return
	}
	secs := a.dockSections(a.dockFor)
	dragged := a.dragNotes(a.dockFor)
	toQuick := slices.ContainsFunc(dragged, func(n store.Note) bool { return !n.Kept }) // 拖起的都已是常用就不列「常用」格
	cells := len(secs) + 1                                                              // + 新建分组
	if toQuick {
		cells++
	}
	pages := max((cells+dockPerPage-1)/dockPerPage, 1)
	a.dockPage = min(a.dockPage, pages-1)
	cnt := len(dragged)
	dock.Children(func() {
		ui.Row(c).Height(14).Gap(6).AlignItems(ui.Center).Children(func() {
			title := tr("放到哪个分组")
			if cnt > 1 {
				title = fmt.Sprintf(tr("把 %d 条放到哪个分组"), cnt)
			}
			licon(c, "move", 11, p)
			text(c, title, 10.5, 14, 600, k.fg).Grow(1)
			if pages > 1 {
				for i := range pages {
					d := ui.Box(c).Height(4).Radius(2).Key("dock-dot-" + itoa(i))
					w, col := float32(4), k.fg.Alpha(0.15)
					if i == a.dockPage {
						w, col = 12, k.fg.Alpha(0.45)
					}
					d.Width(d.AnimateTo("w", w, tweenControl)).Background(d.AnimateColor("c", col, tweenControl))
				}
			}
		})
		ui.Row(c).Height(dockTileH).Gap(dockGap).Children(func() {
			if pages > 1 {
				a.dockArrow(c, k, -1, a.dockPage > 0, pages)
			}
			view := ui.Box(c).Grow(1).Basis(0).FillHeight().Clip().Key("dock-view")
			vw := view.Bounds().W
			tw := max((vw-dockGap*(dockPerPage-1))/dockPerPage, 40)
			view.Children(func() {
				strip := ui.Row(c).Gap(dockGap).Height(dockTileH).Key("dock-strip")
				strip.Translate(strip.AnimateTo("x", -float32(a.dockPage)*(vw+dockGap), springControl), 0)
				strip.Children(func() {
					if toQuick {
						a.dockTile(c, k, store.Section{ID: dockQuickID, Name: tr("常用")}, tw)
					}
					for _, s := range secs {
						a.dockTile(c, k, s, tw)
					}
					a.dockTile(c, k, store.Section{ID: dockNewID, Name: tr("新建分组")}, tw)
				})
			})
			if pages > 1 {
				a.dockArrow(c, k, 1, a.dockPage < pages-1, pages)
			}
		})
	})
}

// dockTile：一个分组格（图标 / 分组色 + 名字）。拖到上面主色描边 + 浮起，松手移入；「新建分组」格是虚线框。
func (a *app) dockTile(c *ui.Context, k tokens, s store.Section, w float32) {
	p := stok(c).primary
	isNew, isQuick := s.ID == dockNewID, s.ID == dockQuickID
	label := fmt.Sprintf(tr("放到「%s」"), sectionName(s))
	switch {
	case isNew:
		label = tr("新建分组并放入")
	case isQuick:
		label = tr("设为常用")
	}
	t := ui.Column(c).Size(w, dockTileH).Shrink(0).Radius(rr(9)).Gap(3).AlignItems(ui.Center).Justify(ui.Center).Padding(0, 4).
		Key("dock-" + s.ID).Label(label)
	_, over := ui.DragOver[noteDrag](t)
	tint := a.sectionColorOf(s)
	if isQuick {
		tint = k.amberText
	}
	bgA := map[bool]float32{true: 0.2, false: 0.12}[k.dark]
	bg, edge := tint.Alpha(bgA), tint.Alpha(bgA+0.08)
	if isNew {
		bg, edge = k.fg.Alpha(0), k.fg.Alpha(0.22)
		t.BorderStyle(ui.BorderDashed)
	}
	if over {
		bg, edge = tint.Alpha(bgA+0.12), tint
		if isNew {
			bg, edge = p.Alpha(0.12), p
		}
	}
	t.Background(t.AnimateColor("bg", bg, tweenTw)).Border(1, t.AnimateColor("edge", edge, tweenTw))
	t.AnimatePose(ui.Pose{Y: map[bool]float32{true: -2}[over], Scale: map[bool]float32{true: 1.04, false: 1}[over]}, springControl)
	t.Children(func() {
		ui.Box(c).Height(16).Center().Children(func() {
			switch {
			case isNew:
				licon(c, "folder-plus", 16, map[bool]ui.Color{true: p, false: k.muted}[over])
			case isQuick:
				liconFilled(c, "star", 16, tint)
			case s.ID == store.SectionInbox:
				licon(c, "inbox", 16, tint)
			default:
				liconFilled(c, "folder", 18, tint) // 实心文件夹 + 分组色：一眼区分各组
			}
		})
		fg := k.fg
		if isNew {
			fg = k.muted
		}
		ui.Row(c).Height(14).Gap(4).AlignItems(ui.Center).MaxWidth(w - 8).Children(func() {
			text(c, sectionName(s), 11, 14, 600, fg).SingleLine().Shrink(1)
			if isNew || isQuick {
				return
			}
			// 组内条数；刚放入时变成分组色胶囊弹一下，上方冒「+N」
			flash := a.dockFlash.sec == s.ID && dragNow().Before(a.dockFlash.until)
			cnt := ui.Box(c).Height(14).Padding(0, 4).Radius(7).Center().Shrink(0).Key("cnt")
			cnt.AnimatePose(ui.Pose{Scale: map[bool]float32{true: 1.2, false: 1}[flash]}, springModal)
			col := k.muted
			if flash {
				cnt.Background(tint)
				col = ui.RGB(255, 255, 255)
			}
			cnt.Children(func() {
				text(c, itoa(a.sectionCount(s.ID)), 9.5, 12, 600, col)
				if flash {
					ui.Box(c).Absolute().Right(-2).Top(-15).PassThrough().Key("plus-" + itoa(a.dockFlash.n)).
						Transition(ui.ElementTransition{Animation: &springModal, Enter: &ui.Motion{Y: 8, Opacity: 0}}).
						Children(func() { text(c, "+"+itoa(a.dockFlash.n), 10, 12, 700, tint) })
				}
			})
		})
	})
	if d, ok := ui.Drop[noteDrag](t); ok {
		ns := a.dragNotes(d.id)
		if isNew {
			a.dockNaming, a.dockNewName = noteIDs(ns), ""
			return
		}
		if isQuick {
			a.keepNotes(ns, "")
			return
		}
		before := a.sectionCount(s.ID)
		a.moveNotesTo(ns, s.ID)
		if d := a.sectionCount(s.ID) - before; d > 0 {
			a.dockFlash = dockFlash{sec: s.ID, n: d, until: dragNow().Add(900 * time.Millisecond)}
		}
	}
}

// sectionCount：组内未完成条数。
func (a *app) sectionCount(sec string) int {
	n := 0
	for _, x := range a.store.Section(sec) {
		if !x.Done {
			n++
		}
	}
	return n
}

// dragRowH：拖起的行原位收成的高（一行小卡 + 上下留缝）。
const dragRowH = 44

// dragMini：拖动时的一行小卡（图标 + 标题 + 多选「N 条」）。行收成 dragRowH 高，小卡贴在行顶：
// 原位是它淡到 0.4 的占位，跟手副本是同一份（框架按按下点对齐指针；按在头行附近时小卡就在指针下）。
func (a *app) dragMini(c *ui.Context, k tokens, n store.Note, rowW float32) {
	const h = 34
	w := min(float32(260), rowW-12)
	x, y := float32(6), float32((dragRowH-h)/2)
	title := cmpOr(strings.TrimSpace(n.Title), cmpOr(firstLine(n.Text), cardTitle(n)))
	cnt := len(a.dragNotes(n.ID))
	ui.Row(c).Absolute().Left(x).Top(y).Size(w, h).Padding(0, 10).Gap(8).Radius(rr(10)).AlignItems(ui.Center).PassThrough().
		Background(k.card).Border(1, stok(c).primary.Alpha(0.5)).Shadow(0, 10, 24, -8, k.floatShadowB).Shadow(0, 1, 3, 0, k.floatShadowA).
		Key("drag-mini").Children(func() {
		ui.Box(c).Size(16, 16).Center().Shrink(0).Children(func() { a.listLead(c, k, n) })
		text(c, previewCap(title), 12, 16, 500, k.fg).SingleLine().Grow(1).Basis(0)
		if cnt > 1 {
			ui.Box(c).Height(18).Padding(0, 7).Radius(9).Background(stok(c).primary).Center().Shrink(0).
				Children(func() { text(c, fmt.Sprintf(tr("%d 条"), cnt), 10.5, 14, 600, ui.RGB(255, 255, 255)) })
		}
	})
}

// dockNameRow：松手在「新建分组」上之后，坞留下来就地起名：↵ 建组并把卡放进去，Esc / 取消 作罢。
func (a *app) dockNameRow(c *ui.Context, k tokens) {
	ui.Row(c).Height(14).Children(func() {
		text(c, fmt.Sprintf(tr("新建分组，放入 %d 条"), len(a.dockNaming)), 10, 14, 500, k.muted)
	})
	ui.Row(c).Height(dockTileH).Gap(8).AlignItems(ui.Center).Children(func() {
		licon(c, "folder-plus", 16, stok(c).primary)
		ui.TextInputBase(c, &a.dockNewName).Grow(1).Height(32).Padding(0, 10).Radius(rr(8)).Background(k.track).Border(1, k.inputBorder).
			Font(fontSans).FontSize(12).TextColor(k.fg).Focus().Label(tr("分组名称")).Placeholder(tr("分组名，↵ 创建并放入")).
			OnTextKey(func(key ui.TextKey) bool {
				switch key.Key {
				case ui.KeyEnter:
					a.dockCreate(key.Text())
					return true
				case ui.KeyEscape:
					a.dockNaming, a.dockNewName = nil, ""
					return true
				}
				return false
			})
		b := ui.Row(c).Height(26).Padding(0, 8).Radius(rr(6)).AlignItems(ui.Center).Role(ui.RoleButton).Label(tr("取消")).Key("dock-cancel")
		if b.Hovered() {
			b.Background(k.hoverBg)
		}
		b.Children(func() { text(c, tr("取消"), 11, 16, 500, k.muted) })
		if b.Clicked() {
			a.dockNaming, a.dockNewName = nil, ""
		}
	})
}

func (a *app) dockCreate(name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	ids := a.dockNaming
	a.dockNaming, a.dockNewName = nil, ""
	sec := a.store.AddSection(name)
	if sec == "" {
		return
	}
	var ns []store.Note
	for _, id := range ids {
		if n, ok := a.store.Note(id); ok {
			ns = append(ns, n)
		}
	}
	a.moveNotesTo(ns, sec)
}

// dockArrow：翻页格。拖到上面停 dockPageWait 翻一页（停着继续翻），可翻时亮起。
func (a *app) dockArrow(c *ui.Context, k tokens, dir int, live bool, pages int) {
	b := ui.Box(c).Width(dockArrowW).FillHeight().Shrink(0).Radius(rr(8)).Center().Key("dock-arrow-" + itoa(dir)).
		Label(map[int]string{-1: tr("上一页分组"), 1: tr("下一页分组")}[dir])
	_, over := ui.DragOver[noteDrag](b)
	if over && live {
		if a.dockEdge.dir != dir {
			a.dockEdge = dockEdge{dir: dir, from: dragNow()}
		}
		if dragNow().Sub(a.dockEdge.from) >= dockPageWait {
			a.dockPage = min(max(a.dockPage+dir, 0), pages-1)
			a.dockEdge.from = dragNow()
		}
		c.Invalidate() // 指针不动也要出帧，计时才走
	} else if a.dockEdge.dir == dir {
		a.dockEdge = dockEdge{}
	}
	bg := k.fg.Alpha(0)
	if over && live {
		bg = stok(c).primary.Alpha(0.12)
	}
	b.Background(b.AnimateColor("bg", bg, tweenTw))
	b.Children(func() {
		col := k.muted.Alpha(0.35)
		if live {
			col = k.fg
		}
		licon(c, map[int]string{-1: "chevron-left", 1: "chevron-right"}[dir], 14, col)
	})
}
