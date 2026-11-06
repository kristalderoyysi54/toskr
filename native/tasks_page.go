package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 任务页按 Tauri 版 TaskPage / TodayPage / TaskRow 逐项复刻（规格取自浏览器实测导出）。
// 结构：子页签（今天 · 任务）34 → 速记框 36 → 6 → 滚动区（左右 14）。

var (
	priorityNames  = []string{"none", "low", "mid", "high"}
	priorityLabels = []string{"无优先级", "低", "中", "高"}
	recurNames     = []string{"", "daily", "weekdays", "weekly", "monthly", "yearly"}
	recurLabels    = []string{"不重复", "每天", "工作日", "每周", "每月", "每年"}
)

// ---- 纯逻辑（与 Tauri lib/tasks.ts 同口径） ----

type taskBuckets struct {
	overdue, sparks, done []store.Task
	groups                []taskGroup
}

type taskGroup struct {
	sec   store.Section
	tasks []store.Task
}

// bucketTasks：逾期未完成一律进「已到期」，闪念进「灵感」，其余按分组（孤儿归收集箱）。
func bucketTasks(tasks []store.Task, secs []store.Section, now time.Time) taskBuckets {
	var b taskBuckets
	by := map[string][]store.Task{}
	for _, t := range tasks {
		switch {
		case t.Status == "done":
			b.done = append(b.done, t)
		case !t.DueAt.IsZero() && !t.DueAt.After(now):
			b.overdue = append(b.overdue, t)
		case t.Spark:
			b.sparks = append(b.sparks, t)
		default:
			key := t.Section
			if !slices.ContainsFunc(secs, func(s store.Section) bool { return s.ID == key }) {
				key = store.TaskInbox
			}
			by[key] = append(by[key], t)
		}
	}
	slices.SortStableFunc(b.overdue, func(x, y store.Task) int { return x.DueAt.Compare(y.DueAt) })
	slices.SortStableFunc(b.sparks, func(x, y store.Task) int { return y.CreatedAt.Compare(x.CreatedAt) })
	slices.SortStableFunc(b.done, func(x, y store.Task) int { return doneAt(y).Compare(doneAt(x)) })
	for _, s := range secs {
		b.groups = append(b.groups, taskGroup{sec: s, tasks: by[s.ID]})
	}
	return b
}

func doneAt(t store.Task) time.Time {
	if t.CompletedAt.IsZero() {
		return t.CreatedAt
	}
	return t.CompletedAt
}

type todayAgenda struct {
	earlier, timeline           []store.Task
	pending, doneToday, overdue int
}

func agendaFor(tasks []store.Task, now time.Time) todayAgenda {
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	end := start.AddDate(0, 0, 1)
	var a todayAgenda
	for _, t := range tasks {
		if !t.CompletedAt.IsZero() && !t.CompletedAt.Before(start) && t.CompletedAt.Before(end) {
			a.doneToday++
		}
		switch {
		case t.DueAt.IsZero():
		case !t.DueAt.Before(start) && t.DueAt.Before(end):
			a.timeline = append(a.timeline, t)
		case t.DueAt.Before(start) && t.Status != "done":
			a.earlier = append(a.earlier, t)
		}
	}
	slices.SortStableFunc(a.earlier, func(x, y store.Task) int { return x.DueAt.Compare(y.DueAt) })
	slices.SortStableFunc(a.timeline, func(x, y store.Task) int {
		if c := x.DueAt.Compare(y.DueAt); c != 0 {
			return c
		}
		return x.CreatedAt.Compare(y.CreatedAt)
	})
	a.overdue = len(a.earlier)
	for _, t := range a.timeline {
		if t.Status != "done" {
			a.pending++
			if !t.DueAt.After(now) {
				a.overdue++
			}
		}
	}
	return a
}

// todayDefaultDue：20:00 前取 20:00，之后取下一个整点（不跨过今天）。
func todayDefaultDue(now time.Time) time.Time {
	eight := time.Date(now.Year(), now.Month(), now.Day(), 20, 0, 0, 0, now.Location())
	if now.Before(eight) {
		return eight
	}
	next := time.Date(now.Year(), now.Month(), now.Day(), now.Hour()+1, 0, 0, 0, now.Location())
	last := time.Date(now.Year(), now.Month(), now.Day(), 23, 59, 0, 0, now.Location())
	if next.After(last) {
		return last
	}
	return next
}

