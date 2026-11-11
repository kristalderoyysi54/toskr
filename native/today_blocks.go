package main

import (
	"fmt"
	"math"
	"os/exec"
	"slices"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 今天页时间块与专注（原生版新增；Tauri 的今天页是只读的到期时刻列表）：
// 时间轴按小时画格——日程是只读色块，任务是时间块（起点 = 到期时刻，长度 = 时长，未设时长按 30 分钟画）；
// 「未排期」里的任务拖进来即排到落点时刻（15 分钟一档），拖时间块的下沿改时长；之后的空档标出分钟数。
// 点时间块上的开始：面板顶部与菜单栏出现专注胶囊（任务名、剩余分钟、完成、延后）。

const (
	hourH        = 44
	blockGutter  = 44
	blockDefault = 30 // 未设时长的任务按 30 分钟画
	focusDefault = 25 // 未设时长的任务专注 25 分钟
)

type dayBlock struct {
	start, end  int // 当天的分钟数
	task        *store.Task
	ev          *macos.CalendarEvent
	lane, lanes int
}

func minuteOf(t, day time.Time) int { return int(t.Sub(day).Minutes()) }

// layoutBlocks：按起点排序并分栏——时间上相交的一簇并排显示（同一簇内各占 1 / 栏数）。
func layoutBlocks(bs []dayBlock) []dayBlock {
	slices.SortStableFunc(bs, func(x, y dayBlock) int {
		if x.start != y.start {
			return x.start - y.start
		}
		if (x.ev != nil) != (y.ev != nil) { // 同刻日程在前
			if x.ev != nil {
				return -1
			}
			return 1
		}
		return 0
	})
	for i := 0; i < len(bs); {
		var laneEnd []int
		j, clusterEnd := i, bs[i].end
		for ; j < len(bs) && (j == i || bs[j].start < clusterEnd); j++ {
			placed := false
			for l, e := range laneEnd {
				if bs[j].start >= e {
					bs[j].lane, laneEnd[l], placed = l, bs[j].end, true
					break
				}
			}
			if !placed {
				bs[j].lane = len(laneEnd)
				laneEnd = append(laneEnd, bs[j].end)
			}
			clusterEnd = max(clusterEnd, bs[j].end)
		}
		for k := i; k < j; k++ {
			bs[k].lanes = len(laneEnd)
		}
		i = j
	}
	return bs
}

// freeGaps：from 之后、各块之间不短于 minLen 分钟的空档。
func freeGaps(bs []dayBlock, from, minLen int) [][2]int {
	var busy [][2]int
	for _, b := range bs {
		if b.task != nil && b.task.Status == "done" {
			continue
		}
		busy = append(busy, [2]int{b.start, b.end})
	}
	slices.SortFunc(busy, func(x, y [2]int) int { return x[0] - y[0] })
	var out [][2]int
	cur := from
	for _, b := range busy {
		if b[1] <= cur {
			continue
		}
		if b[0]-cur >= minLen && b[0] > from {
			out = append(out, [2]int{cur, b[0]})
		}
		cur = max(cur, b[1])
	}
	return out
}

func hm(min int) string { return fmt.Sprintf("%02d:%02d", min/60%24, min%60) }

// todayBlocks：今天的日程与任务排成时间块。
func (a *app) todayBlocks(tl []store.Task, events []macos.CalendarEvent, now time.Time) []dayBlock {
	day := dayStart(now)
	var bs []dayBlock
	for i := range events {
		if events[i].AllDay {
			continue
		}
		s := max(0, minuteOf(time.UnixMilli(events[i].StartMs), day))
		e := min(24*60, minuteOf(time.UnixMilli(events[i].EndMs), day))
		bs = append(bs, dayBlock{start: s, end: max(e, s+15), ev: &events[i]})
	}
	for i := range tl {
		s := minuteOf(tl[i].DueAt, day)
		d := tl[i].DurationMin
		if d <= 0 {
			d = blockDefault
		}
		bs = append(bs, dayBlock{start: s, end: min(24*60, s+d), task: &tl[i]})
	}
	return layoutBlocks(bs)
}

// todayStatsLine：三块统计压成一行文字（逾期用危险色，只落在那几个字上）。
func (a *app) todayStatsLine(c *ui.Context, k tokens, ag todayAgenda, bills, events int, st store.Settings) {
	ui.Row(c).Gap(4).Padding(0, 2).AlignItems(ui.Center).Key("today-stats").Children(func() {
		text(c, fmt.Sprintf(tr("今天 %d / %d 完成"), ag.doneToday, ag.doneToday+ag.pending), 11, 16, 500, k.fg).SingleLine()
		if ag.overdue > 0 {
			text(c, fmt.Sprintf(tr("%d 项逾期"), ag.overdue), 11, 16, 500, k.danger).SingleLine()
		}
		extra := ""
		if st.SubscriptionsEnabled && bills > 0 {
			extra += fmt.Sprintf(tr("%d 笔扣款"), bills)
		}
		if st.CalendarOn && events > 0 {
			if extra != "" {
				extra += " · "
			}
			extra += fmt.Sprintf(tr("%d 个日程"), events)
		}
		if extra != "" {
			text(c, extra, 11, 16, 400, k.muted).SingleLine().Grow(1).Basis(0).TextAlign(ui.End)
		}
	})
}

// dayGrid：小时网格 + 时间块 + 现在线 + 空档；处理拖入排期与拖下沿改时长。
func (a *app) dayGrid(c *ui.Context, k tokens, bs []dayBlock, now time.Time) {
	s := stok(c)
	day := dayStart(now)
	nowMin := minuteOf(now, day)
	first, last := nowMin/60, min(24, nowMin/60+3)
	for _, b := range bs {
		first, last = min(first, b.start/60), max(last, (b.end+59)/60)
	}
	first, last = max(0, first), min(24, max(last, first+4))
	hh := float32(min(hourH, max(26, 360/float64(last-first)))) // 跨度大（如只有一条 20:00 的任务）时压缩每小时的高度，整条轴不超过约 360pt
	y := func(m int) float32 { return float32(m-first*60) / 60 * hh }
	grid := ui.Box(c).FillWidth().Height(float32(last-first)*hh+8).Margin(6, 0, 0, 0).Key("day-grid").Label(tr("今天的时间轴"))
	// 指针落点 → 分钟（15 分钟一档）
	_, py, _ := c.Root().PointerPosition()
	at := first*60 + int(math.Round(float64(py-grid.Bounds().Y)/float64(hh)*4))*15
	at = min(max(at, first*60), last*60-15)
	preview, previewTo := -1, -1
	if d, ok := ui.DragOver[taskDrag](grid); ok && d.id != "" {
		preview = at
		if t, ok := a.taskByID(d.id); ok && d.resize {
			preview, previewTo = minuteOf(t.DueAt, day), max(at+15, minuteOf(t.DueAt, day)+15)
		}
	}
	if d, ok := ui.Drop[taskDrag](grid); ok {
		if t, ok := a.taskByID(d.id); ok && d.resize {
			a.setTaskDuration(t, max(15, at+15-minuteOf(t.DueAt, day)))
		} else if ok {
			a.scheduleTask(d.id, day.Add(time.Duration(at)*time.Minute))
		}
	}
	grid.Children(func() {
		for h := first; h <= last; h++ {
			ui.Box(c).Absolute().Left(blockGutter).Right(0).Top(y(h * 60)).Height(1).Background(k.fg.Alpha(0.07)).Key("hl-" + itoa(h))
			text(c, fmt.Sprintf("%02d:00", h%24), 10, 14, 400, k.muted).Absolute().Left(0).Top(y(h*60) - 7).Width(blockGutter - 8).TextAlign(ui.End).Key("ht-" + itoa(h))
		}
		for _, g := range freeGaps(bs, nowMin, 30) { // 之后的空档
			if g[1] > last*60 {
				continue
			}
			gy, gh := y(g[0])+2, y(g[1])-y(g[0])-4
			if gh < 20 {
				continue
			}
			ui.Box(c).Absolute().Left(blockGutter).Right(0).Top(gy).Height(gh).Radius(8).Border(1, k.fg.Alpha(0.14)).BorderStyle(ui.BorderDashed).Center().
				PassThrough().Key("gap-" + itoa(g[0])).Children(func() { text(c, fmt.Sprintf(tr("空档 %d 分钟"), g[1]-g[0]), 10, 14, 400, k.muted) })
		}
		avail := grid.Bounds().W - blockGutter
		for i := range bs {
			b := bs[i]
			w := avail / float32(max(b.lanes, 1))
			x := blockGutter + w*float32(b.lane)
			top, h := y(b.start)+1, max(y(b.end)-y(b.start)-2, 22)
			if b.ev != nil {
				a.eventBlock(c, k, *b.ev, x, top, w-2, h)
				continue
			}
			a.taskBlock(c, k, s, *b.task, b, x, top, w-2, h, now)
		}
		if preview >= 0 { // 拖放预览：落点时刻线（改时长时是整块轮廓）
			if previewTo > preview {
				ui.Box(c).Absolute().Left(blockGutter).Right(0).Top(y(preview)).Height(y(previewTo)-y(preview)).Radius(8).Border(1.5, s.primary.Alpha(0.7)).
					Background(s.primary.Alpha(0.08)).PassThrough().Key("drop-preview")
				text(c, hm(preview)+"–"+hm(previewTo), 10, 14, 600, s.primary).Absolute().Right(6).Top(y(previewTo) - 16).PassThrough().Key("drop-label")
			} else {
				ui.Box(c).Absolute().Left(blockGutter).Right(0).Top(y(preview) - 1).Height(2).Radius(1).Background(s.primary).PassThrough().Key("drop-preview")
				text(c, hm(preview), 10, 14, 600, s.primary).Absolute().Left(0).Top(y(preview) - 7).Width(blockGutter - 8).TextAlign(ui.End).Background(k.window).PassThrough().Key("drop-label")
			}
		}
		if nowMin >= first*60 && nowMin <= last*60 { // 现在线
			ui.Box(c).Absolute().Left(blockGutter - 4).Right(0).Top(y(nowMin) - 0.5).Height(1).Background(k.danger).PassThrough().Key("now-line")
			ui.Box(c).Absolute().Left(blockGutter-7).Top(y(nowMin)-3.5).Size(7, 7).Radius(3.5).Background(k.danger).PassThrough().Key("now-dot")
		}
	})
}

func (a *app) eventBlock(c *ui.Context, k tokens, e macos.CalendarEvent, x, top, w, h float32) {
	col := s2color(e.CalendarColor, k) // token-exception: 用户日历的系统颜色（运行时数据）
	title := e.Title
	if title == "" {
		title = tr("（无标题）")
	}
	b := ui.Row(c).Absolute().Left(x).Top(top).Width(w).Height(h).Padding(3, 6, 3, 8).Gap(5).Radius(6).Background(col.Alpha(0.14)).Clip().
		Key("evb-" + e.ID).Role(ui.RoleButton).Label(title).Tooltip(title + "\n" + eventTimeLabel(e) + "\n" + tr("点击在「日历」中打开"))
	b.Children(func() {
		ui.Box(c).Absolute().Left(0).Top(0).Bottom(0).Width(2.5).Background(col)
		ui.Column(c).Grow(1).Basis(0).Children(func() {
			text(c, title, 11, 16, 500, k.fg).SingleLine()
			if h >= 38 {
				text(c, eventTimeLabel(e), 10, 14, 400, k.muted).SingleLine()
			}
		})
	})
	if b.Clicked() {
		_ = exec.Command("/usr/bin/open", macos.CalendarEventURL(e.ItemID, e.StartMs, e.Recurring)).Start()
	}
}

// s2color：日历颜色（#rrggbb），取不到用中性灰。
func s2color(hex string, k tokens) ui.Color {
	if len(hex) == 7 && hex[0] == '#' {
		return hexColor(hex)
	}
	return k.muted
}

func (a *app) taskBlock(c *ui.Context, k tokens, s settingsTokens, t store.Task, b dayBlock, x, top, w, h float32, now time.Time) {
	done := t.Status == "done"
	focusing := a.focus != nil && a.focus.taskID == t.ID
	blk := ui.Row(c).Absolute().Left(x).Top(top).Width(w).Height(h).Padding(3, 6, 3, 6).Gap(6).Radius(8).Background(k.card).Border(1, k.fg.Alpha(0.08)).AlignItems(ui.Start).Clip().
		Key("tb-" + t.ID).Role(ui.RoleButton).Label(t.Text)
	hov := blk.Hovered()
	elevated(blk, k, hov)
	if focusing {
		blk.Border(1.5, s.primary.Alpha(0.6))
	} else if !done && !t.DueAt.After(now) && b.end <= minuteOf(now, dayStart(now)) { // 已过点还没做完：危险色细边
		blk.Border(1, k.danger.Alpha(0.5))
	}
	blk.ContextMenu(func(m *ui.Menu) { a.taskMenu(c, m, t) })
	if !done {
		blk.Drag(taskDrag{id: t.ID})
	}
	blk.Children(func() {
		dot := ui.Box(c).Size(16, 16).Center().Key("tbd-" + t.ID).Role(ui.RoleButton).Label(tr("完成") + " " + t.Text)
		dot.Children(func() {
			if done {
				liconFilled(c, "circle-check", 14, k.muted)
			} else {
				ui.Box(c).Size(13, 13).Radius(6.5).Border(1.5, k.muted.Alpha(0.7))
			}
		})
		if dot.Clicked() {
			a.setTaskStatus(t, map[bool]string{true: "todo", false: "done"}[done])
			if focusing {
				a.endFocus()
			}
		}
		ui.Column(c).Grow(1).Basis(0).Children(func() {
			title := text(c, firstLine(t.Text), 11, 16, 500, k.fg).SingleLine()
			if done {
				title.TextColor(k.muted).Strikethrough()
			}
			if h >= 38 {
				text(c, hm(b.start)+"–"+hm(b.end), 10, 14, 400, k.muted).SingleLine()
			}
		})
		switch {
		case focusing:
			text(c, tr("专注中"), 10, 14, 500, s.primary).Padding(1, 5).Radius(5).Background(s.primary.Alpha(0.1)).Shrink(0)
		case !done && hov && w > 120:
			if ghostIconButton(c, k, "tbf-"+t.ID, "play", tr("开始专注"), 18, 11, false, true).Clicked() {
				a.startFocus(t)
			}
		}
		if !done { // 下沿把手：拖动改时长
			grip := ui.Box(c).Absolute().Left(0).Right(0).Bottom(0).Height(6).Key("tbr-" + t.ID).Label(tr("拖动改时长")).Tooltip(tr("拖动改时长"))
			grip.Drag(taskDrag{id: t.ID, resize: true})
			if hov {
				ui.Box(c).Absolute().Left(w/2 - 9).Bottom(2).Width(18).Height(2).Radius(1).Background(k.muted.Alpha(0.5)).PassThrough()
			}
		}
	})
	if blk.Clicked() {
		a.openTaskEdit(t)
	}
}

// scheduleTask：把任务排到 at（保留时长）。可撤销。
func (a *app) scheduleTask(id string, at time.Time) {
	t, ok := a.taskByID(id)
	if !ok || t.DueAt.Equal(at) {
		return
	}
	prev := t
	t.DueAt, t.RemindedAt, t.EarlyReminded = at, time.Time{}, nil
	_ = a.store.UpdateTask(t)
	a.showHUDUndo("ok", fmt.Sprintf(tr("已排到 %s"), at.Format("15:04")), func() { _ = a.store.UpdateTask(prev) })
}

// setTaskDuration：改时长（分钟，0 = 清除）。可撤销。
func (a *app) setTaskDuration(t store.Task, minutes int) {
	if t.DurationMin == minutes {
		return
	}
	prev := t
	t.DurationMin = minutes
	_ = a.store.UpdateTask(t)
	msg := tr("已清除时长")
	if minutes > 0 {
		msg = fmt.Sprintf(tr("时长 %s"), durLabel(minutes))
	}
	a.showHUDUndo("ok", msg, func() { _ = a.store.UpdateTask(prev) })
}

func durLabel(m int) string {
	switch {
	case m%60 == 0:
		return fmt.Sprintf(tr("%d 小时"), m/60)
	case m > 60:
		return fmt.Sprintf(tr("%d 小时 %d 分钟"), m/60, m%60)
	}
	return fmt.Sprintf(tr("%d 分钟"), m)
}

var taskDurations = []int{15, 30, 45, 60, 90, 120}

// taskDurationMenu：任务右键里的「时长」子菜单与「开始专注」（拖动之外的键鼠入口）。
func (a *app) taskDurationMenu(m *ui.Menu, t store.Task) {
	m.Submenu(tr("时长"), func(sm *ui.Menu) {
		for _, d := range taskDurations {
			if sm.Item(durLabel(d)).Checked(t.DurationMin == d).Chosen() {
				a.setTaskDuration(t, d)
			}
		}
		if t.DurationMin > 0 {
			sm.Separator()
			if sm.Item(tr("清除时长")).Chosen() {
				a.setTaskDuration(t, 0)
			}
		}
	})
	if t.Status != "done" {
		if a.focus != nil && a.focus.taskID == t.ID {
			if m.Item(tr("结束专注")).Chosen() {
				a.endFocus()
			}
		} else if m.Item(tr("开始专注")).Chosen() {
			a.startFocus(t)
		}
	}
}

// unscheduledTasks：没有到期时间的待办（不含灵感、已完成）。
func (a *app) unscheduledTasks() []store.Task {
	var out []store.Task
	for _, t := range a.tasks {
		if t.DueAt.IsZero() && t.Status != "done" && !t.Spark {
			out = append(out, t)
		}
	}
	return out
}

const unscheduledMax = 6

func (a *app) unscheduledSection(c *ui.Context, k tokens, now time.Time) {
	un := a.unscheduledTasks()
	if len(un) == 0 {
		return
	}
	ui.Column(c).Gap(4).Margin(6, 0, 0, 0).Key("today-unscheduled").Children(func() {
		ui.Row(c).Height(16).Padding(0, 4, 0, 2).Gap(4).AlignItems(ui.Center).Children(func() {
			text(c, tr("未排期"), 11, 16, 600, k.muted).LetterSpacing(0.88)
			countBadge(c, len(un), k.muted, k.track)
			text(c, tr("拖到时间轴上排时间"), 10, 14, 400, k.muted.Alpha(0.8)).SingleLine().Grow(1).Basis(0).TextAlign(ui.End)
		})
		for i, t := range un {
			if i == unscheduledMax {
				text(c, fmt.Sprintf(tr("还有 %d 项，在「任务」里查看"), len(un)-unscheduledMax), 10, 14, 400, k.muted).Padding(2, 4)
				break
			}
			a.taskRow(c, k, t, now)
		}
	})
}

// ---- 专注 ----

type focusState struct {
	taskID  string
	title   string
	started time.Time
	endsAt  time.Time
}

func (a *app) startFocus(t store.Task) {
	d := t.DurationMin
	if d <= 0 {
		d = focusDefault
	}
	now := a.now()
	a.focus = &focusState{taskID: t.ID, title: firstLine(t.Text), started: now, endsAt: now.Add(time.Duration(d) * time.Minute)}
	if t.Status == "todo" || t.Status == "" {
		a.setTaskStatus(t, "doing")
	}
	a.refreshTrayIcon()
}

func (a *app) endFocus() {
	a.focus = nil
	a.refreshTrayIcon()
}

// focusLeft：剩余分钟（向上取整）。
func (a *app) focusLeft() int {
	if a.focus == nil {
		return 0
	}
	return max(0, int(math.Ceil(a.focus.endsAt.Sub(a.now()).Minutes())))
}

// focusTick：后台每 30 秒看一次——任务没了就结束；到点提醒一次并结束。
func (a *app) focusTick() {
	f := a.focus
	if f == nil {
		return
	}
	t, ok := a.taskByID(f.taskID)
	switch {
	case !ok || t.Status == "done":
		a.endFocus()
	case !a.now().Before(f.endsAt):
		a.endFocus()
		a.playCaptureSound()
		a.showHUDForce("info", fmt.Sprintf(tr("专注时间到 · %s"), f.title))
	default:
		a.refreshTrayIcon()
	}
}

// focusCapsule：面板顶部的专注胶囊——剩余分钟、任务名、完成（主）· 延后 · 结束（文字链接）。
func (a *app) focusCapsule(c *ui.Context, k tokens) {
	f := a.focus
	if f == nil {
		return
	}
	t, ok := a.taskByID(f.taskID)
	if !ok {
		a.endFocus()
		return
	}
	left := a.focusLeft()
	total := max(1, f.endsAt.Sub(f.started).Minutes())
	pct := float32(min(1, max(0, 1-float64(left)/total)))
	box := ui.Row(c).Margin(0, 12, 6, 12).Padding(7, 8, 7, 8).Gap(9).Radius(12).Background(k.card).AlignItems(ui.Center).Key("focus-capsule").Label(tr("专注"))
	elevated(box, k, false)
	box.Children(func() {
		ui.Box(c).Size(30, 30).Radius(15).Border(1.5, k.fg.Alpha(0.14)).Center().Shrink(0).Children(func() {
			text(c, itoa(left), 12, 16, 600, k.fg)
		})
		ui.Column(c).Grow(1).Basis(0).Gap(3).Children(func() {
			text(c, f.title, 12, 17, 600, k.fg).SingleLine()
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				text(c, fmt.Sprintf(tr("专注中，剩 %d 分钟"), left), 10, 14, 400, k.muted).SingleLine().Shrink(0)
				ui.Box(c).Grow(1).Height(2).Radius(1).Background(k.fg.Alpha(0.08)).Children(func() {
					ui.Box(c).Absolute().Left(0).Top(0).Bottom(0).WidthPercent(pct * 100).Radius(1).Background(k.fg.Alpha(0.55))
				})
			})
		})
		if reviewBtn(c, k, "focus-done", tr("完成")) {
			a.setTaskStatus(t, "done")
			a.endFocus()
			a.showHUD("ok", fmt.Sprintf(tr("已完成 · %s"), f.title))
		}
		if reviewLink(c, k, "focus-later", tr("延后")) {
			f.endsAt = f.endsAt.Add(10 * time.Minute)
			a.refreshTrayIcon()
		}
		if reviewLink(c, k, "focus-end", tr("结束")) {
			a.endFocus()
		}
	})
}
