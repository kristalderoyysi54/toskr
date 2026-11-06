package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 任务页头部两个开关（Tauri RemindersPage）：搜索与筛选（TaskFilterBar）、任务月历（TaskCalendar）。

// taskFilterChips 同 Tauri FILTER_CHIPS；原生任务没有来源消息字段，「来自消息」暂不提供。
var taskFilterChips = [][2]string{
	{"week", "7 天内到期"}, {"high", "高优先级"}, {"checklist", "有检查项"}, {"recurring", "重复"}, {"done", "已完成"},
}

type taskFilter struct {
	query string
	chips []string
}

func (f taskFilter) active() bool { return strings.TrimSpace(f.query) != "" || len(f.chips) > 0 }

// filterTasks 同 Tauri lib/tasks.ts filterTasks：关键词匹配标题 / 备注 / 检查项（不区分大小写），chip 取交集；
// 已完成默认排除，勾选「已完成」后只看已完成。按到期时间（无到期排后）再按创建时间排序。
func filterTasks(tasks []store.Task, f taskFilter, now time.Time) []store.Task {
	q := strings.ToLower(strings.TrimSpace(f.query))
	has := func(c string) bool { return slices.Contains(f.chips, c) }
	weekEnd := dayStart(now).AddDate(0, 0, 7)
	var out []store.Task
	for _, t := range tasks {
		if has("done") != (t.Status == "done") {
			continue
		}
		if has("week") && (t.DueAt.IsZero() || !t.DueAt.Before(weekEnd)) {
			continue
		}
		if has("high") && t.Priority != "high" {
			continue
		}
		if has("checklist") && len(t.Checklist) == 0 {
			continue
		}
		if has("recurring") && t.Recurrence == "" {
			continue
		}
		if q != "" {
			hit := strings.Contains(strings.ToLower(t.Text), q) || strings.Contains(strings.ToLower(t.Note), q)
			for _, c := range t.Checklist {
				hit = hit || strings.Contains(strings.ToLower(c.Text), q)
			}
			if !hit {
				continue
			}
		}
		out = append(out, t)
	}
	slices.SortStableFunc(out, func(x, y store.Task) int {
		switch {
		case x.DueAt.IsZero() != y.DueAt.IsZero():
			if x.DueAt.IsZero() {
				return 1
			}
			return -1
		case !x.DueAt.Equal(y.DueAt):
			return x.DueAt.Compare(y.DueAt)
		}
		return y.CreatedAt.Compare(x.CreatedAt)
	})
	return out
}

// toggleChip：chip 圆角描边小按钮（选中蓝描边浅底）。
func toggleChip(c *ui.Context, k tokens, label string, on bool) bool {
	s := stok(c)
	b := ui.Box(c).Padding(1, 8).Radius(999).Key("chip-" + label).Role(ui.RoleButton).Label(label)
	fg := k.muted
	switch {
	case on:
		b.Border(1, s.primary.Alpha(0.5)).Background(s.primary.Alpha(0.1))
		fg = s.primary
	default:
		b.Border(1, k.inputBorder)
		if b.Hovered() {
			fg = k.fg
		}
	}
	b.Children(func() { text(c, label, 10, 14, 400, fg) })
	return b.Clicked()
}

// taskFilterBar：搜索框 + 条件 chip。Esc 先清空关键词，再按一次关闭筛选栏。
func (a *app) taskFilterBar(c *ui.Context, k tokens, count int) {
	ui.Column(c).Margin(6, 12, 0, 12).Gap(6).Children(func() {
		ui.Row(c).Height(26).Padding(0, 10).Gap(6).Radius(999).Border(1, k.inputBorder).AlignItems(ui.Center).Children(func() {
			licon(c, "search", 14, k.muted)
			ui.TextInputBase(c, &a.taskFilter.query).Grow(1).Font(fontSans).FontSize(13).TextColor(k.fg).PlaceholderColor(k.muted).
				Placeholder(tr("搜索标题、备注、检查项…")).Label(tr("搜索任务")).Focus().OnTextKey(func(key ui.TextKey) bool {
				if key.Key != ui.KeyEscape {
					return false
				}
				if key.Text() != "" {
					key.SetText("")
					a.taskFilter.query = ""
				} else {
					a.taskFilterOn, a.taskFilter = false, taskFilter{}
				}
				return true
			})
			if a.taskFilter.active() {
				text(c, fmt.Sprintf(tr("%d 条"), count), 10, 14, 400, k.muted).FontFeatures("tnum")
			}
		})
		ui.Row(c).Gap(4).Wrap().Children(func() {
			for _, ch := range taskFilterChips {
				on := slices.Contains(a.taskFilter.chips, ch[0])
				if toggleChip(c, k, tr(ch[1]), on) {
					if on {
						a.taskFilter.chips = slices.DeleteFunc(slices.Clone(a.taskFilter.chips), func(x string) bool { return x == ch[0] })
					} else {
						a.taskFilter.chips = append(slices.Clone(a.taskFilter.chips), ch[0])
					}
				}
			}
		})
	})
}