func sameDay(a, b time.Time) bool {
	y1, m1, d1 := a.Date()
	y2, m2, d2 := b.Date()
	return y1 == y2 && m1 == m2 && d1 == d2
}

// dueTone：overdue / today / later。
func dueTone(due, now time.Time) string {
	switch {
	case !due.After(now):
		return "overdue"
	case sameDay(due, now):
		return "today"
	}
	return "later"
}

// dueBadge：逾期「N 分钟/小时/天前」，未来「今天 / 明天 / 周X / M月D日 HH:MM」。
func dueBadge(due, now time.Time) string {
	hm := due.Format("15:04")
	if !due.After(now) {
		mins := int(now.Sub(due).Minutes())
		switch {
		case mins < 60:
			return fmt.Sprintf(tr("%d 分钟前"), max(1, mins))
		case mins < 60*24:
			return fmt.Sprintf(tr("%d 小时前"), mins/60)
		}
		return fmt.Sprintf(tr("%d 天前"), mins/60/24)
	}
	day := func(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location()) }
	diff := int(day(due).Sub(day(now)).Hours()/24 + 0.5)
	switch {
	case diff == 0:
		return tr("今天 ") + hm
	case diff == 1:
		return tr("明天 ") + hm
	case diff < 7:
		return tr([]string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}[due.Weekday()]) + " " + hm
	}
	return fmt.Sprintf(tr("%d月%d日"), due.Month(), due.Day()) + " " + hm
}

func (a *app) addTaskDraft() {
	if a.taskDraft == "" {
		return
	}
	t := store.ParseQuickTask(a.taskDraft, a.now())
	if t.Text == "" {
		return
	}
	if a.taskSub == 0 && t.DueAt.IsZero() {
		t.DueAt = todayDefaultDue(a.now())
	}
	if a.taskSub == 1 && a.sparkMode {
		t.Spark = true
	}
	a.store.AddTask(t)
	a.taskDraft = ""
}

// ---- 视图 ----

func (a *app) tasksPage(c *ui.Context) {
	k := tok(c)
	now := a.now()
	a.taskSubtabs(c, k)
	if a.taskSub == 2 {
		a.billsPage(c, k)
		return
	}
	a.taskQuickAdd(c, k)
	filtering := a.taskSub == 1 && a.taskFilterOn && a.taskFilter.active()
	var filtered []store.Task
	if filtering {
		filtered = filterTasks(a.tasks, a.taskFilter, now)
	}
	if a.taskSub == 1 && a.taskFilterOn {
		a.taskFilterBar(c, k, len(filtered))
	}
	ui.Box(c).Grow(1).Margin(6, 0, 0, 0).Children(func() {
		ui.Scroll(c).Fill().Scrollbars(false).Children(func() {
			ui.Column(c).Padding(4, 14, 8, 14).Gap(12).Children(func() {
				switch {
				case a.taskSub == 0:
					a.todayView(c, k, now)
				default:
					if a.taskCalOn {
						a.taskCalendar(c, k, now)
					}
					if !filtering {
						a.taskListView(c, k, now)
					} else if len(filtered) == 0 {
						text(c, tr("没有符合条件的任务"), 11, 16, 400, k.muted).Padding(8, 0).TextAlign(ui.Center).FillWidth()
					} else {
						ui.Column(c).Gap(4).Children(func() {
							for _, t := range filtered {
								a.taskRow(c, k, t, now)
							}
						})
					}
				}
			})
		})
	})
}

func (a *app) taskSubtabs(c *ui.Context, k tokens) {
	labels := []string{"今天", "任务"}
	if a.store.Settings().SubscriptionsEnabled {
		labels = append(labels, "订阅")
	} else if a.taskSub == 2 {
		a.taskSub = 0 // 订阅功能关闭时残留的订阅子视图落回「今天」
	}
	var right func()
	if a.taskSub == 1 {
		right = func() {
			fl, cl := tr("搜索与筛选任务"), tr("显示任务日历")
			if a.taskFilterOn {
				fl = tr("关闭搜索与筛选")
			}
			if a.taskCalOn {
				cl = tr("隐藏任务日历")
			}
			if a.toggleIconButton(c, k, "list-filter", fl, a.taskFilterOn) {
				a.taskFilterOn = !a.taskFilterOn
				a.taskFilter = taskFilter{} // 关闭即清空条件（会话态，不记忆）
			}
			if a.toggleIconButton(c, k, "calendar-days", cl, a.taskCalOn) {
				a.taskCalOn = !a.taskCalOn
			}
		}
	}
	if i, ok := a.textTabs(c, k, labels, a.taskSub, right); ok {
		a.taskSub = i
	}
}

