package main

import (
	"fmt"
	"slices"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 内容页的「常用」区、收件箱头部操作（按建议归好 / 逐条整理）、收件箱卡片上的建议分组、逐条整理浮层。

const (
	quickCols    = 3
	quickRowsMax = 3 // 最多露出 3 行，更多的在区内纵向滚动
	quickCardH   = 56
	quickGap     = 6
)

// quickSort：常用区的拖动状态。active 是区内拿起的方块（排序），over 是指针所在的槽位（排序落点 / 外面的卡拖进来时插到它前面）。
// left：拿起的方块离开过自己的格子（到过别的格子 / 拖出过常用区）。没离开过就松手 = 点击时手滑了几个点，按点击发送。
type quickSort struct {
	active, over string
	left         bool
}

// quickNotes：常用区内容（用户 2026-11-18 定，同 Arc 的常用书签）——只放设为常用（★）的卡，顺序是拖动排出来的 order，
// 不在 order 里的（菜单里设的 / 旧数据）排在后面；剪贴板、已完成不进。没有就不显示这个区。
func quickNotes(all []store.Note, order []string) []store.Note {
	rank := make(map[string]int, len(order))
	for i, id := range order {
		rank[id] = i
	}
	var out []store.Note
	for _, n := range all {
		if n.Kept && !n.Done && n.Section != store.SectionClipboard {
			out = append(out, n)
		}
	}
	slices.SortStableFunc(out, func(x, y store.Note) int {
		rx, okx := rank[x.ID]
		ry, oky := rank[y.ID]
		switch {
		case okx && oky:
			return rx - ry
		case okx:
			return -1
		case oky:
			return 1
		}
		return 0
	})
	return out
}

func (a *app) quickStripShown() bool {
	return len(a.quick) > 0 && a.noteFilter == "" && a.query == ""
}

// quickStripHeight：常用区实占高度（每行 3 个，最多露出 3 行）。
func (a *app) quickStripHeight() float32 {
	rows := min((len(a.quick)+quickCols-1)/quickCols, quickRowsMax)
	return float32(rows)*quickCardH + float32(rows-1)*quickGap
}

// quickMoved：ids 里把 active 挪到 over 的位置（拖动排序的结果 / 预览）。
func quickMoved(ids []string, active, over string) []string {
	i, j := slices.Index(ids, active), slices.Index(ids, over)
	if i < 0 || j < 0 || i == j {
		return ids
	}
	out := slices.Delete(slices.Clone(ids), i, i+1)
	return slices.Insert(out, j, active)
}

func (a *app) setQuickOrder(ids []string) {
	cur := a.store.Settings()
	cur.QuickOrder = ids
	_ = a.store.SetSettings(cur)
	a.reload()
}

// keepNotes：把 ns 设为常用，插到常用区 before 之前（"" = 排到最后）；卡仍留在原分组。气泡可撤销。
func (a *app) keepNotes(ns []store.Note, before string) {
	var add []string
	for _, n := range ns {
		if !n.Kept && !n.Done && n.Section != store.SectionClipboard {
			_ = a.store.SetKept(n.ID, true)
			add = append(add, n.ID)
		}
	}
	if len(add) == 0 {
		return
	}
	ids := noteIDs(a.quick)
	at := slices.Index(ids, before)
	if at < 0 {
		at = len(ids)
	}
	a.setQuickOrder(slices.Insert(ids, at, add...))
	msg := tr("已设为常用")
	if len(add) > 1 {
		msg = fmt.Sprintf(tr("%d 条已设为常用"), len(add))
	}
	a.showHUDUndo("ok", msg, func() {
		for _, id := range add {
			_ = a.store.SetKept(id, false)
		}
		a.reload()
	})
}

// quickMoveOut：常用方块拖到分组 sec 里松手 = 取消常用并移入该组（before 非空则落到那一行前面；已在该组就只取消常用）。气泡可撤销。
func (a *app) quickMoveOut(id, sec, before string) {
	n, ok := a.store.Note(id)
	if !ok {
		return
	}
	pos := slices.IndexFunc(a.store.Section(n.Section), func(x store.Note) bool { return x.ID == id })
	order := noteIDs(a.quick)
	switch {
	case before != "":
		_ = a.store.MoveNoteBefore(id, before)
	case n.Section != sec:
		_ = a.store.MoveToAt(id, sec, 0)
	}
	_ = a.store.SetKept(id, false)
	a.reload()
	a.showHUDUndo("ok", tr("已取消常用"), func() {
		_ = a.store.MoveToAt(id, n.Section, pos)
		_ = a.store.SetKept(id, true)
		a.setQuickOrder(order)
	})
}

// quickStrip：常用区（同 Arc 的常用书签格）。每行 3 个等分宽度，最多露出 3 行，更多的在区内纵向滚动（不显示滚动条，上下缘的行渐隐）。
// 点一下发送；拖动换位置；列表里的卡拖进来 = 设为常用；方块拖到分组头 / 分组里的行上 = 取消常用并移入该组。
func (a *app) quickStrip(c *ui.Context, k tokens) {
	ids := noteIDs(a.quick)
	qs := &a.quickSort
	wrap := ui.Box(c).Height(a.quickStripHeight()).FillWidth().Key("quick-strip")
	// 方块自己不接收放下：区内排序与外面拖进来的卡，松手都落到这个容器上，落点按 qs.over
	drag, over := ui.DragOver[noteDrag](wrap)
	a.quickJump = false
	tapped := "" // 按下后移了几个点被框架当成拖动、又在原格松手的方块：按点击发送
	if d, ok := ui.Drop[noteDrag](wrap); ok {
		if d.quick {
			if next := quickMoved(ids, d.id, qs.over); !slices.Equal(next, ids) {
				a.setQuickOrder(next)
				ids = noteIDs(a.quick)
			} else if !qs.left {
				tapped = d.id
			}
		} else {
			a.keepNotes(a.dragNotes(d.id), qs.over)
			ids = noteIDs(a.quick)
		}
		*qs, over = quickSort{}, false
		a.quickJump = true
	}
	if i := slices.Index(ids, tapped); i >= 0 && a.quickClickOnce(tapped, c.Now()) {
		diag.Push("常用: 原格松手按点击发送 %s", tapped)
		a.sendFromList([]store.Note{a.quick[i]})
	}
	quick := a.quick                // 本帧快照：方块右键「取消常用」会在下面的循环里 reload 换掉 a.quick，按旧长度取就越界
	incoming := over && !drag.quick // 列表里的卡正拖在常用区上：整区描边，指着的方块前出插入线
	switch {
	case !over && a.quickDragLast == "": // 没在拖 / 在别处松手了
		*qs = quickSort{}
	case !over: // 方块拖出了常用区：其余的回原位
		qs.over, qs.left = qs.active, true
	}
	shown := quickMoved(ids, qs.active, qs.over)
	rows := (len(ids) + quickCols - 1) / quickCols
	viewH := a.quickStripHeight()
	grid := func() {
		ui.Column(c).Gap(quickGap).FillWidth().Children(func() {
			for r := range rows {
				row := ui.Row(c).Height(quickCardH).Gap(quickGap).Key("quick-row-" + itoa(r))
				if rows > quickRowsMax { // 上下缘渐隐：滚出视口的那部分越多越淡。不用底色渐变盖：面板底是半透明材质，盖上去颜色对不上
					y0 := float32(r)*(quickCardH+quickGap) - a.quickScroll.Y
					cut := max(-y0, y0+quickCardH-viewH, 0)
					row.Opacity(1 - 0.8*min(cut/quickCardH, 1))
				}
				row.Children(func() {
					for col := range quickCols {
						i := r*quickCols + col
						slot := ui.Box(c).Grow(1).Basis(0).FillHeight().Key("quick-slot-" + itoa(i))
						if i >= len(ids) {
							continue // 末行补空槽：方块宽度恒为三分之一
						}
						n := quick[i]
						w := slot.Bounds().W
						if over || qs.active != "" { // 只在拖动中读指针，免得平时每次移动鼠标都重建
							if px, py, ok := slot.PointerPosition(); ok && px >= 0 && px < w+quickGap && py >= 0 && py < quickCardH+quickGap {
								qs.over = n.ID
								qs.left = qs.left || (qs.active != "" && n.ID != qs.active)
							}
						}
						j := slices.Index(shown, n.ID) // 让位后的格子
						dx := float32(j%quickCols-col) * (w + quickGap)
						dy := float32(j/quickCols-r) * (quickCardH + quickGap)
						slot.Children(func() {
							mv := ui.Box(c).Fill().Key("quick-mv-" + n.ID)
							if a.quickJump { // 落下那一帧直接归位（顺序已换，不从旧位置滑回）
								mv.Translate(mv.Jump("sx", 0), mv.Jump("sy", 0))
							} else {
								mv.Translate(mv.AnimateTo("sx", dx, tw(250, easeCSS)), mv.AnimateTo("sy", dy, tw(250, easeCSS)))
							}
							mv.Children(func() { a.quickCard(c, k, n, w) })
							if incoming && qs.over == n.ID {
								ui.Box(c).Absolute().Left(-quickGap/2 - 1).Top(4).Bottom(4).Width(2).Radius(1).Background(stok(c).primary).PassThrough().Key("quick-insert")
							}
						})
					}
				})
			}
		})
	}
	wrap.Children(func() {
		if rows <= quickRowsMax {
			a.quickScroll = ui.ScrollState{}
			grid()
		} else {
			ui.Scroll(c).Fill().Scrollbars(false).TrackScroll(&a.quickScroll).Key("quick-scroll").Children(grid)
		}
		if incoming {
			p := stok(c).primary
			ui.Box(c).Absolute().Top(-3).Left(-3).Right(-3).Bottom(-3).Radius(rr(12)).Border(1, p).BorderStyle(ui.BorderDashed).
				Background(p.Alpha(0.06)).PassThrough().Key("quick-incoming")
		}
	})
}

// quickCard：常用方块（宽 w，上一帧槽位量到的）。有图：图片铺满，底部渐暗压标题，停留 360ms 弹原图窥视窗（← → 换张）；
// 无图：标题最多 2 行 + 发送次数。点一下发送；拖动换位置；右键更多。
func (a *app) quickCard(c *ui.Context, k tokens, n store.Note, w float32) {
	title := cmpOr(n.Title, cmpOr(firstLine(n.Text), cardTitle(n)))
	files := n.MediaFiles()
	var img ui.ImageSource
	if len(files) > 0 && !n.Blur {
		img = a.thumb(files[0])
	}
	if w <= 0 {
		w = 96
	}
	b := tipOf(c, ui.Box(c).Fill().Radius(rr(10)).Clip().Key("quick-"+n.ID).Role(ui.RoleButton).Label(tr("发送：")+title),
		fmt.Sprintf(tr("%s · 已发送 %d 次 · 点一下发送，拖动换位置"), preview(title, 24), n.SendCount))
	hovered := b.Hovered()
	if hovered {
		b.Background(k.card)
	} else {
		b.Background(k.track)
	}
	lifted(b, k, hovered)
	b.Drag(noteDrag{id: n.ID, quick: true})
	dragging := b.Dragging()
	if dragging {
		if a.quickSort.active != n.ID {
			a.quickSort = quickSort{active: n.ID, over: n.ID}
		}
		a.quickDragID = n.ID
		b.Opacity(0.4).Cursor(ui.CursorGrabbing) // 原位淡成占位，跟手的是框架画的副本
	}
	lift := hovered && !dragging && a.quickSort.active == ""
	b.AnimatePose(ui.Pose{Y: map[bool]float32{true: -2}[lift], Scale: pressScale(b.Pressed(), 0.96)}, springControl)
	b.ContextMenu(func(m *ui.Menu) {
		if m.Item(tr("在列表中查看")).Chosen() {
			a.focusNote(n)
		}
		if m.Item(tr("取消常用")).Chosen() {
			order := noteIDs(a.quick)
			_ = a.store.SetKept(n.ID, false)
			a.reload()
			a.showHUDUndo("ok", tr("已取消常用"), func() {
				_ = a.store.SetKept(n.ID, true)
				a.setQuickOrder(order)
			})
		}
	})
	white := ui.RGB(255, 255, 255)
	b.Children(func() {
		if img != nil {
			iw, ih := ui.ImageSize(img)
			sc := max(w/max(float32(iw), 1), quickCardH/max(float32(ih), 1)) // 铺满方块（cover）
			ui.Box(c).Fill().Center().Children(func() {
				im := ui.Image(c, img).Size(float32(iw)*sc, float32(ih)*sc)
				im.AnimatePose(ui.Pose{Scale: map[bool]float32{true: 1.08, false: 1}[hovered]}, springControl) // 悬停：图慢慢推近
			})
			ui.Box(c).Absolute().Left(0).Right(0).Bottom(0).Height(36).Gradient(ui.RGBA(0, 0, 0, 0), ui.RGBA(0, 0, 0, 0.62), 180).PassThrough()
			ui.Column(c).Absolute().Left(7).Right(7).Bottom(5).Gap(0).PassThrough().Children(func() {
				text(c, title, 10.5, 14, 600, white).SingleLine()
				text(c, fmt.Sprintf(tr("%d 次"), n.SendCount), 9, 12, 500, white.Alpha(0.8)).Font(fontMono)
			})
			if len(files) > 1 {
				ui.Box(c).Absolute().Right(5).Top(5).Height(15).Padding(0, 5).Radius(8).Background(ui.RGBA(0, 0, 0, 0.5)).Center().PassThrough().
					Children(func() { text(c, itoa(len(files)), 9, 12, 600, white) })
			}
		} else {
			ui.Column(c).Fill().Padding(6, 8).Gap(0).Children(func() {
				text(c, title, 11, 15, 500, k.fg).Wrap().MaxLines(2)
				ui.Box(c).Grow(1)
				text(c, fmt.Sprintf(tr("%d 次"), n.SendCount), 9, 12, 400, k.muted).Font(fontMono)
			})
		}
		if hovered && !dragging { // 悬停：右下出发送图标（区里全是常用卡，不再画星标）
			ui.Box(c).Absolute().Right(6).Bottom(6).Size(12, 12).Center().PassThrough().Children(func() {
				licon(c, "send", 11, map[bool]ui.Color{true: white, false: stok(c).primary}[img != nil])
			})
		}
	})
	if img != nil && a.quickSort.active == "" {
		a.compactHover(c, b, n) // 停留弹原图（文字截图看得清）
	}
	if b.Clicked() && a.quickClickOnce(n.ID, c.Now()) {
		diag.Push("常用: 点击发送 %s", n.ID)
		a.sendFromList([]store.Note{n})
	}
}

// quickRepeatGap：同一个常用方块两次点击间隔短于它算一次（双击 / 手抖连点只发一遍）。
const quickRepeatGap = 600 * time.Millisecond

// quickClickOnce：这次点击该不该发送——同一方块紧跟着的第二下不发。
func (a *app) quickClickOnce(id string, now time.Time) bool {
	if a.quickSentID == id && now.Sub(a.quickSentAt) < quickRepeatGap {
		a.quickSentAt = now // 连点三四下也只算最初那一次
		return false
	}
	a.quickSentID, a.quickSentAt = id, now
	return true
}

// inboxHeadActions：收件箱分组头右侧的「按建议归好 N 条」（主题色浅底）与「逐条整理」（灰底）。
func (a *app) inboxHeadActions(c *ui.Context, k tokens, g noteGroup) {
	chip := func(key, icon, label, tip string, primary bool) bool {
		return pillChip(c, k, key, icon, label, tip, primary)
	}
	if n := len(a.inboxSug); n >= 2 && chip("inbox-fileall", "check", fmt.Sprintf(tr("按建议归好 %d 条"), n), tr("把有建议分组的都归过去（可撤销）"), true) {
		a.fileAllSuggested()
	}
	if len(g.open) >= 2 && len(a.fileTargets()) > 0 && chip("inbox-triage", "layers", tr("逐条整理"), tr("一条一条看，按数字键归类"), false) {
		a.triageOn, a.triageSkip = true, map[string]bool{}
	}
}

// inboxSugChip：收件箱卡片通栏上的建议分组——普通建议是主题色虚线描边，按规则得出的是实线浅底。点一下归过去。
func (a *app) inboxSugChip(c *ui.Context, k tokens, n store.Note) {
	sug, ok := a.inboxSug[n.ID]
	if !ok || n.Section != store.SectionInbox {
		return
	}
	p := stok(c).primary
	name := a.sectionLabel(sug.section)
	b := tipOf(c, ui.Row(c).Height(18).Gap(3).Padding(0, 7).Radius(999).AlignItems(ui.Center).Shrink(0).Background(k.card).
		Key("sug-"+n.ID).Role(ui.RoleButton).Label(tr("归到 ")+name), tr("建议：")+sug.why)
	switch {
	case sug.rule:
		b.Background(p.Mix(k.card, 0.88)).Border(1, p)
	case b.Hovered():
		b.Background(p.Mix(k.card, 0.88)).Border(1, p)
	default:
		b.Border(1, p).BorderStyle(ui.BorderDashed)
	}
	b.Children(func() {
		licon(c, "arrow-right", 10, p)
		text(c, name, 10, 14, 500, p).SingleLine()
	})
	if b.Clicked() {
		to := sug.section
		a.fileInbox([]string{n.ID}, func(store.Note) string { return to }, false)
	}
}

// triageQueue：逐条整理还没处理的条目（跳过的排到最后不再出现）。
func (a *app) triageQueue() []store.Note {
	var out []store.Note
	for _, n := range a.store.Section(store.SectionInbox) {
		if !n.Done && !a.triageSkip[n.ID] {
			out = append(out, n)
		}
	}
	return out
}

// triagePanel：逐条整理浮层——一次一条，数字键 1–9 归到对应分组（与「收到哪里」同一套键位），空格跳过，⏎ 归到建议分组，Esc 退出。
func (a *app) triagePanel(c *ui.Context, k tokens) {
	if !a.triageOn || a.page != pageNotes {
		return
	}
	queue := a.triageQueue()
	secs := a.fileTargets()
	if len(queue) == 0 || len(secs) == 0 {
		a.triageOn = false
		if len(queue) == 0 {
			a.showHUD("ok", tr("收件箱整理完了"))
		}
		return
	}
	n := queue[0]
	total := len(queue) + len(a.triageSkip)
	sug, hasSug := a.inboxSug[n.ID]
	p := stok(c).primary
	white := ui.RGB(255, 255, 255)
	file := func(to string) { a.fileInbox([]string{n.ID}, func(store.Note) string { return to }, false) }
	w, h := c.Size()
	ui.Overlay(c, func() {
		if ui.Box(c).Absolute().Left(0).Top(0).Size(w, h).Background(ui.RGBA(0, 0, 0, 0.18)).Key("triage-dim").Clicked() {
			a.triageOn = false
		}
		pw := min(float32(340), w-24)
		pop := floatSurface(ui.Column(c).Absolute().Left((w-pw)/2).Top(max(12, h*0.18)).Width(pw).Padding(14).Gap(10).Radius(rr(14)).Key("triage"), k)
		switch {
		case pop.OverlayShortcut(0, ui.KeyEscape):
			a.triageOn = false
		case pop.OverlayShortcut(0, ui.KeySpace):
			a.triageSkip[n.ID] = true
		case pop.OverlayShortcut(0, ui.KeyEnter) && hasSug:
			file(sug.section)
		default:
			for i, s := range secs {
				if pop.OverlayShortcut(0, digitKeys[i]) {
					file(s.ID)
				}
			}
		}
		pop.Children(func() {
			// 标题 + 进度
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				licon(c, "layers", 13, k.fg)
				text(c, tr("逐条整理"), 12.5, 18, 600, k.fg)
				ui.Box(c).Grow(1)
				text(c, fmt.Sprintf(tr("第 %d / %d 条"), total-len(queue)+1, total), 10.5, 15, 400, k.muted).Font(fontMono)
			})
			done := float32(total-len(queue)) / float32(max(total, 1))
			ui.Box(c).Height(3).FillWidth().Radius(2).Background(k.track).Children(func() {
				ui.Box(c).Absolute().Left(0).Top(0).Bottom(0).Width(max(3, (pw-28)*done)).Radius(2).Background(p)
			})
			// 当前这条
			ui.Column(c).FillWidth().Padding(10, 12).Gap(4).Radius(rr(10)).Background(k.track).Key("triage-item-" + n.ID).Children(func() {
				text(c, cmpOr(n.Title, cardTitle(n)), 10, 14, 500, k.muted).SingleLine()
				body := cmpOr(n.LinkTitle, cmpOr(n.Text, cardImageMeta(n)))
				t := text(c, body, 12.5, 19, 400, k.fg).Wrap().MaxLines(4)
				if isCode(n) {
					t.Font(fontMono).FontSize(11.5)
				}
				src := ago(n.CreatedAt, a.now())
				if n.SourceApp != "" {
					src = n.SourceApp + " · " + src
				}
				text(c, src, 10, 14, 400, k.muted).SingleLine()
			})
			// 分组键（每行 3 个）
			for r := 0; r*3 < len(secs); r++ {
				ui.Row(c).FillWidth().Gap(5).Children(func() {
					for i := r * 3; i < min(len(secs), r*3+3); i++ {
						s := secs[i]
						isSug := hasSug && sug.section == s.ID
						b := ui.Row(c).Height(30).Grow(1).Basis(0).Gap(5).Padding(0, 6).Radius(rr(8)).AlignItems(ui.Center).Justify(ui.Center).
							Background(k.card).Border(1, k.inputBorder).Key("tri-" + s.ID).Role(ui.RoleButton).Label(tr("归到 ") + sectionName(s))
						col := k.fg
						switch {
						case isSug:
							b.Border(1, p).Background(p.Alpha(0.12))
							col = p
						case b.Hovered():
							b.Border(1, p.Alpha(0.6))
						}
						b.AnimatePose(ui.Pose{Scale: pressScale(b.Pressed(), 0.97)}, tweenControl)
						b.Children(func() {
							text(c, itoa(i+1), 9.5, 13, 500, k.muted).Font(fontMono).Shrink(0)
							text(c, sectionName(s), 11.5, 16, 500, col).SingleLine().Shrink(1)
							if isSug {
								text(c, tr("建议"), 8.5, 12, 600, white).Padding(0, 3).Radius(4).Background(p).Shrink(0)
							}
						})
						if b.Clicked() {
							file(s.ID)
						}
					}
					for range r*3 + 3 - min(len(secs), r*3+3) { // 末行不满 3 个：补空位，按钮宽度与上一行一致
						ui.Box(c).Grow(1).Basis(0)
					}
				})
			}
			// 键位提示 + 跳过 / 结束
			ui.Row(c).Gap(5).AlignItems(ui.Center).Children(func() {
				kbdHint(c, fileKeyHint(len(secs)), k.muted)
				text(c, tr("归类"), 10, 14, 400, k.muted)
				if hasSug {
					kbdHint(c, "⏎", k.muted)
					text(c, tr("按建议"), 10, 14, 400, k.muted)
				}
				ui.Box(c).Grow(1)
				skip := ui.Row(c).Gap(4).AlignItems(ui.Center).Key("tri-skip").Role(ui.RoleButton).Label(tr("跳过"))
				skip.Children(func() {
					kbdHint(c, tr("空格"), k.muted)
					text(c, tr("跳过"), 10.5, 15, 500, hoverLink(skip, k)).SingleLine()
				})
				if skip.Clicked() {
					a.triageSkip[n.ID] = true
				}
				end := ui.Row(c).Gap(4).AlignItems(ui.Center).Margin(0, 0, 0, 6).Key("tri-end").Role(ui.RoleButton).Label(tr("结束整理"))
				end.Children(func() {
					kbdHint(c, "Esc", k.muted)
					text(c, tr("结束"), 10.5, 15, 500, hoverLink(end, k)).SingleLine()
				})
				if end.Clicked() {
					a.triageOn = false
				}
			})
		})
	})
}
