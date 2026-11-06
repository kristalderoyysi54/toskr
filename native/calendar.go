package main

import (
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 苹果日历日程（同 Tauri appleCalendar.ts / CalendarEventRow / TodayPage）：只读叠加到「今天」时间轴，
// 全天日程在轴顶，其余按开始时刻与任务混排（同刻日程在前）；点日程在「日历」App 里打开。

var ( // 测试替换
	calStatus  = macos.CalendarStatus
	calEvents  = macos.CalendarEvents
	calList    = macos.Calendars
	calRequest = macos.RequestCalendarAccess
	calAsync   = func(f func()) { go f() }
)

// refreshCalendar 后台取今天的日程（关掉时清空），回主线程写入。
func (a *app) refreshCalendar() {
	on := a.store.Settings().CalendarOn
	calAsync(func() {
		var evs []macos.CalendarEvent
		status := ""
		if on {
			status = calStatus()
			if status == "granted" {
				day := dayStart(time.Now())
				evs = calEvents(day.UnixMilli(), day.AddDate(0, 0, 1).UnixMilli())
			}
		}
		a.onMain(func() { a.calEvents, a.calStatus = evs, status })
	})
}

// setCalendarEnabled：打开时尚未决定过就弹系统授权框；被拒则带到隐私设置。
func (a *app) setCalendarEnabled(on bool) {
	cur := a.store.Settings()
	cur.CalendarOn = on
	_ = a.store.SetSettings(cur)
	if !on {
		a.refreshCalendar()
		return
	}
	calAsync(func() {
		st := calStatus()
		if st == "notDetermined" {
			st = calRequest()
		}
		if st == "denied" || st == "restricted" {
			openPrivacy("Privacy_Calendars")
		}
		a.onMain(func() {
			a.calStatus = st
			a.calendars = nil
			a.refreshCalendar()
		})
	})
}

// todayEvents：当前显示的日程（过滤掉隐藏的日历、只留与今天相交的）。
func (a *app) todayEvents(now time.Time) []macos.CalendarEvent {
	st := a.store.Settings()
	if !st.CalendarOn {
		return nil
	}
	day := dayStart(now)
	start, end := day.UnixMilli(), day.AddDate(0, 0, 1).UnixMilli()
	var out []macos.CalendarEvent
	for _, e := range a.calEvents {
		if !slices.Contains(st.CalendarHidden, e.CalendarID) && e.StartMs < end && max(e.EndMs, e.StartMs+1) > start {
			out = append(out, e)
		}
	}
	slices.SortStableFunc(out, func(x, y macos.CalendarEvent) int { // 全天在前，再按开始时刻、标题
		switch {
		case x.AllDay != y.AllDay:
			if x.AllDay {
				return -1
			}
			return 1
		case x.StartMs != y.StartMs:
			return int(x.StartMs - y.StartMs)
		}
		return strings.Compare(x.Title, y.Title)
	})
	return out
}

// eventTimeLabel：全天 / 09:00–10:30 / 跨天时带上结束日期。
func eventTimeLabel(e macos.CalendarEvent) string {
	if e.AllDay {
		return tr("全天")
	}
	s, t := time.UnixMilli(e.StartMs), time.UnixMilli(e.EndMs)
	if !t.After(dayStart(s).AddDate(0, 0, 1)) {
		return s.Format("15:04") + "–" + t.Format("15:04")
	}
	return s.Format("15:04") + "–" + monthDay(t) + " " + t.Format("15:04")
}

// eventRow：灰底块与可操作的任务行区分，图标取该日历在系统里的颜色；点击在「日历」中打开。
func (a *app) eventRow(c *ui.Context, k tokens, e macos.CalendarEvent) {
	var meta []string
	for _, s := range []string{eventTimeLabel(e), e.CalendarTitle, e.Location} {
		if s != "" {
			meta = append(meta, s)
		}
	}
	title := e.Title
	if title == "" {
		title = tr("（无标题）")
	}
	row := ui.Row(c).Grow(1).Padding(4, 8).Gap(6).Radius(8).AlignItems(ui.Start).Key("ev-" + e.ID).
		Tooltip(tr("在「日历」中打开")).Role(ui.RoleButton).Label(title)
	bg := k.fg.Alpha(0.04)
	if row.Hovered() {
		bg = k.fg.Alpha(0.07)
	}
	row.Background(bg).Children(func() {
		col := k.muted
		if e.CalendarColor != "" {
			col = hexColor(e.CalendarColor) // token-exception: 用户日历的系统颜色（运行时数据）
		}
		ui.Box(c).Margin(2, 0, 0, 0).Children(func() { licon(c, "calendar-days", 14, col) })
		ui.Column(c).Grow(1).Basis(0).Children(func() {
			text(c, title, 12, 18, 400, k.fg.Alpha(0.8)).SingleLine()
			text(c, strings.Join(meta, " · "), 10, 14, 400, k.muted).SingleLine()
		})
	})
	if row.Clicked() {
		_ = exec.Command("/usr/bin/open", macos.CalendarEventURL(e.ItemID, e.StartMs, e.Recurring)).Start()
	}
}

// billsDueToday：今天扣款的在用账单数（「今天」统计格）。
func billsDueToday(bills []store.Bill, now time.Time) int { return len(todayBills(bills, now)) }

// todayBills：今天扣款的在用账单（同 Tauri TodayPage todayBills）。
func todayBills(bills []store.Bill, now time.Time) []store.Bill {
	var out []store.Bill
	for _, b := range bills {
		if b.Status == "active" && sameDay(b.NextDueAt, now) {
			out = append(out, b)
		}
	}
	return out
}

// calendarSettings：更多功能 → 苹果日历（只读）：开关、授权状态、显示的日历。
func (a *app) calendarSettings(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setRow {
	rows := []setRow{{title: tr("显示苹果日历日程"), hint: tr("在「今天」时间轴里显示；只读，不会改动日历里的日程。点日程可在「日历」App 中打开。"), control: func() {
		on := st.CalendarOn
		if toggle(c, s, &on) {
			a.setCalendarEnabled(on)
		}
	}}}
	if !st.CalendarOn {
		return rows
	}
	if a.calStatus != "" && a.calStatus != "granted" {
		rows = append(rows, setRow{title: tr("未获得日历访问权限"), hint: tr("在「系统设置 → 隐私与安全性 → 日历」里允许 Toskr Native 完整访问"), control: func() {
			if a.calStatus == "notDetermined" { // 还没问过（如从 Tauri 导入了开启状态）：在这里弹系统授权框
				if button(c, s, "授权") {
					a.setCalendarEnabled(true)
				}
			} else if button(c, s, "打开设置") {
				openPrivacy("Privacy_Calendars")
			}
		}})
		return rows
	}
	if a.calendars == nil && a.calStatus == "granted" && !a.calListing {
		a.calListing = true
		calAsync(func() {
			list := calList()
			a.onMain(func() { a.calendars, a.calListing = list, false })
		})
	}
	if len(a.calendars) == 0 {
		return rows
	}
	return append(rows, setRow{title: tr("显示的日历"), hint: tr("点一下切换显示"), below: func() {
		ui.Row(c).Wrap().Gap(6).Children(func() {
			for _, cal := range a.calendars {
				shown := !slices.Contains(st.CalendarHidden, cal.ID)
				chip := ui.Row(c).Height(22).Padding(0, 8).Gap(6).Radius(11).AlignItems(ui.Center).Key("cal-" + cal.ID).Tooltip(cal.Source).Role(ui.RoleButton).Label(cal.Title)
				if shown {
					chip.Background(s.card).Border(1, s.cardBorder)
				} else {
					chip.Border(1, s.cardBorder).BorderStyle(ui.BorderDashed)
				}
				chip.Children(func() {
					col := k.muted
					if cal.Color != "" {
						col = hexColor(cal.Color) // token-exception: 用户日历的系统颜色
					}
					ui.Box(c).Size(8, 8).Radius(4).Background(col)
					fg := k.fg
					if !shown {
						fg = k.muted
					}
					text(c, cal.Title, 11, 16, 400, fg).SingleLine()
				})
				if chip.Clicked() {
					cur := a.store.Settings()
					if shown {
						cur.CalendarHidden = append(slices.Clone(cur.CalendarHidden), cal.ID)
					} else {
						cur.CalendarHidden = slices.DeleteFunc(slices.Clone(cur.CalendarHidden), func(id string) bool { return id == cal.ID })
					}
					_ = a.store.SetSettings(cur)
				}
			}
		})
	}})
}
