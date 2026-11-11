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
	text := strings.TrimSpace(a.taskDraft)
	if text == "" {
		return
	}
	t := store.Task{Text: text}
	if a.taskSub == 1 && a.sparkMode { // 闪念：原文入库，不解析
		t.Spark = true
	} else { // 本地解析时间 / 重复 / 优先级 / 分组（有意偏离 Tauri 的原文入库；被点掉的片保留原词）
		t = a.quickTask(a.taskDraft)
	}
	if a.taskSub == 0 && t.DueAt.IsZero() { // 今天速记：没认出时间就用今天默认时间（同 TodayQuickAdd）
		t.DueAt = todayDefaultDue(a.now())
	}
	a.store.AddTask(t)
	a.taskDraft, a.taskQuickOff = "", nil
	if a.taskSub == 0 {
		now := a.now()
		if y, m, d := t.DueAt.Date(); y == now.Year() && m == now.Month() && d == now.Day() {
			a.showHUD("added", fmt.Sprintf(tr("已加到今天 %s"), t.DueAt.Format("15:04")))
		} else { // 速记里写了别的日子：任务不在「今天」里，提示它去了哪天
			a.showHUD("added", fmt.Sprintf(tr("已加到 %s"), dueBadge(t.DueAt, now)))
		}
	}
}

// ---- 视图 ----

func (a *app) tasksPage(c *ui.Context) {
	k := tok(c)
	now := a.now()
	a.taskSubtabs(c, k)
	page := ui.Column(c).Grow(1)
	a.swapView(page, "tsub", a.taskSub).Children(func() { a.taskSubBody(c, k, now) })
}