func (a *app) taskQuickAdd(c *ui.Context, k tokens) {
	box := ui.Row(c).Height(36).Margin(0, 12).Padding(8, 10).Gap(6).Radius(14).Background(k.track).Border(1, k.inputBorder).
		InsetShadow(0, 1, 2, 0, k.insetShadow).AlignItems(ui.Center)
	box.Children(func() {
		ph := tr("添加今天的任务，回车保存（") + todayDefaultDue(a.now()).Format("15:04") + tr(" 到期）…")
		if a.taskSub == 1 {
			ph = tr("记下待办，回车保存…")
			for _, ic := range []string{"lightbulb", "sparkles"} {
				b := ui.Box(c).Size(18, 18).Radius(6).Center()
				col := k.muted
				if ic == "lightbulb" && a.sparkMode {
					col = k.violetIcon
				}
				b.Children(func() { licon(c, ic, 14, col) })
				if ic == "lightbulb" && b.Clicked() {
					a.sparkMode = !a.sparkMode
				}
			}
			if a.sparkMode {
				ph = tr("记下灵感，回车保存…")
			}
		}
		ui.TextInputBase(c, &a.taskDraft).Bind(&a.taskIn).Grow(1).Font(fontSans).FontSize(13).FixedLineHeight(18).
			TextColor(k.fg).PlaceholderColor(k.muted).Placeholder(ph).OnTextKey(func(key ui.TextKey) bool {
			if key.Key == ui.KeyEnter && key.Mods == 0 {
				a.taskDraft = key.Text()
				a.addTaskDraft()
				key.SetText(a.taskDraft)
				return true
			}
			return false
		})
	})
}