// taskCalendar：任务月历（同 Tauri TaskCalendar）：有到期任务的天显示未完成计数，订阅开启时显示账单扣款点；
// 点选某天列出当天任务，并可为该天添加任务（今天 20:00、其余 9:00 到期）。
func (a *app) taskCalendar(c *ui.Context, k tokens, now time.Time) {
	s := stok(c)
	if a.taskCalDay.IsZero() {
		a.taskCalDay = dayStart(now)
	}
	today := dayStart(now)
	first := time.Date(now.Year(), now.Month()+time.Month(a.taskCalMonth), 1, 0, 0, 0, 0, now.Location())
	end := first.AddDate(0, 1, 0)
	lead := (int(first.Weekday()) + 6) % 7
	rows := (lead + end.AddDate(0, 0, -1).Day() + 6) / 7
	gridStart := first.AddDate(0, 0, -lead)
	billsOn := a.store.Settings().SubscriptionsEnabled
	showBills := billsOn && !a.taskCalHideBills
	byDay := map[time.Time][]store.Task{}
	for _, t := range a.tasks {
		if !t.DueAt.IsZero() {
			d := dayStart(t.DueAt)
			byDay[d] = append(byDay[d], t)
		}
	}
	for _, list := range byDay {
		slices.SortStableFunc(list, func(x, y store.Task) int { return x.DueAt.Compare(y.DueAt) })
	}
	billsOn1 := func(day time.Time) []store.Bill {
		if !showBills {
			return nil
		}
		var out []store.Bill
		for _, b := range a.bills {
			if len(billOccurrences(b, day, day.AddDate(0, 0, 1))) > 0 {
				out = append(out, b)
			}
		}
		return out
	}
	ui.Column(c).Gap(6).Children(func() {
		ui.Column(c).Padding(8).Radius(12).Background(k.track).Children(func() {
			ui.Row(c).Margin(0, 0, 4, 0).Gap(4).AlignItems(ui.Center).Children(func() {
				text(c, fmt.Sprintf(tr("%d 年 %d 月"), first.Year(), first.Month()), 11, 16, 600, k.fg).FontFeatures("tnum").Padding(0, 0, 0, 4).Grow(1)
				if billsOn || a.store.Settings().CalendarOn { // 同 Tauri：订阅或苹果日历任一开着就给「任务」开关
					if toggleChip(c, k, tr("任务"), !a.taskCalHideTasks) {
						a.taskCalHideTasks = !a.taskCalHideTasks
					}
				}
				if billsOn {
					if toggleChip(c, k, tr("账单"), !a.taskCalHideBills) {
						a.taskCalHideBills = !a.taskCalHideBills
					}
				}
				if a.taskCalMonth != 0 {
					b := ui.Box(c).Padding(2, 6).Radius(6).Role(ui.RoleButton).Label(tr("今天"))
					if b.Hovered() {
						b.Background(k.hoverBg)
					}
					b.Children(func() { text(c, tr("今天"), 10, 14, 400, k.muted) })
					if b.Clicked() {
						a.taskCalMonth = 0
					}
				}
				if a.iconButton(c, k, "chevron-left", 18, 12, tr("上个月")) {
					a.taskCalMonth--
				}
				if a.iconButton(c, k, "chevron-right", 18, 12, tr("下个月")) {
					a.taskCalMonth++
				}
			})
			ui.Row(c).Gap(4).Children(func() {
				for _, w := range []int{1, 2, 3, 4, 5, 6, 0} {
					text(c, tr(weekdayChars[w]), 10, 14, 400, k.muted).Grow(1).Basis(0).Padding(2, 0).TextAlign(ui.Center)
				}
			})
			ui.Column(c).Margin(4, 0, 0, 0).Gap(4).Children(func() {
				for r := range rows {
					ui.Row(c).Gap(4).Key("tc" + itoa(r)).Children(func() {
						for col := range 7 {
							day := gridStart.AddDate(0, 0, r*7+col)
							in := !day.Before(first) && day.Before(end)
							sel := day.Equal(a.taskCalDay)
							pending := 0
							if !a.taskCalHideTasks {
								for _, t := range byDay[day] {
									if t.Status != "done" {
										pending++
									}
								}
							}
							bills := len(billsOn1(day))
							cell := ui.Column(c).Grow(1).Basis(0).Height(36).Radius(8).Justify(ui.Center).AlignItems(ui.Center).
								Key(day.Format("0102")).Role(ui.RoleButton).Label(monthDay(day))
							fg := k.fg
							switch {
							case sel:
								cell.Background(s.primary)
								fg = gray(0.985, 1)
							case cell.Hovered():
								cell.Background(k.hoverBg)
							case in:
								cell.Background(k.fg.Alpha(0.05))
							default:
								cell.Background(k.fg.Alpha(0.03))
								fg = k.muted.Alpha(0.7)
							}
							weight := 400
							if day.Equal(today) && !sel {
								fg, weight = s.primary, 600
							}
							cell.Children(func() {
								text(c, itoa(day.Day()), 11, 16, weight, fg).FontFeatures("tnum")
								ui.Row(c).Height(8).Gap(2).AlignItems(ui.Center).Children(func() {
									if pending > 0 {
										pbg, pfg := k.danger.Alpha(0.8), gray(1, 1)
										if sel {
											pbg, pfg = gray(0.985, 0.9), s.primary
										}
										ui.Box(c).Padding(0, 3).Radius(999).Background(pbg).Children(func() {
											text(c, itoa(pending), 9, 10, 600, pfg).FontFeatures("tnum")
										})
									}
									if bills > 0 {
										dot := k.tealBar
										if sel {
											dot = gray(0.985, 0.9)
										}
										ui.Box(c).Size(6, 6).Radius(3).Background(dot)
									}
								})
							})
							if cell.Clicked() {
								a.taskCalDay = day
							}
						}
					})
				}
			})
		})
		// 选中日：就地添加 + 当天任务 + 当天账单
		label := monthDay(a.taskCalDay)
		switch int(a.taskCalDay.Sub(today).Hours() / 24) {
		case 0:
			label = tr("今天 · ") + label
		case 1:
			label = tr("明天 · ") + label
		}
		text(c, label, 10, 14, 400, k.muted).Padding(0, 4)
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.TextInputBase(c, &a.taskCalDraft).Grow(1).Height(26).Padding(0, 6).Radius(6).Border(1, k.inputBorder).Font(fontSans).FontSize(13).
				TextColor(k.fg).PlaceholderColor(k.muted).Placeholder(fmt.Sprintf(tr("为%s添加任务…"), label)).Label(tr("为选中日期添加任务")).
				OnTextKey(func(key ui.TextKey) bool {
					if key.Key == ui.KeyEnter && key.Mods == 0 {
						a.taskCalDraft = key.Text()
						if a.addTaskForDay(today) {
							key.SetText("")
						}
						return true
					}
					return false
				})
			if a.iconButton(c, k, "plus", 22, 14, tr("添加到该日")) {
				a.addTaskForDay(today)
			}
		})
		if !a.taskCalHideTasks {
			list := byDay[a.taskCalDay]
			if len(list) == 0 {
				text(c, tr("当天没有到期任务"), 11, 16, 400, k.muted).Padding(6, 0).TextAlign(ui.Center).FillWidth()
			}
			ui.Column(c).Gap(4).Children(func() {
				for _, t := range list {
					a.taskRow(c, k, t, now)
				}
			})
		}
		if bills := billsOn1(a.taskCalDay); len(bills) > 0 {
			cur := a.store.Settings().Currency
			ui.Column(c).Gap(2).Children(func() {
				for _, b := range bills {
					a.billRow(c, k, b, cur, now, "cal")
				}
			})
		}
	})
}

func (a *app) addTaskForDay(today time.Time) bool {
	t := store.Task{Text: strings.TrimSpace(a.taskCalDraft)} // 同 Tauri addForDay：原文入库
	if t.Text == "" {
		return false
	}
	hour := 9
	if a.taskCalDay.Equal(today) {
		hour = 20 // 今天上午加任务用 9:00 会立刻变逾期红
	}
	d := a.taskCalDay
	t.DueAt = time.Date(d.Year(), d.Month(), d.Day(), hour, 0, 0, 0, d.Location())
	a.store.AddTask(t)
	a.taskCalDraft = ""
	a.showHUD("added", fmt.Sprintf(tr("已加到 %s"), monthDay(d)))
	return true
}
