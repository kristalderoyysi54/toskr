package main

import (
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 任务到期弹层（同 Tauri TaskRow DueControl）：快捷档 → 自定义日期 + 时间「设定该时间」→ 清除到期 →
// 重复（频率 / 每周的星期几 / 起算方式 / 结束条件）→ 提醒我（多档）。重复与提醒档选即生效，日期时间走草稿。

var weekdayPicker = []int{1, 2, 3, 4, 5, 6, 0}

func weekdayChar(d int) string {
	if langEN.Load() {
		return []string{"S", "M", "T", "W", "T", "F", "S"}[d]
	}
	return []string{"日", "一", "二", "三", "四", "五", "六"}[d]
}

var reminderOffsetLabels = map[int]string{0: "到期时", 15: "提前 15 分钟", 60: "提前 1 小时", 1440: "提前 1 天", 4320: "提前 3 天"}

// dueTrigger：任务行上的到期入口——有到期时是带紧迫色的时间 chip，没有时悬停（或 always）露出「⏰ 到期」。
func (a *app) dueTrigger(c *ui.Context, k tokens, t store.Task, now time.Time, show bool) {
	open := a.dueOpenID == t.ID
	var anchor ui.Element
	if !t.DueAt.IsZero() {
		fg, bg := k.muted, k.laterChip
		switch dueTone(t.DueAt, now) {
		case "overdue":
			fg, bg = k.danger, k.danger.Alpha(0.15)
		case "today":
			fg, bg = k.amberText, k.amberBar.Alpha(0.15)
		}
		anchor = ui.Box(c).Height(18).Padding(2, 6).Radius(8).Background(bg).Key("due-" + t.ID).Role(ui.RoleButton).
			Label(tr("修改到期时间")).Tooltip(tr("修改到期时间"))
		anchor.Children(func() { text(c, dueBadge(t.DueAt, now), 10, 14, 400, fg) })
	} else {
		if !show && !open {
			return
		}
		anchor = ui.Row(c).Height(18).Padding(2, 4).Gap(2).Radius(8).AlignItems(ui.Center).Key("due-" + t.ID).Role(ui.RoleButton).
			Label(tr("设置到期提醒")).Tooltip(tr("设置到期提醒"))
		col := k.muted
		if anchor.Hovered() {
			col = k.fg
		}
		anchor.Children(func() {
			licon(c, "alarm-clock", 10, col)
			text(c, tr("到期"), 10, 14, 400, col)
		})
	}
	if anchor.Clicked() {
		if open {
			a.dueOpenID = ""
		} else {
			a.openDuePopover(t, now)
		}
		open = a.dueOpenID == t.ID
	}
	if !open {
		return
	}
	_, vh := c.Size()
	ui.Popover(c, anchor, &open, func() { // 高度钳到窗口的一半多一点，超出内滚（同 Tauri max-h available-height）
		ui.Scroll(c).Width(224).MaxHeight(max(260, vh*0.62)).Scrollbars(false).Children(func() {
			ui.Column(c).Gap(4).Children(func() { a.duePopoverBody(c, k, t, now) })
		})
	})
	if !open && a.dueOpenID == t.ID {
		a.dueOpenID = ""
	}
}

// openDuePopover：装载现值（无到期默认今天 20:00，同 Tauri）。
func (a *app) openDuePopover(t store.Task, now time.Time) {
	a.dueOpenID = t.ID
	if t.DueAt.IsZero() {
		a.dueDraft = time.Date(now.Year(), now.Month(), now.Day(), 20, 0, 0, 0, now.Location())
	} else {
		a.dueDraft = t.DueAt
	}
	a.dueCount = ""
}

func (a *app) setTaskDue(t store.Task, at time.Time) {
	if cur, ok := a.taskByID(t.ID); ok {
		cur.DueAt = at
		_ = a.store.UpdateTask(cur)
	}
	a.dueOpenID = ""
}

func (a *app) mutateTask(id string, fn func(t *store.Task)) {
	if cur, ok := a.taskByID(id); ok {
		fn(&cur)
		_ = a.store.UpdateTask(cur)
	}
}

func optionChip(c *ui.Context, k tokens, key, label string, on bool) bool {
	s := stok(c)
	b := ui.Box(c).Height(20).Padding(0, 6).Radius(6).Center().Key(key).Role(ui.RoleButton).Label(label)
	fg := k.muted
	switch {
	case on:
		b.Background(s.primary.Alpha(0.12)).Border(1, s.primary.Alpha(0.4))
		fg = s.primary
	case b.Hovered():
		b.Background(k.track).Border(1, ui.Transparent)
	default:
		b.Border(1, k.inputBorder)
	}
	b.Children(func() { text(c, label, 10, 14, 500, fg) })
	return b.Clicked()
}

func (a *app) duePopoverBody(c *ui.Context, k tokens, t store.Task, now time.Time) {
	s := stok(c)
	label := func(l string) { text(c, l, 10, 14, 500, k.muted).Padding(2, 4, 0, 4) }
	sep := func() { ui.Box(c).Height(1).Margin(2, 0).Background(k.inputBorder) }
	item := func(key, l string, fg ui.Color) bool {
		b := ui.Row(c).Height(24).Padding(0, 8).Radius(6).AlignItems(ui.Center).Key(key).Role(ui.RoleButton).Label(l)
		if b.Hovered() {
			b.Background(k.track)
		}
		b.Children(func() { text(c, l, 12, 17, 400, fg) })
		return b.Clicked()
	}
	for _, p := range a.store.Settings().Presets() {
		if item("dp-"+p.ID, presetLabel(p), k.fg) {
			a.setTaskDue(t, p.Due(a.now()))
			return
		}
	}
	sep()
	ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
		ui.DateInput(c, &a.dueDraft).Grow(1).Label(tr("到期日期"))
		ui.TimeInput(c, &a.dueDraft).Label(tr("到期时间"))
	})
	set := ui.Row(c).Height(26).Radius(6).Justify(ui.Center).AlignItems(ui.Center).Background(s.primary).Key("due-set").Role(ui.RoleButton).Label(tr("设定该时间"))
	set.Children(func() { text(c, tr("设定该时间"), 12, 17, 500, gray(1, 1)) })
	if set.Clicked() {
		a.setTaskDue(t, a.dueDraft.Truncate(time.Minute))
		return
	}
	if !t.DueAt.IsZero() && item("due-clear", tr("清除到期"), k.muted) {
		a.setTaskDue(t, time.Time{})
		return
	}
	sep()
	a.recurrenceEditor(c, k, t, now, label)
	if !t.DueAt.IsZero() {
		label(tr("提醒我"))
		ui.Row(c).Wrap().Gap(4).Padding(0, 2).Children(func() {
			cur := t.Offsets()
			for _, off := range store.TaskReminderOffsetOptions {
				on := slices.Contains(cur, off)
				if optionChip(c, k, "ro-"+strconv.Itoa(off), tr(reminderOffsetLabels[off]), on) {
					a.mutateTask(t.ID, func(x *store.Task) {
						next := slices.Clone(x.Offsets())
						if on {
							next = slices.DeleteFunc(next, func(o int) bool { return o == off })
						} else {
							next = append(next, off)
							slices.Sort(next)
						}
						x.ReminderOffsets = &next
					})
				}
			}
		})
	}
}