func (a *app) todayView(c *ui.Context, k tokens, now time.Time) {
	ag := agendaFor(a.tasks, now)
	events := a.todayEvents(now)
	st := a.store.Settings()
	stats := []struct {
		n     int
		label string
	}{{ag.pending, "待办"}, {ag.doneToday, "已完成"}, {ag.overdue, "已逾期"}}
	if st.SubscriptionsEnabled {
		stats = append(stats, struct {
			n     int
			label string
		}{billsDueToday(a.store.Bills(), now), "扣款"})
	}
	if st.CalendarOn {
		stats = append(stats, struct {
			n     int
			label string
		}{len(events), "日程"})
	}
	ui.Row(c).Gap(6).Children(func() {
		for i, s := range stats {
			ui.Column(c).Grow(1).Basis(0).Height(40).Padding(4, 8).Radius(10).Background(k.track).Children(func() {
				col := k.fg
				if i == 2 && s.n > 0 {
					col = k.danger
				}
				text(c, itoa(s.n), 13, 18, 600, col)
				text(c, tr(s.label), 10, 14, 400, k.muted)
			})
		}
	})
	if len(ag.earlier) == 0 && len(ag.timeline) == 0 && len(events) == 0 {
		a.emptyState(c, k, "calendar-check", tr("今天没有安排"), tr("在上方记下今天要做的事，或在任务的到期弹层里把它排到今天。"))
		return
	}
	if len(ag.earlier) > 0 {
		ui.Column(c).Gap(4).Children(func() {
			ui.Row(c).Height(16).Padding(0, 4, 0, 2).Gap(4).AlignItems(ui.Center).Children(func() {
				text(c, tr("往日未完成"), 11, 16, 600, k.danger).LetterSpacing(0.88)
				countBadge(c, len(ag.earlier), k.danger, k.danger.Alpha(0.1))
				ui.Spacer(c)
				a.postponeAll(c, k, ag.earlier)
			})
			for _, t := range ag.earlier {
				a.taskRow(c, k, t, now)
			}
		})
	}
	// 任务按到期、日程按开始时刻（昨天开始的按今天 0 点）排进同一条轴；同刻日程在前；全天日程在轴顶
	type entry struct {
		at   time.Time
		task *store.Task
		ev   *macos.CalendarEvent
	}
	var allDay []macos.CalendarEvent
	var line []entry
	day := dayStart(now)
	for i := range events {
		if events[i].AllDay {
			allDay = append(allDay, events[i])
		} else {
			line = append(line, entry{at: time.UnixMilli(max(events[i].StartMs, day.UnixMilli())), ev: &events[i]})
		}
	}
	for i := range ag.timeline {
		line = append(line, entry{at: ag.timeline[i].DueAt, task: &ag.timeline[i]})
	}
	slices.SortStableFunc(line, func(x, y entry) int {
		if c := x.at.Compare(y.at); c != 0 {
			return c
		}
		if (x.ev != nil) != (y.ev != nil) {
			if x.ev != nil {
				return -1
			}
			return 1
		}
		return 0
	})
	if len(line) == 0 && len(allDay) == 0 {
		return
	}
	nowIdx := slices.IndexFunc(line, func(e entry) bool { return e.at.After(now) })
	if nowIdx < 0 {
		nowIdx = len(line)
	}
	ui.Column(c).Gap(4).Children(func() {
		for _, e := range allDay {
			ui.Row(c).Gap(6).AlignItems(ui.Start).Key("ad-" + e.ID).Children(func() {
				text(c, tr("全天"), 10, 14, 400, k.muted).Width(44).Padding(8, 0, 0, 0).TextAlign(ui.End)
				a.eventRow(c, k, e)
			})
		}
		for i := 0; i <= len(line); i++ {
			if i == nowIdx {
				ui.Row(c).Height(14).Gap(6).Key("now-line").Children(func() {
					text(c, now.Format("15:04"), 10, 14, 600, k.danger).Width(44).TextAlign(ui.End)
					ui.Box(c).Grow(1).Height(14).Children(func() {
						ui.Box(c).Absolute().Left(0).Right(0).Top(6.5).Height(1).Background(k.danger)
						ui.Box(c).Absolute().Left(-2).Top(3.5).Size(7, 7).Radius(3.5).Background(k.danger)
					})
				})
			}
			if i == len(line) {
				break
			}
			if ev := line[i].ev; ev != nil {
				ui.Row(c).Gap(6).AlignItems(ui.Start).Key("tle-" + ev.ID).Children(func() {
					text(c, line[i].at.Format("15:04"), 10, 14, 400, k.muted).Width(44).Padding(8, 0, 0, 0).TextAlign(ui.End)
					a.eventRow(c, k, *ev)
				})
				continue
			}
			t := *line[i].task
			ui.Row(c).Gap(6).AlignItems(ui.Start).Key("tl-" + t.ID).Children(func() {
				col := k.muted
				if t.Status != "done" && !t.DueAt.After(now) {
					col = k.danger
				}
				text(c, t.DueAt.Format("15:04"), 10, 14, 400, col).Width(44).Padding(8, 0, 0, 0).TextAlign(ui.End)
				ui.Column(c).Grow(1).Children(func() { a.taskRow(c, k, t, now) })
			})
		}
	})
}

func (a *app) emptyState(c *ui.Context, k tokens, icon, title, body string) {
	ui.Column(c).Padding(64, 24, 40, 24).Gap(8).AlignItems(ui.Center).Children(func() {
		licon(c, icon, 24, k.muted.Alpha(0.5))
		text(c, title, 13, 18, 500, k.muted)
		text(c, body, 11, 16.5, 400, k.muted).TextAlign(ui.Center).Wrap()
	})
}

func countBadge(c *ui.Context, n int, fg, bg ui.Color) {
	text(c, itoa(n), 10, 14, 600, fg).Padding(1, 4).Radius(6).Background(bg)
}

// postponeAll 是「全部顺延」：把积压的逾期任务挪到同一时间点（可撤销）。
func (a *app) postponeAll(c *ui.Context, k tokens, tasks []store.Task) {
	b := ui.Row(c).Height(14).Padding(0, 4).Gap(2).Radius(6).AlignItems(ui.Center)
	b.Children(func() {
		text(c, tr("全部顺延"), 10, 14, 400, k.muted)
		licon(c, "chevron-down", 10, k.muted)
	})
	b.Menu(func(m *ui.Menu) {
		now := a.now()
		base := time.Date(now.Year(), now.Month(), now.Day(), 9, 0, 0, 0, now.Location())
		for _, o := range []struct {
			label string
			at    time.Time
		}{{"今天 20:00", todayDefaultDue(now)}, {"明天 9:00", base.AddDate(0, 0, 1)}, {"下周一 9:00", nextMonday(base)}} {
			if m.Item(tr(o.label)).Chosen() {
				before := slices.Clone(tasks)
				for _, t := range tasks {
					t.DueAt = o.at
					_ = a.store.UpdateTask(t)
				}
				a.showHUDUndo("ok", fmt.Sprintf(tr("已顺延 %d 个任务"), len(before)), func() {
					for _, t := range before {
						_ = a.store.UpdateTask(t)
					}
				})
			}
		}
	})
}