func (a *app) taskSubBody(c *ui.Context, k tokens, now time.Time) {
	if a.taskSub == 2 {
		a.billsPage(c, k)
		return
	}
	a.taskQuickAdd(c, k)
	a.taskQuickChips(c, k)
	if a.taskSub == 1 {
		a.taskDraftPreview(c, k)
	}
	filtering := a.taskSub == 1 && a.taskFilterOn && a.taskFilter.active()
	var filtered []store.Task
	if filtering {
		filtered = filterTasks(a.tasks, a.taskFilter, now)
	}
	if a.taskSub == 1 && a.taskFilterOn {
		a.taskFilterBar(c, k, len(filtered))
	}
	ui.Box(c).Grow(1).Margin(6, 0, 0, 0).Children(func() {
		tsc := ui.Scroll(c).Fill().Scrollbars(false).TrackScroll(&a.taskScroll)
		if a.tsecSort.active != "" { // 拖动任务分组靠近上下缘：自动滚动
			sortAutoScroll(c, tsc, &a.taskScroll)
		}
		tsc.Children(func() {
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
			// 💡 闪念 / ✨ AI 两个开关互斥；亮起时实心填色（同 Tauri fill-violet-400 / fill-amber-400）
			for _, ic := range []string{"lightbulb", "sparkles"} {
				on := ic == "lightbulb" && a.sparkMode || ic == "sparkles" && a.taskAI
				tip := map[string][2]string{
					"lightbulb": {tr("点击进入闪念模式：随手记灵感"), tr("闪念模式：回车存为灵感（点击退出）")},
					"sparkles":  {tr("点击进入 AI 模式：自然语言建任务"), tr("AI 模式：回车让 AI 解析时间、重复与分组（点击退出）")},
				}[ic][map[bool]int{false: 0, true: 1}[on]]
				b := ui.Box(c).Size(18, 18).Radius(6).Center().Key("qa-" + ic).Role(ui.RoleButton).Label(tip).Tooltip(tip)
				if b.Hovered() {
					b.Background(k.track)
				}
				b.Children(func() {
					switch {
					case ic == "sparkles" && a.taskAIBusy:
						licon(c, "loader-circle", 14, amber400).Rotate(float32(c.Now().UnixMilli()%1000) * 0.36)
						c.AnimationFrame()
					case on:
						fill, stroke := k.violetIcon.Alpha(0.75), k.violetIcon
						if ic == "sparkles" {
							fill, stroke = amber400, oklch(0.769, 0.188, 70.08, 1) // amber-500
						}
						ui.Box(c).Size(14, 14).Children(func() {
							liconFilled(c, ic, 14, fill).Absolute().Top(0).Left(0)
							licon(c, ic, 14, stroke).Absolute().Top(0).Left(0)
						})
					default:
						licon(c, ic, 14, k.muted)
					}
				})
				if b.Clicked() && !a.taskAIBusy {
					if ic == "lightbulb" {
						a.sparkMode = !a.sparkMode
						if a.sparkMode {
							a.taskAI = false
						}
					} else {
						a.setTaskAIMode(!a.taskAI)
					}
				}
			}
			switch {
			case a.taskAIBusy:
				ph = tr("AI 解析中…")
			case a.taskAIDraft != nil:
				ph = tr("确认下方解析结果，或按 Esc 回到编辑")
			case a.taskAI:
				ph = tr("试试「每周一10点交周报，放工作组」，回车交给 AI…")
			case a.sparkMode:
				ph = tr("记录闪念灵感，回车保存…")
			}
		}
		qin := ui.TextInputBase(c, &a.taskDraft).Bind(&a.taskIn).Grow(1).Font(fontSans).FontSize(13).FixedLineHeight(18).
			TextColor(k.fg).PlaceholderColor(k.muted).Placeholder(ph).OnTextKey(func(key ui.TextKey) bool {
			if key.Key == ui.KeyEnter && key.Mods == 0 {
				if a.taskSub == 1 && a.taskAI {
					if a.taskAIDraft == nil && !a.taskAIBusy {
						a.parseTaskDraftAI(key.Text())
						a.taskDraft = ""
						key.SetText("")
					}
					return true
				}
				a.taskDraft = key.Text()
				a.addTaskDraft()
				key.SetText(a.taskDraft)
				return true
			}
			return false
		})
		a.taskQuickFocused = qin.Focused() // 速记框有焦点时 Space / x / ↑↓ 归输入框
	})
}

func (a *app) todayView(c *ui.Context, k tokens, now time.Time) {
	ag := agendaFor(a.tasks, now)
	events := a.todayEvents(now)
	st := a.store.Settings()
	nBills := 0
	if st.SubscriptionsEnabled {
		nBills = billsDueToday(a.store.Bills(), now)
	}
	a.todayStatsLine(c, k, ag, nBills, len(events), st)
	var dueBills []store.Bill
	if st.SubscriptionsEnabled {
		dueBills = todayBills(a.store.Bills(), now)
	}
	defer func() { // 同 Tauri：时间轴之后的「今天扣款」区（编辑跳到订阅子页）
		if len(dueBills) == 0 {
			return
		}
		ui.Column(c).Gap(2).Key("today-bills").Children(func() {
			text(c, tr("今天扣款"), 11, 16, 600, k.muted).LetterSpacing(0.88).Padding(0, 0, 0, 2)
			for _, b := range dueBills {
				a.billRow(c, k, b, st.Currency, now, "today")
			}
		})
	}()
	defer a.unscheduledSection(c, k, now) // 时间轴之后：没排时间的待办，可拖进时间轴
	if len(ag.earlier) == 0 && len(ag.timeline) == 0 && len(events) == 0 && len(dueBills) == 0 && len(a.unscheduledTasks()) == 0 {
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
	// 全天日程在轴顶；其余日程与任务排进按小时画格的时间轴（today_blocks.go）
	var allDay []macos.CalendarEvent
	for _, e := range events {
		if e.AllDay {
			allDay = append(allDay, e)
		}
	}
	if len(allDay) > 0 {
		ui.Column(c).Gap(4).Children(func() {
			for _, e := range allDay {
				ui.Row(c).Gap(6).AlignItems(ui.Start).Key("ad-" + e.ID).Children(func() {
					text(c, tr("全天"), 10, 14, 400, k.muted).Width(44).Padding(8, 0, 0, 0).TextAlign(ui.End)
					a.eventRow(c, k, e)
				})
			}
		})
	}
	for _, t := range ag.timeline { // 正在编辑的任务：展开行放在时间轴上方（时间块里放不下编辑表单）
		if a.taskOpen == t.ID {
			a.taskRow(c, k, t, now)
		}
	}
	a.dayGrid(c, k, a.todayBlocks(ag.timeline, events, now), now)
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
	bc := hoverLink(b, k)
	b.Children(func() {
		text(c, tr("全部顺延"), 10, 14, 400, bc)
		licon(c, "chevron-down", 10, bc)
	})
	b.Menu(func(m *ui.Menu) {
		now := a.now()
		base := time.Date(now.Year(), now.Month(), now.Day(), 9, 0, 0, 0, now.Location())
		for _, o := range []struct {
			label string
			at    time.Time
		}{{"今天 20:00", base.Add(11 * time.Hour)}, {"明天 9:00", base.AddDate(0, 0, 1)}, {"下周一 9:00", nextMonday(base)}} {
			if !o.at.After(now) { // 同 Tauri rescheduleOptions：已过的时间点不给（晚上 8 点后没有「今天 20:00」）
				continue
			}
			label := tr(o.label)
			if m.Item(label).Chosen() {
				before := slices.Clone(tasks)
				for _, t := range tasks {
					t.DueAt = o.at
					_ = a.store.UpdateTask(t)
				}
				a.showHUDUndo("ok", fmt.Sprintf(tr("已顺延 %d 个任务到%s"), len(before), label), func() {
					for _, t := range before {
						_ = a.store.UpdateTask(t)
					}
				})
			}
		}
		m.Separator()
		if m.Item(tr("清除到期时间")).Chosen() { // 同 Tauri OverdueRescheduleMenu run(null)
			before := slices.Clone(tasks)
			for _, t := range tasks {
				t.DueAt, t.RemindedAt = time.Time{}, time.Time{}
				_ = a.store.UpdateTask(t)
			}
			a.showHUDUndo("ok", fmt.Sprintf(tr("已清除 %d 个任务的到期时间"), len(before)), func() {
				for _, t := range before {
					_ = a.store.UpdateTask(t)
				}
			})
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
	// 任务分组拖动排序（同笔记分组）：按住区头拿起，其余分组平移让位，松手落进空位
	list := ui.Column(c).Gap(12).Key("tsec-list")
	sortListBegin[tsecDrag](&a.tsecSort, list, &a.tsecJump, &a.tsecSeen, func(from, to string) {
		_ = a.store.ReorderTaskSection(from, to)
		a.reload()
		b = bucketTasks(a.tasks, a.store.TaskSections(), now)
	})
	a.tsecOrder = a.tsecOrder[:0]
	for _, g := range b.groups {
		a.tsecOrder = append(a.tsecOrder, g.sec.ID)
	}
	list.Children(func() {
		for _, g := range b.groups {
			a.taskSection(c, k, g, now)
		}
	})
	sortListEnd(&a.tsecSort, a.tsecSeen)
	nb := ui.Row(c).Height(24).Margin(0, 0, 0, 8).Padding(4, 6).Gap(4).Radius(8).AlignItems(ui.Center).AlignSelf(ui.Start)
	nc := hoverLink(nb, k)
	nb.Children(func() {
		licon(c, "plus", 12, nc)
		text(c, tr("新建分组"), 11, 16, 400, nc)
	})
	if nb.Clicked() {
		a.store.AddTaskSection(fmt.Sprintf(tr("分组 %d"), len(a.store.TaskSections()))) // 同 Tauri addTaskSection 默认名
	}
	if len(b.done) > 0 {
		open := a.bandOpen["done"]
		r := ui.Row(c).Height(18).Margin(4, 0, 0, 0).Padding(2, 4).Gap(4).AlignItems(ui.Center).AlignSelf(ui.Start)
		r.Children(func() {
			foldChevronSized(c, !open, 10, k.muted)
			text(c, tr("已完成 ")+itoa(len(b.done)), 10, 14, 400, k.muted)
		})
		if r.Clicked() {
			a.bandOpen["done"] = !open
		}
		if open {
			ui.Column(c).Gap(4).Key("tdone-body").Transition(foldTransition).Children(func() {
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
			if h.Hovered() {
				h.Background(k.track)
			}
			h.Children(func() {
				foldChevronSized(c, !open, 12, fg)
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
			ui.Column(c).Gap(4).Key("band-body-" + key).Transition(foldTransition).Children(func() {
				for _, t := range tasks {
					a.taskRow(c, k, t, now)
				}
			})
		}
	})
}

func (a *app) taskSection(c *ui.Context, k tokens, g taskGroup, now time.Time) {
	collapsed := g.sec.Collapsed
	slot := ui.Column(c).Key("tslot-" + g.sec.ID) // 槽位不动、按它判断落点；内层平移让位
	sortTrack(&a.tsecSort, slot, g.sec.ID)
	slot.Children(func() {
		col := ui.Column(c).Gap(6).Key("tsec-" + g.sec.ID)
		sortShift(&a.tsecSort, col, a.tsecOrder, g.sec.ID, 12, a.tsecJump)
		col.Children(func() {
			if a.tsecSort.active == g.sec.ID {
				slotMark(c)
			}
			head := ui.Row(c).Height(20).Padding(0, 4, 0, 2).Gap(4).Radius(6).AlignItems(ui.Center).Key("tsechead-" + g.sec.ID)
			if a.taskSecRename != g.sec.ID {
				head.Drag(tsecDrag{g.sec.ID})
			}
			if head.Dragging() {
				a.tsecSort.begin(g.sec.ID)
				a.tsecSeen = true
				liftHead(c, head)
			}
			hovered := head.Hovered()
			_, over := ui.DragOver[taskDrag](head)
			if over {
				head.Background(stok(c).primary.Alpha(0.12))
			}
			if a.dragHover(c, "t:"+g.sec.ID, over, collapsed) {
				g.sec.Collapsed = false
				_ = a.store.UpdateTaskSection(g.sec)
			}
			if d, ok := ui.Drop[taskDrag](head); ok && !d.resize {
				_ = a.store.MoveTask(d.id, g.sec.ID, "")
			}
			head.Children(func() {
				b := ui.Box(c).Size(16, 16).Radius(6).Center()
				b.Children(func() { foldChevron(c, k, collapsed) })
				if b.Clicked() {
					g.sec.Collapsed = !collapsed
					_ = a.store.UpdateTaskSection(g.sec)
				}
				name := sectionTitle(g.sec)
				commit := func(v string) {
					if v = strings.TrimSpace(v); v != "" {
						sec := g.sec
						sec.Name = v
						_ = a.store.UpdateTaskSection(sec)
					}
					a.taskSecRename = ""
				}
				if a.taskSecRename == g.sec.ID {
					in := ui.TextInputBase(c, &a.taskSecName).Width(140).Font(fontSans).FontSize(11).TextColor(k.fg).Label(tr("分组名称"))
					if a.taskSecFocus { // 只在进入改名的首帧抢焦点，之后才能检测失焦
						in.Focus()
						a.taskSecFocus = false
					} else if !in.Focused() { // 同 Tauri onBlur={commitRename}
						commit(a.taskSecName)
					}
					in.OnTextKey(func(key ui.TextKey) bool {
						switch key.Key {
						case ui.KeyEnter:
							commit(key.Text())
							return true
						case ui.KeyEscape:
							a.taskSecRename = ""
							return true
						}
						return false
					})
				} else {
					label := text(c, name, 11, 16, 600, k.muted).LetterSpacing(0.88).Role(ui.RoleButton).Label(name).
						Tooltip(tr("拖动调整分组顺序 · 点击折叠/展开 · 双击重命名"))
					if label.Clicked() { // 同 Tauri：单击 220ms 后折叠 / 展开，期间双击则改为重命名
						a.taskSecClickSeq++
						seq, sec := a.taskSecClickSeq, g.sec
						time.AfterFunc(220*time.Millisecond, func() {
							a.onMain(func() {
								if a.taskSecClickSeq == seq {
									sec.Collapsed = !sec.Collapsed
									_ = a.store.UpdateTaskSection(sec)
								}
							})
						})
					}
					if label.DoubleClicked() {
						a.taskSecClickSeq++
						a.startTaskSecRename(g.sec)
					}
				}
				countBadge(c, len(g.tasks), k.muted, k.track)
				ui.Spacer(c)
				more := ghostIconButton(c, k, "tsec-more-"+g.sec.ID, "ellipsis", sectionTitle(g.sec)+" "+tr("分组操作"), 16, 12, false, hovered) // 悬停区头才显出「···」（同 Tauri）
				more.Menu(func(m *ui.Menu) {                                                                                                 // 同 Tauri 分组操作：重命名 / 上移 / 下移（收集箱也可）/ 删除（收集箱除外）
					secs := a.store.TaskSections()
					i := slices.IndexFunc(secs, func(x store.Section) bool { return x.ID == g.sec.ID })
					if m.Item(tr("重命名")).Chosen() {
						a.startTaskSecRename(g.sec)
					}
					if m.Item(tr("上移")).Disabled(i <= 0).Chosen() {
						_ = a.store.MoveTaskSection(g.sec.ID, -1)
					}
					if m.Item(tr("下移")).Disabled(i < 0 || i >= len(secs)-1).Chosen() {
						_ = a.store.MoveTaskSection(g.sec.ID, 1)
					}
					if g.sec.ID == store.TaskInbox {
						return
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
			ui.Column(c).Gap(4).Key("tsecbody-" + g.sec.ID).Transition(foldTransition).Children(func() {
				if len(g.tasks) == 0 {
					text(c, tr("此分组为空"), 11, 16, 400, k.muted).Padding(8, 0).TextAlign(ui.Center).FillWidth()
				}
				for _, t := range g.tasks {
					a.taskRow(c, k, t, now)
				}
			})
		})
	})
}

// tsecDrag 是被拖动排序的任务分组。
type tsecDrag struct{ id string }

// taskRow：卡片 38 高（边框 1 + 内边距 6/8），行内依次是优先级色条、状态圈、标题、重复 / 清单 / 到期、删除。
func (a *app) taskRow(c *ui.Context, k tokens, t store.Task, now time.Time) {
	done := t.Status == "done"
	open := a.taskOpen == t.ID
	card := ui.Column(c).Padding(6, 8).Radius(10).Border(1, ui.Transparent).Key("task-" + t.ID)
	if !open {
		card.Height(38)
	}
	if open && card.PressedOutside() { // 同 Tauri TaskRow 行外 mousedown：点到别处就保存并收起（弹层算在卡内）
		id := t.ID
		a.onMain(func() {
			if a.taskOpen == id {
				a.commitTaskEdit()
				a.taskOpen = ""
			}
		})
	}
	if t.Spark && !done {
		card.Background(k.sparkRow)
	} else {
		card.Background(k.card)
	}
	if a.taskFocus == t.ID && a.page == pageTasks { // 键盘焦点环（同 Tauri focus ring）
		card.Border(2, stok(c).primary.Alpha(0.6))
	}
	hovered := card.Hovered()
	elevated(card, k, hovered) // TaskRow：悬停 elevation-2，box-shadow 150ms
	card.ContextMenu(func(m *ui.Menu) { a.taskMenu(c, m, t) })
	if !open && !done { // 拖拽排序：放到另一行 = 插到它前面（可跨分组）；放到分组头 = 移到该组末尾。已完成不能拖（同 Tauri useSortable disabled）
		card.Drag(taskDrag{id: t.ID})
	}
	if card.Clicked() && !open { // 同 Tauri TaskRow：整行点击展开编辑（子按钮自己先吃掉点击）；展开态也登记可点，行内空白不算「行外」
		a.openTaskEdit(t)
	}
	dropOver := false
	if d, ok := ui.DragOver[taskDrag](card); ok && d.id != t.ID && !d.resize {
		dropOver = true
	}
	if d, ok := ui.Drop[taskDrag](card); ok && d.id != t.ID && !d.resize {
		_ = a.store.MoveTask(d.id, "", t.ID)
	}
	card.Children(func() {
		if dropOver {
			ui.Box(c).Absolute().Top(-4).Left(6).Right(6).Height(2).Radius(1).Background(stok(c).primary).PassThrough()
		}
		a.taskGrip(c, k, t)
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
			bar.Role(ui.RoleButton).Label(fmt.Sprintf(tr("优先级：%s（点击切换）"), tr(priorityLabels[max(0, slices.Index(priorityNames, t.Priority))])))
			if bar.Clicked() { // 同 Tauri：单击按 无 → 低 → 中 → 高 → 无 循环
				t.Priority = priorityNames[(slices.Index(priorityNames, t.Priority)+1)%len(priorityNames)]
				_ = a.store.UpdateTask(t)
			}
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
			st := ui.Box(c).Size(16, 16).Role(ui.RoleButton).Label(stLabel).Tooltip(stLabel)
			if st.Hovered() && t.Status == "todo" && !t.Spark {
				col = k.muted // 悬停时空心圈加深，提示可点
			}
			st.AnimatePose(ui.Pose{Scale: pressScale(st.Pressed(), 0.9)}, tweenControl)
			st.Children(func() { licon(c, icon, 16, col) })
			if st.Clicked() {
				if t.Spark && !done {
					t.Spark = false // 闪念点 💡 转为正式待办
					_ = a.store.UpdateTask(t)
				} else {
					a.cycleTaskStatus(t) // 待办 → 进行中 → 完成 → 待办（同 Tauri cycleTaskStatus）
				}
			}
			if a.taskOpen == t.ID {
				ti := ui.TextInputBase(c, &a.taskTitle).Grow(1).Basis(0).Font(fontSans).FontSize(13).TextColor(k.fg).Label(tr("任务标题"))
				if a.taskTitleFocus { // 同 Tauri：展开后聚焦标题
					ti.Focus()
					a.taskTitleFocus = false
				}
				ti.
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
			if !open { // 同 Tauri：有到期是紧迫色 chip（已完成也显示），没有时悬停露出「⏰ 到期」；展开态挪到编辑区常显
				a.dueTrigger(c, k, t, now, hovered)
			}
			if ghostIconButton(c, k, "tdel-"+t.ID, "trash-2", tr("删除任务"), 16, 12, true, hovered).Clicked() {
				if removed, pos, ok := a.store.DeleteTask(t.ID); ok {
					a.showHUDUndo("ok", tr("已删除 1 个任务"), func() { _ = a.store.RestoreTask(removed, pos) })
				}
			}
		})
		if open {
			a.taskEditor(c, k, t)
		}
	})
}

// taskMenu 同 Tauri TaskRow 右键：发送区 → 状态 / 编辑 / 提醒 / 拆解 /（灵感）转为待办 → 优先级 / 移动到 → 删除。
func (a *app) taskMenu(c *ui.Context, m *ui.Menu, t store.Task) {
	if m.Item(tr("发送到对话")).Chosen() {
		a.send([]store.Note{taskAsNote(t)})
	}
	if m.Item(tr("检查后发送…")).Chosen() {
		a.checkSend([]store.Note{taskAsNote(t)})
	}
	m.Separator()
	doneLabel, doingLabel := tr("标记完成"), tr("标记进行中")
	if t.Status == "done" {
		doneLabel = tr("恢复为待办")
	}
	if t.Status == "doing" {
		doingLabel = tr("恢复为待办")
	}
	if m.Item(doneLabel).Chosen() {
		a.setTaskStatus(t, map[bool]string{true: "todo", false: "done"}[t.Status == "done"])
	}
	if m.Item(doingLabel).Chosen() {
		a.setTaskStatus(t, map[bool]string{true: "todo", false: "doing"}[t.Status == "doing"])
	}
	if m.Item(tr("编辑任务…")).Chosen() {
		a.openTaskEdit(t)
	}
	dueLabel := tr("修改提醒时间…")
	if t.DueAt.IsZero() {
		dueLabel = tr("设置提醒时间…")
	}
	if m.Item(dueLabel).Chosen() { // 同 Tauri onReminder：打开完整到期弹层
		a.openDuePopover(t, a.now())
	}
	if m.Item(tr("AI 拆解子任务")).Chosen() {
		a.splitSubtasks(t)
	}
	a.taskDurationMenu(m, t)
	if t.Spark && m.Item(tr("转为待办")).Chosen() {
		t.Spark = false
		_ = a.store.UpdateTask(t)
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
	if secs := a.store.TaskSections(); len(secs) > 1 { // 同 Tauri MoveToSectionFlyout：多于一个分组才出，排除当前组
		cur := cmpOr(t.Section, store.TaskInbox)
		m.Submenu(tr("移动到"), func(sm *ui.Menu) {
			for _, s := range secs {
				if s.ID == cur {
					continue
				}
				name := s.Name
				if s.ID == store.TaskInbox {
					name = tr("收集箱")
				}
				if sm.Item(name).Chosen() {
					t.Section = s.ID
					_ = a.store.UpdateTask(t)
				}
			}
		})
	}
	m.Separator()
	if m.Item(tr("删除")).Chosen() {
		if removed, pos, ok := a.store.DeleteTask(t.ID); ok {
			a.showHUDUndo("ok", tr("已删除 1 个任务"), func() { _ = a.store.RestoreTask(removed, pos) })
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
	if sec.ID == store.TaskInbox && (sec.Name == "" || sec.Name == "收集箱") { // 同 Tauri sectionName：内置名才翻译，改过名用自定义名
		return tr("收集箱")
	}
	return sec.Name
}

func (a *app) startTaskSecRename(sec store.Section) {
	a.taskSecRename, a.taskSecName, a.taskSecFocus = sec.ID, sectionTitle(sec), true
}