// recurrenceEditor 同 Tauri RecurrenceEditor：选档即生效；换频率保留起算方式与结束条件；每周至少保留一天；
// 没有到期时从今天起算下一期 9:00 补首期。
func (a *app) recurrenceEditor(c *ui.Context, k tokens, t store.Task, now time.Time, label func(string)) {
	anchor := t.DueAt
	if anchor.IsZero() {
		anchor = now
	}
	label(tr("重复"))
	ui.Row(c).Wrap().Gap(4).Padding(0, 2).Children(func() {
		for i, freq := range recurNames {
			if optionChip(c, k, "rf-"+itoa(i), tr(recurLabels[i]), t.Recurrence == freq) {
				a.mutateTask(t.ID, func(x *store.Task) {
					if freq == "" {
						x.Recurrence, x.RecurWeekdays, x.RecurBasis, x.RecurUntil, x.RecurCount = "", nil, "", time.Time{}, 0
						return
					}
					x.Recurrence = freq
					if freq != "weekly" {
						x.RecurWeekdays = nil
					}
					if x.DueAt.IsZero() {
						seed := time.Date(now.Year(), now.Month(), now.Day(), 9, 0, 0, 0, now.Location())
						if !seed.After(now) || !recurMatchesDay(*x, seed) {
							seed = store.NextOccurrenceDays(seed, freq, x.RecurWeekdays)
						}
						x.DueAt = seed
					}
				})
			}
		}
	})
	if t.Recurrence == "" {
		return
	}
	if t.Recurrence == "weekly" {
		days := t.RecurWeekdays
		if len(days) == 0 {
			days = []int{int(anchor.Weekday())}
		}
		ui.Row(c).Gap(2).Padding(0, 2).Children(func() {
			for _, d := range weekdayPicker {
				on := slices.Contains(days, d)
				if optionChip(c, k, "wd-"+itoa(d), weekdayChar(d), on) {
					next := slices.Clone(days)
					if on {
						next = slices.DeleteFunc(next, func(x int) bool { return x == d })
					} else {
						next = append(next, d)
					}
					if len(next) > 0 { // 至少保留一天
						slices.Sort(next)
						a.mutateTask(t.ID, func(x *store.Task) { x.RecurWeekdays = next })
					}
				}
			}
		})
	}
	ui.Row(c).Gap(4).Padding(0, 2).Children(func() {
		if optionChip(c, k, "rb-plan", tr("按计划日期"), t.RecurBasis == "") {
			a.mutateTask(t.ID, func(x *store.Task) { x.RecurBasis = "" })
		}
		if optionChip(c, k, "rb-done", tr("从完成时算起"), t.RecurBasis == "completion") {
			a.mutateTask(t.ID, func(x *store.Task) { x.RecurBasis = "completion" })
		}
	})
	label(tr("结束"))
	mode := "never"
	switch {
	case !t.RecurUntil.IsZero():
		mode = "until"
	case t.RecurCount > 0:
		mode = "count"
	}
	ui.Row(c).Gap(4).Padding(0, 2).Children(func() {
		if optionChip(c, k, "re-never", tr("永不"), mode == "never") {
			a.mutateTask(t.ID, func(x *store.Task) { x.RecurUntil, x.RecurCount = time.Time{}, 0 })
		}
		if optionChip(c, k, "re-until", tr("到某天"), mode == "until") && mode != "until" {
			a.mutateTask(t.ID, func(x *store.Task) {
				x.RecurUntil, x.RecurCount = time.Date(anchor.Year(), anchor.Month()+1, anchor.Day(), 0, 0, 0, 0, anchor.Location()), 0
			})
		}
		if optionChip(c, k, "re-count", tr("共几次"), mode == "count") && mode != "count" {
			a.mutateTask(t.ID, func(x *store.Task) { x.RecurUntil, x.RecurCount = time.Time{}, 10 })
			a.dueCount = "10"
		}
	})
	switch mode {
	case "until":
		until := t.RecurUntil
		if ui.DateInput(c, &until).Label(tr("重复结束日期")).Changed() {
			a.mutateTask(t.ID, func(x *store.Task) { x.RecurUntil = until })
		}
	case "count":
		if a.dueCount == "" {
			a.dueCount = strconv.Itoa(t.RecurCount)
		}
		ui.Row(c).Gap(6).Padding(0, 2).AlignItems(ui.Center).Children(func() {
			text(c, tr("还剩"), 11, 16, 400, k.muted)
			in := ui.TextInputBase(c, &a.dueCount).Width(48).Height(22).Padding(0, 6).Radius(6).Border(1, k.inputBorder).
				Font(fontSans).FontSize(11).TextColor(k.fg).Label(tr("剩余重复次数（含本期）"))
			if in.Changed() {
				if n, err := strconv.Atoi(strings.TrimSpace(a.dueCount)); err == nil && n >= 1 && n <= 999 {
					a.mutateTask(t.ID, func(x *store.Task) { x.RecurCount = n })
				}
			}
			text(c, tr("次（含本期）"), 11, 16, 400, k.muted)
		})
	}
}

// recurMatchesDay：seed 那天是否落在重复规则上（工作日 / 每周选中的星期几）。
func recurMatchesDay(t store.Task, d time.Time) bool {
	switch t.Recurrence {
	case "weekdays":
		return d.Weekday() != time.Saturday && d.Weekday() != time.Sunday
	case "weekly":
		return len(t.RecurWeekdays) == 0 || slices.Contains(t.RecurWeekdays, int(d.Weekday()))
	}
	return true
}