func (a *app) taskListView(c *ui.Context, k tokens, now time.Time) {
	if len(a.tasks) == 0 {
		a.emptyState(c, k, "list-todo", tr("还没有任务"), tr("在上方速记框记下待办，点 💡 切换闪念模式记灵感。"))
		return
	}
	b := bucketTasks(a.tasks, a.store.TaskSections(), now)
	if len(b.overdue) > 0 {
		a.smartBand(c, k, "overdue", tr("已到期"), "", k.danger, k.danger.Alpha(0.1), b.overdue, now, true)
	}
	if len(b.sparks) > 0 {
		a.smartBand(c, k, "spark", tr("灵感"), "lightbulb", k.violetText, k.violetIcon.Alpha(0.1), b.sparks, now, false)
	}
	for _, g := range b.groups {
		a.taskSection(c, k, g, now)
	}
	nb := ui.Row(c).Height(24).Margin(0, 0, 0, 8).Padding(4, 6).Gap(4).Radius(8).AlignItems(ui.Center).AlignSelf(ui.Start)
	nb.Children(func() {
		licon(c, "plus", 12, k.muted)
		text(c, tr("新建分组"), 11, 16, 400, k.muted)
	})
	if nb.Clicked() {
		a.store.AddTaskSection(tr("新分组"))
	}
	if len(b.done) > 0 {
		open := a.bandOpen["done"]
		r := ui.Row(c).Height(18).Margin(4, 0, 0, 0).Padding(2, 4).Gap(4).AlignItems(ui.Center).AlignSelf(ui.Start)
		r.Children(func() {
			chev := "chevron-right"
			if open {
				chev = "chevron-down"
			}
			licon(c, chev, 10, k.muted)
			text(c, tr("已完成 ")+itoa(len(b.done)), 10, 14, 400, k.muted)
		})
		if r.Clicked() {
			a.bandOpen["done"] = !open
		}
		if open {
			ui.Column(c).Gap(4).Children(func() {
				for _, t := range b.done {
					a.taskRow(c, k, t, now)
				}
			})
		}
	}
}

// smartBand 是跨分组横切的智能区（已到期红 / 灵感紫），区头可点击折叠。
func (a *app) smartBand(c *ui.Context, k tokens, key, title, icon string, fg, badgeBg ui.Color, tasks []store.Task, now time.Time, postpone bool) {
	open := a.bandOpen[key]
	ui.Column(c).Gap(6).Key("band-" + key).Children(func() {
		ui.Row(c).Height(16).Padding(0, 4, 0, 0).Gap(4).AlignItems(ui.Center).Children(func() {
			h := ui.Row(c).Grow(1).Padding(0, 0, 0, 2).Gap(4).Radius(6).AlignItems(ui.Center)
			h.Children(func() {
				chev := "chevron-down"
				if !open {
					chev = "chevron-right"
				}
				licon(c, chev, 12, fg)
				if icon != "" {
					licon(c, icon, 12, k.violetIcon)
				}
				text(c, title, 11, 16, 600, fg).LetterSpacing(0.88)
				countBadge(c, len(tasks), fg, badgeBg)
			})
			if h.Clicked() {
				a.bandOpen[key] = !open
			}
			if postpone {
				a.postponeAll(c, k, tasks)
			}
		})
		if open {
			ui.Column(c).Gap(4).Children(func() {
				for _, t := range tasks {
					a.taskRow(c, k, t, now)
				}
			})
		}
	})
}

func (a *app) taskSection(c *ui.Context, k tokens, g taskGroup, now time.Time) {
	collapsed := g.sec.Collapsed
	ui.Column(c).Gap(6).Key("tsec-" + g.sec.ID).Children(func() {
		head := ui.Row(c).Height(20).Padding(0, 4, 0, 2).Gap(4).Radius(6).AlignItems(ui.Center)
		hovered := head.Hovered()
		if _, ok := ui.DragOver[taskDrag](head); ok {
			head.Background(stok(c).primary.Alpha(0.12))
		}
		if d, ok := ui.Drop[taskDrag](head); ok {
			_ = a.store.MoveTask(d.id, g.sec.ID, "")
		}
		head.Children(func() {
			chev := "chevron-down"
			if collapsed {
				chev = "chevron-right"
			}
			b := ui.Box(c).Size(16, 16).Radius(6).Center()
			b.Children(func() { licon(c, chev, 12, k.muted) })
			if b.Clicked() {
				g.sec.Collapsed = !collapsed
				_ = a.store.UpdateTaskSection(g.sec)
			}
			name := g.sec.Name
			if g.sec.ID == store.TaskInbox {
				name = tr("收集箱")
			}
			if a.taskSecRename == g.sec.ID {
				ui.TextInputBase(c, &a.taskSecName).Width(140).Font(fontSans).FontSize(11).TextColor(k.fg).Label(tr("分组名称")).Focus().
					OnTextKey(func(key ui.TextKey) bool {
						switch key.Key {
						case ui.KeyEnter:
							if v := strings.TrimSpace(key.Text()); v != "" {
								sec := g.sec
								sec.Name = v
								_ = a.store.UpdateTaskSection(sec)
							}
							a.taskSecRename = ""
							return true
						case ui.KeyEscape:
							a.taskSecRename = ""
							return true
						}
						return false
					})
			} else {
				label := text(c, name, 11, 16, 600, k.muted).LetterSpacing(0.88)
				if g.sec.ID != store.TaskInbox && label.DoubleClicked() {
					a.taskSecRename, a.taskSecName = g.sec.ID, g.sec.Name
				}
			}
			countBadge(c, len(g.tasks), k.muted, k.track)
			ui.Spacer(c)
			more := ui.Box(c).Size(16, 16).Radius(6).Center().Tooltip(tr("分组操作")).Role(ui.RoleButton).Label(sectionTitle(g.sec) + " " + tr("分组操作"))
			if !hovered {
				more.Opacity(0) // 与 Tauri 一致：悬停区头才显出「···」
			}
			more.Children(func() { licon(c, "ellipsis", 12, k.muted) })
			more.Menu(func(m *ui.Menu) {
				label := tr("折叠")
				if collapsed {
					label = tr("展开")
				}
				if m.Item(label).Chosen() {
					g.sec.Collapsed = !collapsed
					_ = a.store.UpdateTaskSection(g.sec)
				}
				if g.sec.ID == store.TaskInbox {
					return
				}
				secs := a.store.TaskSections()
				i := slices.IndexFunc(secs, func(x store.Section) bool { return x.ID == g.sec.ID })
				m.Separator()
				if m.Item(tr("重命名")).Chosen() {
					a.taskSecRename, a.taskSecName = g.sec.ID, g.sec.Name
				}
				if m.Item(tr("上移")).Disabled(i <= 0).Chosen() {
					_ = a.store.MoveTaskSection(g.sec.ID, -1)
				}
				if m.Item(tr("下移")).Disabled(i < 0 || i >= len(secs)-1).Chosen() {
					_ = a.store.MoveTaskSection(g.sec.ID, 1)
				}
				m.Separator()
				if m.Item(tr("删除分组")).Chosen() {
					if undo, ok := a.store.DeleteTaskSection(g.sec.ID); ok {
						a.showHUDUndo("ok", fmt.Sprintf(tr("已删除分组「%s」，任务移回收集箱"), g.sec.Name), undo)
					}
				}
			})
		})
		if collapsed {
			return
		}
		ui.Column(c).Gap(4).Children(func() {
			if len(g.tasks) == 0 {
				text(c, tr("此分组为空"), 11, 16, 400, k.muted).Padding(8, 0).TextAlign(ui.Center).FillWidth()
			}
			for _, t := range g.tasks {
				a.taskRow(c, k, t, now)
			}
		})
	})
}

// taskRow：卡片 38 高（边框 1 + 内边距 6/8），行内依次是优先级色条、状态圈、标题、重复 / 清单 / 到期、删除。
func (a *app) taskRow(c *ui.Context, k tokens, t store.Task, now time.Time) {
	done := t.Status == "done"
	open := a.taskOpen == t.ID
	card := ui.Column(c).Padding(6, 8).Radius(10).Border(1, ui.Transparent).Key("task-" + t.ID)
	if !open {
		card.Height(38)
	}
	if t.Spark && !done {
		card.Background(k.sparkRow)
	} else {
		card.Background(k.card)
	}
	hovered := card.Hovered()
	elevated(card, k, hovered) // TaskRow：悬停 elevation-2，box-shadow 150ms
	card.ContextMenu(func(m *ui.Menu) { a.taskMenu(c, m, t) })
	if !open { // 拖拽排序：放到另一行 = 插到它前面（可跨分组）；放到分组头 = 移到该组末尾
		card.Drag(taskDrag{t.ID})
	}
	dropOver := false
	if d, ok := ui.DragOver[taskDrag](card); ok && d.id != t.ID {
		dropOver = true
	}
	if d, ok := ui.Drop[taskDrag](card); ok && d.id != t.ID {
		_ = a.store.MoveTask(d.id, "", t.ID)
	}
	card.Children(func() {
		if dropOver {
			ui.Box(c).Absolute().Top(-4).Left(6).Right(6).Height(2).Radius(1).Background(stok(c).primary).PassThrough()
		}
		ui.Row(c).Grow(1).Height(24).Gap(8).AlignItems(ui.Center).Children(func() {
			bar := ui.Box(c).Size(8, 24).Center()
			bar.Children(func() {
				col := ui.Transparent
				switch t.Priority {
				case "high":
					col = k.danger
				case "mid":
					col = k.amberBar
				case "low":
					col = k.tealBar
				default:
					if hovered {
						col = k.fg.Alpha(0.1)
					}
				}
				ui.Box(c).Size(3, 20).Radius(1.5).Background(bar.AnimateColor("pri", col, tweenTw)) // 优先级条 colors 150ms
			})
			bar.Menu(func(m *ui.Menu) {
				for i, p := range priorityNames {
					if m.Item(tr(priorityLabels[i])).Radio(t.Priority == p).Chosen() {
						t.Priority = p
						_ = a.store.UpdateTask(t)
					}
				}
			})
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
			if t.Spark && !done {
				stLabel = tr("灵感转为待办")
			}
			st := ui.Box(c).Size(16, 16).Role(ui.RoleButton).Label(stLabel).Tooltip(stLabel).Children(func() { licon(c, icon, 16, col) })
			if st.Clicked() {
				if t.Spark && !done {
					t.Spark = false // 闪念点 💡 转为正式待办
					_ = a.store.UpdateTask(t)
				} else {
					a.cycleTaskStatus(t) // 待办 → 进行中 → 完成 → 待办（同 Tauri cycleTaskStatus）
				}
			}
			if a.taskOpen == t.ID {
				ui.TextInputBase(c, &a.taskTitle).Grow(1).Basis(0).Font(fontSans).FontSize(13).TextColor(k.fg).Label(tr("任务标题")).
					OnTextKey(func(key ui.TextKey) bool {
						if key.Key == ui.KeyEnter || key.Key == ui.KeyEscape {
							a.commitTaskEdit()
							a.taskOpen = ""
							return true
						}
						return false
					})
			} else {
				title := text(c, t.Text, 13, 18, 400, k.fg).SingleLine().Grow(1).Basis(0).Role(ui.RoleButton).Label(t.Text)
				if done {
					title.TextColor(k.muted).Strikethrough()
				}
				if title.Clicked() {
					a.openTaskEdit(t)
				}
			}
			if t.Recurrence != "" {
				licon(c, "repeat", 12, k.repeatIcon)
			}
			if n := len(t.Checklist); n > 0 {
				d := 0
				for _, it := range t.Checklist {
					if it.Done {
						d++
					}
				}
				ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
					ui.Box(c).Size(20, 3).Radius(1.5).Background(k.track).Children(func() {
						ui.Box(c).Absolute().Left(0).Top(0).Size(20*float32(d)/float32(n), 3).Radius(1.5).Background(k.muted.Alpha(0.6))
					})
					text(c, fmt.Sprintf("%d/%d", d, n), 10, 14, 400, k.muted)
				})
			}
			if !t.DueAt.IsZero() && !done {
				fg, bg := k.muted, k.laterChip
				switch dueTone(t.DueAt, now) {
				case "overdue":
					fg, bg = k.danger, k.danger.Alpha(0.15)
				case "today":
					fg, bg = k.amberText, k.amberBar.Alpha(0.15)
				}
				chip := text(c, dueBadge(t.DueAt, now), 10, 14, 400, fg).Height(18).Padding(2, 6).Radius(8).Background(bg)
				chip.Menu(func(m *ui.Menu) { a.dueMenu(m, t) })
			}
			trash := ui.Box(c).Size(16, 16).Radius(6).Center().Tooltip(tr("删除"))
			if !hovered {
				trash.Opacity(0)
			}
			trash.Children(func() { licon(c, "trash-2", 12, k.muted) })
			if trash.Clicked() {
				if removed, pos, ok := a.store.DeleteTask(t.ID); ok {
					a.showHUDUndo("ok", tr("已删除任务"), func() { _ = a.store.RestoreTask(removed, pos) })
				}
			}
		})
		if open {
			a.taskEditor(c, k, t)
		}
	})
}

func (a *app) dueMenu(m *ui.Menu, t store.Task) {
	now := a.now()
	base := time.Date(now.Year(), now.Month(), now.Day(), 9, 0, 0, 0, now.Location())
	for _, o := range []struct {
		label string
		at    time.Time
	}{{"一小时后", now.Add(time.Hour).Truncate(time.Minute)}, {"今晚 20:00", base.Add(11 * time.Hour)}, {"明天 9:00", base.AddDate(0, 0, 1)}, {"下周一 9:00", nextMonday(base)}, {"清除", time.Time{}}} {
		if m.Item(tr(o.label)).Chosen() {
			t.DueAt = o.at
			_ = a.store.UpdateTask(t)
		}
	}
}

func (a *app) taskMenu(c *ui.Context, m *ui.Menu, t store.Task) {
	if m.Item(tr("发送到对话")).Chosen() {
		a.send([]store.Note{taskAsNote(t)})
	}
	m.Separator()
	if t.Status != "done" && m.Item(tr("标记完成")).Chosen() {
		a.setTaskStatus(t, "done")
	}
	if t.Status != "doing" && m.Item(tr("标记进行中")).Chosen() {
		a.setTaskStatus(t, "doing")
	}
	if t.Status != "todo" && m.Item(tr("转为待办")).Chosen() {
		a.setTaskStatus(t, "todo")
	}
	if m.Item(tr("编辑任务…")).Chosen() {
		a.openTaskEdit(t)
	}
	m.Separator()
	m.Submenu(tr("优先级"), func(sm *ui.Menu) {
		for i, p := range priorityNames {
			if sm.Item(tr(priorityLabels[i])).Radio(t.Priority == p).Chosen() {
				t.Priority = p
				_ = a.store.UpdateTask(t)
			}
		}
	})
	m.Submenu(tr("重复"), func(sm *ui.Menu) {
		for i, r := range recurNames {
			if sm.Item(tr(recurLabels[i])).Radio(t.Recurrence == r).Chosen() {
				t.Recurrence = r
				_ = a.store.UpdateTask(t)
			}
		}
	})
	m.Submenu(tr("到期"), func(sm *ui.Menu) { a.dueMenu(sm, t) })
	m.Submenu(tr("移动到"), func(sm *ui.Menu) {
		for _, s := range a.store.TaskSections() {
			name := s.Name
			if s.ID == store.TaskInbox {
				name = tr("收集箱")
			}
			if sm.Item(name).Radio(t.Section == s.ID).Chosen() {
				t.Section = s.ID
				_ = a.store.UpdateTask(t)
			}
		}
	})
	if m.Item(tr("灵感")).Checked(t.Spark).Chosen() {
		t.Spark = !t.Spark
		_ = a.store.UpdateTask(t)
	}
	if m.Item(tr("转为笔记发送")).Chosen() {
		_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Text: t.Text})
		a.switchPage(pageNotes)
	}
	m.Separator()
	if m.Item(tr("删除")).Chosen() {
		if removed, pos, ok := a.store.DeleteTask(t.ID); ok {
			a.showHUDUndo("ok", tr("已删除任务"), func() { _ = a.store.RestoreTask(removed, pos) })
		}
	}
}

func nextMonday(base time.Time) time.Time {
	d := (8 - int(base.Weekday())) % 7
	if d == 0 {
		d = 7
	}
	return base.AddDate(0, 0, d)
}

// overdueCount 用于「任务」页签的红色计数徽标。
func (a *app) overdueCount() int {
	now, n := a.now(), 0
	for _, t := range a.tasks {
		if t.Status != "done" && !t.DueAt.IsZero() && !t.DueAt.After(now) {
			n++
		}
	}
	return n
}

func sectionTitle(sec store.Section) string {
	if sec.ID == store.TaskInbox {
		return tr("收集箱")
	}
	return sec.Name
}
