package main

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 订阅页按 Tauri 版 SubscriptionsPage / BillWeekStrip / BillMonthGrid / BillList / BillTrendChart 复刻：
// 摘要条 36 → 滚动区（周条或月历 · 当日账单 · 即将到期/全部 列表 · 近 6 个月消费）。

var (
	cycleNames  = []string{"weekly", "monthly", "quarterly", "semiannual", "yearly"}
	cycleLabels = []string{"每周", "每月", "每季", "半年", "每年"}
	// 周期五色与首字色块色板：Tauri lib/bills.ts 的数据调色板
	cycleColors    = map[string]ui.Color{"weekly": hexColor("#0ea5e9"), "monthly": hexColor("#8b5cf6"), "quarterly": hexColor("#22c55e"), "semiannual": hexColor("#f97316"), "yearly": hexColor("#eab308")}
	fallbackColors = []string{"#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899"}
	weekdayChars   = []string{"日", "一", "二", "三", "四", "五", "六"}
)

func hexColor(s string) ui.Color {
	v, _ := strconv.ParseUint(strings.TrimPrefix(s, "#"), 16, 32)
	return ui.RGB(uint8(v>>16), uint8(v>>8), uint8(v))
}

// billFallbackColor 与 Tauri 同算法：码点 31 进制滚动哈希（uint32）取模。
func billFallbackColor(name string) ui.Color {
	var h uint32
	for _, r := range name {
		h = h*31 + uint32(r)
	}
	return hexColor(fallbackColors[h%uint32(len(fallbackColors))])
}

func dayStart(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

// billOccurrences：[from, to) 内的到期日（过去看记账、未来按 nextDueAt 投影；仅 active）。
func billOccurrences(b store.Bill, from, to time.Time) []time.Time {
	if b.Status != "active" {
		return nil
	}
	var out []time.Time
	add := func(d time.Time) {
		d = dayStart(d)
		if !slices.ContainsFunc(out, d.Equal) {
			out = append(out, d)
		}
	}
	for _, p := range b.History {
		if !p.Period.IsZero() && !p.Period.Before(from) && p.Period.Before(to) {
			add(p.Period)
		}
	}
	due := b.NextDueAt
	for g := 0; due.Before(to) && g < 40; g++ {
		if !due.Before(from) {
			add(due)
		}
		due = store.AdvanceCycle(due, b.Cycle)
	}
	slices.SortFunc(out, func(x, y time.Time) int { return x.Compare(y) })
	return out
}

// billsDueWithin：未来 days 天（含今天）到期的 active 账单，按到期升序。
func billsDueWithin(bills []store.Bill, now time.Time, days int) []store.Bill {
	from := dayStart(now)
	to := from.AddDate(0, 0, days)
	var out []store.Bill
	for _, b := range bills {
		if b.Status == "active" && !b.NextDueAt.Before(from) && b.NextDueAt.Before(to) {
			out = append(out, b)
		}
	}
	slices.SortStableFunc(out, func(x, y store.Bill) int { return x.NextDueAt.Compare(y.NextDueAt) })
	return out
}

// monthSpend：本月已记账 + active 订阅本月剩余到期投影（只算订阅，信用卡不进消费汇总）。
func monthSpend(bills []store.Bill, now time.Time) float64 {
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	end := start.AddDate(0, 1, 0)
	total := 0.0
	for _, b := range bills {
		if b.Kind != "subscription" {
			continue
		}
		for _, p := range b.History {
			if !p.At.Before(start) && p.At.Before(end) {
				total += p.Amount
			}
		}
		if b.Status != "active" {
			continue
		}
		due := b.NextDueAt
		for g := 0; due.Before(end) && g < 8; g++ {
			if !due.Before(start) {
				total += b.Amount
			}
			due = store.AdvanceCycle(due, b.Cycle)
		}
	}
	return total
}

type monthBucket struct {
	year  int
	month time.Month
	total float64
}

func spendTrend(bills []store.Bill, now time.Time, months int) []monthBucket {
	out := make([]monthBucket, months)
	for i := range out {
		m := time.Date(now.Year(), now.Month()-time.Month(months-1-i), 1, 0, 0, 0, 0, now.Location())
		out[i] = monthBucket{year: m.Year(), month: m.Month()}
	}
	for _, b := range bills {
		if b.Kind != "subscription" {
			continue
		}
		for _, p := range b.History {
			for i := range out {
				if p.At.Year() == out[i].year && p.At.Month() == out[i].month {
					out[i].total += p.Amount
				}
			}
		}
	}
	return out
}

// compareBills：active 在前（到期早在前），暂停/取消垫底按名称。
func compareBills(x, y store.Bill) int {
	rx, ry := x.Status != "active", y.Status != "active"
	if rx != ry {
		if rx {
			return 1
		}
		return -1
	}
	if !rx {
		return x.NextDueAt.Compare(y.NextDueAt)
	}
	return strings.Compare(x.Name, y.Name)
}

// fmtAmount：最多两位小数、去尾零（68 → 68，68.5 → 68.5）。
func fmtAmount(v float64) string {
	return strconv.FormatFloat(float64(int64(v*100+0.5))/100, 'f', -1, 64)
}

func money(cur string, v float64) string { return cur + fmtAmount(v) }

func monthDay(t time.Time) string { return fmt.Sprintf(tr("%d月%d日"), t.Month(), t.Day()) }

func billDueBadge(b store.Bill, now time.Time) (string, string) {
	days := int(math.Round(dayStart(b.NextDueAt).Sub(dayStart(now)).Hours() / 24))
	switch {
	case days < 0:
		return fmt.Sprintf(tr("逾期 %d 天"), -days), "overdue"
	case days == 0:
		return tr("今天"), "today"
	case days == 1:
		return tr("明天"), "today"
	case days < 7:
		return fmt.Sprintf(tr("%d 天后"), days), "later"
	}
	return fmt.Sprintf("%d/%d", b.NextDueAt.Month(), b.NextDueAt.Day()), "later"
}

// ---- 视图 ----

func (a *app) billsPage(c *ui.Context, k tokens) {
	now := a.now()
	cur := a.store.Settings().Currency
	if a.billDay.IsZero() {
		a.billDay = dayStart(now)
	}
	if len(a.bills) == 0 && !a.billForm.open {
		ui.Column(c).Grow(1).Children(func() {
			a.emptyState(c, k, "credit-card", tr("还没有订阅账单"), tr("记下订阅服务与信用卡还款日，\n到期前自动弹提醒，不再错过续费与还款。"))
			ui.Row(c).Padding(0, 0, 16, 0).Justify(ui.Center).Children(func() {
				if smallButton(c, k, "plus", tr("添加订阅")) {
					a.openBillForm(nil)
				}
			})
		})
		return
	}
	upcoming := billsDueWithin(a.bills, now, 7)
	ui.Row(c).Height(36).Padding(0, 14, 4, 14).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Column(c).Grow(1).Basis(0).Children(func() {
			text(c, fmt.Sprintf(tr("本月 %s"), money(cur, monthSpend(a.bills, now))), 13, 18, 600, k.fg).SingleLine()
			sub := tr("未来 7 天没有到期账单")
			if len(upcoming) > 0 {
				sub = fmt.Sprintf(tr("未来 7 天有 %d 笔到期"), len(upcoming))
			}
			text(c, sub, 10, 14, 400, k.muted)
		})
		if v, ok := miniSegmented(c, k, a.billView, [][2]string{{"week", "周"}, {"month", "月"}}); ok {
			a.billView = v
		}
		if a.iconButton(c, k, "chart-column", 22, 14, tr("消费分析")) {
			a.billAnalytics = !a.billAnalytics
		}
		if a.iconButton(c, k, "plus", 22, 14, tr("添加订阅")) {
			a.openBillForm(nil)
		}
	})
	ui.Scroll(c).Grow(1).Scrollbars(false).Children(func() {
		ui.Column(c).Padding(4, 14, 8, 14).Gap(8).Children(func() {
			// AddBillFlow / BillAnalytics 弹层：fade-in + 自下 8px 滑入，100ms ease；无离场动画
			sheet := ui.ElementTransition{Duration: 100 * time.Millisecond, Ease: easeCSS, Enter: &ui.Motion{Y: 8}}
			if a.billForm.open {
				ui.Column(c).Key("bill-editor").Transition(sheet).Children(func() { a.billEditor(c, k) })
			}
			if a.billAnalytics {
				ui.Column(c).Key("bill-analytics").Transition(sheet).Children(func() { a.billAnalyticsCard(c, k, cur, now) })
			}
			if a.billView == "month" {
				a.billMonthGrid(c, k, now)
			} else {
				a.billWeekStrip(c, k, now)
			}
			ui.Column(c).Children(func() {
				label := monthDay(a.billDay)
				switch int(math.Round(a.billDay.Sub(dayStart(now)).Hours() / 24)) {
				case 0:
					label = tr("今天 · ") + label
				case 1:
					label = tr("明天 · ") + label
				}
				text(c, label, 10, 14, 400, k.muted).Padding(0, 4, 2, 4)
				var day []store.Bill
				for _, b := range a.bills {
					if len(billOccurrences(b, a.billDay, a.billDay.AddDate(0, 0, 1))) > 0 {
						day = append(day, b)
					}
				}
				if len(day) == 0 {
					text(c, tr("当日没有到期账单"), 11, 16, 400, k.muted).Padding(8, 0).TextAlign(ui.Center).FillWidth()
				}
				ui.Column(c).Gap(2).Children(func() {
					for _, b := range day {
						a.billRow(c, k, b, cur, now, "day")
					}
				})
			})
			ui.Column(c).Children(func() {
				ui.Row(c).Padding(0, 4, 4, 4).Children(func() {
					if v, ok := miniSegmented(c, k, a.billFilter, [][2]string{{"upcoming", "即将到期"}, {"all", "全部"}}); ok {
						a.billFilter = v
					}
				})
				a.billList(c, k, cur, now)
			})
			a.billTrend(c, k, cur, now)
		})
	})
}

func (a *app) billList(c *ui.Context, k tokens, cur string, now time.Time) {
	list := billsDueWithin(a.bills, now, 7)
	if a.billFilter == "all" {
		list = slices.Clone(a.bills)
		slices.SortStableFunc(list, compareBills)
	}
	if len(list) == 0 {
		empty := tr("未来 7 天没有到期账单")
		if a.billFilter == "all" {
			empty = tr("还没有账单")
		}
		text(c, empty, 11, 16, 400, k.muted).Padding(8, 0).TextAlign(ui.Center).FillWidth()
		return
	}
	var subs, cards []store.Bill
	for _, b := range list {
		if b.Kind == "creditCard" {
			cards = append(cards, b)
		} else {
			subs = append(subs, b)
		}
	}
	headers := len(subs) > 0 && len(cards) > 0
	ui.Column(c).Gap(2).Children(func() {
		for _, g := range []struct {
			label string
			items []store.Bill
		}{{tr("订阅"), subs}, {tr("还款"), cards}} {
			if len(g.items) == 0 {
				continue
			}
			ui.Column(c).Key("bg-" + g.label).Children(func() {
				if headers {
					text(c, g.label, 10, 14, 500, k.muted).Padding(4, 6, 2, 6)
				}
				ui.Column(c).Gap(2).Children(func() {
					for _, b := range g.items {
						a.billRow(c, k, b, cur, now, "list")
					}
				})
			})
		}
	})
}

func billAvatar(c *ui.Context, b store.Bill, size float32) {
	fs, lh := float32(11), float32(16)
	if size < 20 {
		fs, lh = 10, 14
	}
	initial := "?"
	if r := []rune(strings.TrimSpace(b.Name)); len(r) > 0 {
		initial = strings.ToUpper(string(r[0]))
	}
	ui.Box(c).Size(size, size).Radius(size * 0.2).Background(billFallbackColor(b.Name)).Center().Children(func() {
		text(c, initial, fs, lh, 600, ui.RGB(255, 255, 255))
	})
}

// billRow：头像 24 + 名称/周期金额 + 悬停操作（信用卡「标记已还」、更多）+ 行尾到期徽标。
func (a *app) billRow(c *ui.Context, k tokens, b store.Bill, cur string, now time.Time, scope string) {
	if b.Currency != "" {
		cur = b.Currency
	}
	inactive := b.Status != "active"
	paid := store.CardPaidForCurrentCycle(b, now)
	row := ui.Column(c).Padding(6).Radius(10).Key(scope + "-" + b.ID)
	hovered := row.Hovered()
	rowBg := ui.Transparent
	if hovered {
		rowBg = k.track
	}
	fadeColor(row, "bg", rowBg, tweenTw) // BillList 行：colors 150ms
	row.Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			billAvatar(c, b, 24)
			ui.Column(c).Grow(1).Basis(0).Children(func() {
				name := text(c, b.Name, 12, 17, 500, k.fg).SingleLine()
				if inactive {
					name.TextColor(k.muted).Strikethrough()
				}
				sub := tr(cycleLabels[max(0, slices.Index(cycleNames, b.Cycle))])
				if b.Kind == "creditCard" {
					sub = fmt.Sprintf(tr("每月 %d 日还款"), b.NextDueAt.Day())
				}
				if b.Amount != 0 {
					sub += " · " + money(cur, b.Amount)
				}
				if b.PayMethod != "" {
					sub += " · " + b.PayMethod
				}
				switch b.Status {
				case "paused":
					sub += " · " + tr("已暂停")
				case "canceled":
					sub += " · " + tr("已取消")
				}
				text(c, sub, 10, 14, 400, k.muted).SingleLine()
			})
			if b.Kind == "creditCard" && !inactive && !paid && a.paying != b.ID {
				chk := ui.Box(c).Size(20, 20).Radius(8).Center().Tooltip(tr("标记已还"))
				if !hovered {
					chk.Opacity(0)
				}
				chk.Children(func() { licon(c, "check", 12, k.muted) })
				if chk.Clicked() {
					a.paying, a.payAmount = b.ID, ""
					if b.Amount != 0 {
						a.payAmount = fmtAmount(b.Amount)
					}
				}
			}
			more := ui.Box(c).Size(20, 20).Radius(8).Center().Tooltip(fmt.Sprintf(tr("「%s」更多操作"), b.Name))
			if !hovered {
				more.Opacity(0)
			}
			more.Children(func() { licon(c, "ellipsis", 12, k.muted) })
			more.Menu(func(m *ui.Menu) { a.billMenu(c, m, b) })
			if inactive {
				return
			}
			if paid {
				text(c, fmt.Sprintf(tr("已还 · 下期 %d/%d"), b.NextDueAt.Month(), b.NextDueAt.Day()), 10, 14, 400, k.ok).Padding(1, 4).Radius(6).Background(k.ok.Alpha(0.1))
				return
			}
			label, tone := billDueBadge(b, now)
			badge := text(c, label, 10, 14, 400, k.muted).Padding(1, 4).Radius(6)
			switch tone {
			case "overdue":
				badge.TextColor(k.danger).Background(k.danger.Alpha(0.1))
			case "today":
				badge.TextColor(k.amberText).Background(k.amberBar.Alpha(0.15))
			}
		})
		if a.paying == b.ID {
			ui.Row(c).Margin(6, 0, 0, 32).Gap(6).AlignItems(ui.Center).Children(func() {
				text(c, tr("本期实付"), 10, 14, 400, k.muted)
				ui.Row(c).Width(80).Height(22).Padding(0, 6).Radius(8).Border(1, k.inputBorder).AlignItems(ui.Center).Children(func() {
					ui.TextInputBase(c, &a.payAmount).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).TextColor(k.fg).Focus().
						OnTextKey(func(key ui.TextKey) bool {
							switch key.Key {
							case ui.KeyEnter:
								a.payAmount = key.Text()
								a.confirmPaid(c, b, cur)
								return true
							case ui.KeyEscape:
								a.paying = ""
								return true
							}
							return false
						})
				})
				if a.iconButton(c, k, "check", 20, 12, tr("确认已还")) {
					a.confirmPaid(c, b, cur)
				}
				if a.iconButton(c, k, "x", 20, 12, tr("取消")) {
					a.paying = ""
				}
			})
		}
	})
}

func (a *app) confirmPaid(c *ui.Context, b store.Bill, cur string) {
	v, err := strconv.ParseFloat(strings.TrimSpace(a.payAmount), 64)
	if err != nil || v < 0 {
		a.showHUD("ok", tr("金额无效"))
		return
	}
	_ = a.store.MarkPaid(b.ID, v, a.now())
	a.paying = ""
	a.showHUD("ok", fmt.Sprintf(tr("「%s」本期已还 %s"), b.Name, money(cur, v)))
	a.reload()
}

func (a *app) billMenu(c *ui.Context, m *ui.Menu, b store.Bill) {
	if m.Item(tr("编辑")).Chosen() {
		a.openBillForm(&b)
	}
	set := func(status, msg string) {
		b.Status = status
		_ = a.store.UpdateBill(b)
		a.showHUD("ok", fmt.Sprintf(msg, b.Name))
		a.reload()
	}
	if b.Status == "active" {
		if m.Item(tr("暂停（不再提醒）")).Chosen() {
			set("paused", tr("已暂停「%s」"))
		}
		if m.Item(tr("标记已取消")).Chosen() {
			set("canceled", tr("已标记取消「%s」"))
		}
	} else if m.Item(tr("恢复启用")).Chosen() {
		set("active", tr("已恢复「%s」"))
	}
	m.Separator()
	if m.Item(tr("删除")).Chosen() {
		removed := b
		if a.store.DeleteBill(b.ID) {
			a.showHUDUndo("ok", fmt.Sprintf(tr("已删除「%s」"), b.Name), func() {
				_ = a.store.RestoreBill(removed)
				a.reload()
			})
		}
		a.reload()
	}
}

// billWeekStrip：7 天日期胶囊 + 到期服务图标点，选中格为主色实底。
func (a *app) billWeekStrip(c *ui.Context, k tokens, now time.Time) {
	s := stok(c)
	from := dayStart(now)
	ui.Row(c).Padding(4).Gap(4).Radius(14).Background(k.track).Children(func() {
		for i := range 7 {
			day := from.AddDate(0, 0, i)
			var due []store.Bill
			for _, b := range a.bills {
				if len(billOccurrences(b, day, day.AddDate(0, 0, 1))) > 0 {
					due = append(due, b)
				}
			}
			sel := day.Equal(a.billDay)
			cell := ui.Box(c).Grow(1).Basis(0).Height(65).Radius(10).Key(day.Format("0102"))
			wcol, dcol := k.muted, k.fg
			hoverBg := ui.Transparent
			if sel {
				wcol, dcol = gray(0.985, 0.8), gray(0.985, 1)
			} else if cell.Hovered() {
				hoverBg = k.track
			}
			fadeColor(cell, "bg", hoverBg, tweenTw) // 日格 colors 150ms
			wcol, dcol = cell.AnimateColor("w", wcol, tweenTw), cell.AnimateColor("d", dcol, tweenTw)
			cell.Children(func() {
				if sel { // 选中块是共享布局指示器（layoutId bill-week-thumb，springControl）
					ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Radius(10).Background(s.primary).PassThrough().
						Transition(ui.ElementTransition{Match: layoutID{"bill-week-thumb"}, Animation: &springControl, Position: true, Size: true})
				}
				// 日格内容绝对定位、排在滑块之后（mygo 绝对定位元素压在流内兄弟之上）
				ui.Column(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Padding(6, 2).Gap(4).AlignItems(ui.Center).Children(func() {
					text(c, tr(weekdayChars[day.Weekday()]), 10, 14, 400, wcol)
					text(c, itoa(day.Day()), 12, 17, 600, dcol)
					ui.Row(c).Height(14).Gap(2).AlignItems(ui.Center).Children(func() {
						if len(due) == 0 {
							bc := s.inputBorder
							if sel {
								bc = gray(0.985, 0.4)
							}
							ui.Box(c).Size(8, 8).Radius(4).Border(1, bc).BorderStyle(ui.BorderDashed)
							return
						}
						billAvatar(c, due[0], 14)
						if len(due) > 1 {
							text(c, "+"+itoa(len(due)-1), 10, 14, 400, wcol)
						}
					})
				})
			})
			if cell.Clicked() {
				a.billDay = day
			}
		}
	})
}

// billMonthGrid：周一起排的月历，周期色点（右上，最多两色）+ 首笔头像 + 图例与统计。
func (a *app) billMonthGrid(c *ui.Context, k tokens, now time.Time) {
	s := stok(c)
	first := time.Date(now.Year(), now.Month()+time.Month(a.billMonth), 1, 0, 0, 0, 0, now.Location())
	end := first.AddDate(0, 1, 0)
	lead := (int(first.Weekday()) + 6) % 7
	days := end.AddDate(0, 0, -1).Day()
	rows := (lead + days + 6) / 7
	gridStart := first.AddDate(0, 0, -lead)
	today := dayStart(now)
	ui.Column(c).Padding(8).Radius(14).Background(k.track).Children(func() {
		ui.Row(c).Margin(0, 0, 4, 0).Gap(4).AlignItems(ui.Center).Children(func() {
			text(c, fmt.Sprintf(tr("%d 年 %d 月"), first.Year(), first.Month()), 11, 16, 600, k.fg).Padding(0, 0, 0, 4).Grow(1)
			if a.billMonth != 0 {
				b := ui.Box(c).Padding(2, 6).Radius(8)
				b.Children(func() { text(c, tr("今天"), 10, 14, 400, k.muted) })
				if b.Clicked() {
					a.billMonth = 0
				}
			}
			if a.iconButton(c, k, "chevron-left", 18, 12, tr("上个月")) {
				a.billMonth--
			}
			if a.iconButton(c, k, "chevron-right", 18, 12, tr("下个月")) {
				a.billMonth++
			}
		})
		ui.Row(c).Gap(4).Children(func() {
			for _, w := range []int{1, 2, 3, 4, 5, 6, 0} {
				text(c, tr(weekdayChars[w]), 10, 14, 400, k.muted).Grow(1).Basis(0).Padding(2, 0).TextAlign(ui.Center)
			}
		})
		ui.Column(c).Margin(4, 0, 0, 0).Gap(4).Children(func() {
			for r := range rows {
				ui.Row(c).Gap(4).Key("r" + itoa(r)).Children(func() {
					for col := range 7 {
						day := gridStart.AddDate(0, 0, r*7+col)
						in := !day.Before(first) && day.Before(end)
						var due []store.Bill
						var cycles []string
						for _, b := range a.bills {
							if len(billOccurrences(b, day, day.AddDate(0, 0, 1))) > 0 {
								due = append(due, b)
								if !slices.Contains(cycles, b.Cycle) {
									cycles = append(cycles, b.Cycle)
								}
							}
						}
						sel := day.Equal(a.billDay)
						cell := ui.Column(c).Grow(1).Basis(0).Height(44).Padding(4, 0, 0, 0).Radius(10).AlignItems(ui.Center).Key(day.Format("0102"))
						col := k.fg
						switch {
						case sel:
							cell.Background(s.primary)
							col = gray(0.985, 1)
						case in:
							cell.Background(k.track)
						default:
							cell.Background(k.track.Alpha(0.6))
							col = k.muted.Alpha(0.7)
						}
						weight := 400
						if day.Equal(today) && !sel {
							col, weight = s.primary, 600
						}
						cell.Children(func() {
							ui.Row(c).Absolute().Top(4).Right(4).Gap(2).Children(func() {
								for _, cy := range cycles[:min(2, len(cycles))] {
									ui.Box(c).Size(6, 6).Radius(3).Background(cycleColors[cy])
								}
							})
							text(c, itoa(day.Day()), 11, 16, weight, col)
							if len(due) > 0 {
								ui.Row(c).Margin(1, 0, 0, 0).Children(func() { billAvatar(c, due[0], 14) })
							}
						})
						if cell.Clicked() {
							a.billDay = day
						}
					}
				})
			}
		})
		ui.Row(c).Margin(8, 0, 0, 0).Padding(0, 4).Gap(10).Wrap().Children(func() {
			for i, cy := range cycleNames {
				ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
					ui.Box(c).Size(6, 6).Radius(3).Background(cycleColors[cy])
					text(c, tr(cycleLabels[i]), 10, 14, 400, k.muted)
				})
			}
		})
		var active, paused, canceled, renewed, upcoming int
		for _, b := range a.bills {
			if b.Kind != "subscription" {
				continue
			}
			switch b.Status {
			case "active":
				active++
			case "paused":
				paused++
			default:
				canceled++
			}
			for _, p := range b.History {
				if !p.Period.Before(first) && p.Period.Before(end) {
					renewed++
				}
			}
			if b.Status == "active" {
				due := b.NextDueAt
				for g := 0; due.Before(end) && g < 8; g++ {
					if !due.Before(first) && !due.Before(today) {
						upcoming++
					}
					due = store.AdvanceCycle(due, b.Cycle)
				}
			}
		}
		ui.Row(c).Margin(6, 0, 0, 0).Padding(0, 4).Gap(12).Wrap().Children(func() {
			for _, st := range []struct {
				n     int
				label string
				col   ui.Color
			}{{active, "活跃", s.primary}, {paused, "已暂停", k.amberBar}, {canceled, "已取消", k.danger}, {renewed, "已续订", k.ok}, {upcoming, "即将续订", k.amberBar}} {
				ui.Row(c).Gap(3).Children(func() {
					text(c, itoa(st.n), 10, 14, 600, st.col)
					text(c, tr(st.label), 10, 14, 400, k.muted)
				})
			}
		})
	})
}

// billTrend：近 6 个月消费迷你柱（柱容器高 40，当月深色；悬停显金额）。
func (a *app) billTrend(c *ui.Context, k tokens, cur string, now time.Time) {
	trend := spendTrend(a.bills, now, 6)
	peak := 0.0
	for _, m := range trend {
		peak = max(peak, m.total)
	}
	if peak <= 0 {
		return
	}
	box := ui.Column(c).Padding(8).Radius(14).Background(k.track)
	box.Children(func() {
		text(c, tr("近 6 个月消费"), 10, 14, 400, k.muted).Padding(0, 0, 0, 4)
		ui.Row(c).Margin(4, 0, 0, 0).Padding(0, 4).Gap(6).AlignItems(ui.End).Children(func() {
			for i, m := range trend {
				current := i == len(trend)-1
				col := ui.Column(c).Grow(1).Basis(0).Gap(2).AlignItems(ui.Center).Key(fmt.Sprint(m.year, m.month))
				hov := col.Hovered()
				col.Children(func() {
					amt := text(c, money(cur, m.total), 10, 12, 400, k.muted).SingleLine()
					show := float32(0)
					if hov && m.total > 0 {
						show = 1
					}
					amt.Opacity(amt.AnimateTo("show", show, tweenTw)) // 柱顶数值 opacity 150ms
					ui.Column(c).FillWidth().Height(40).Justify(ui.End).Children(func() {
						h := max(m.total/peak*100, 2)
						if m.total > 0 {
							h = max(h, 6)
						}
						bar := k.muted.Alpha(0.3)
						if current {
							bar = k.muted.Alpha(0.7)
						}
						ui.Box(c).FillWidth().Height(float32(h * 0.4)).Radius(6).Background(bar)
					})
					lcol := k.muted
					if current {
						lcol = k.fg
					}
					text(c, fmt.Sprintf(tr("%d月"), m.month), 10, 14, 400, lcol)
				})
				if col.Clicked() {
					a.billAnalytics = true
				}
			}
		})
	})
}

// billAnalyticsCard：消费分析（近 12 个月合计、月均、按订阅拆分的年化支出）。
func (a *app) billAnalyticsCard(c *ui.Context, k tokens, cur string, now time.Time) {
	trend := spendTrend(a.bills, now, 12)
	total := 0.0
	for _, m := range trend {
		total += m.total
	}
	type share struct {
		name   string
		yearly float64
	}
	var shares []share
	for _, b := range a.bills {
		if b.Kind == "subscription" && b.Status == "active" {
			shares = append(shares, share{b.Name, store.MonthlyCost([]store.Bill{b}) * 12})
		}
	}
	slices.SortFunc(shares, func(x, y share) int {
		if x.yearly > y.yearly {
			return -1
		}
		if x.yearly < y.yearly {
			return 1
		}
		return 0
	})
	ui.Column(c).Padding(10).Gap(6).Radius(14).Background(k.card).Border(1, k.inputBorder).Children(func() {
		ui.Row(c).AlignItems(ui.Center).Children(func() {
			text(c, tr("消费分析"), 12, 17, 600, k.fg).Grow(1)
			if a.iconButton(c, k, "x", 20, 12, tr("关闭")) {
				a.billAnalytics = false
			}
		})
		text(c, fmt.Sprintf(tr("近 12 个月 %s · 月均 %s · 订阅年化 %s"), money(cur, total), money(cur, total/12), money(cur, store.MonthlyCost(a.bills)*12)), 10, 14, 400, k.muted).Wrap()
		for _, s := range shares {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Key("an-" + s.name).Children(func() {
				text(c, s.name, 11, 16, 400, k.fg).SingleLine().Width(110)
				ui.Box(c).Grow(1).Height(6).Radius(3).Background(k.track).Children(func() {
					w := float32(0)
					if len(shares) > 0 && shares[0].yearly > 0 {
						w = float32(s.yearly / shares[0].yearly)
					}
					ui.Box(c).Absolute().Left(0).Top(0).Bottom(0).WidthPercent(w * 100).Radius(3).Background(k.muted.Alpha(0.6))
				})
				text(c, money(cur, s.yearly)+tr(" / 年"), 10, 14, 400, k.muted).Width(80).TextAlign(ui.End)
			})
		}
	})
}

// ---- 添加 / 编辑 ----

type billForm struct {
	open    bool
	id      string
	kind    int // 0 订阅 1 信用卡
	name    string
	amount  string
	cycle   int
	due     string // YYYY-MM-DD；信用卡为每月几号
	method  string
	remind  []int
	err     string
	created store.Bill
}

func (a *app) openBillForm(b *store.Bill) {
	now := a.now()
	f := billForm{open: true, cycle: 1, due: now.AddDate(0, 1, 0).Format("2006-01-02"), remind: []int{1}}
	if b != nil {
		f.id, f.name, f.method, f.remind, f.created = b.ID, b.Name, b.PayMethod, slices.Clone(b.RemindDays), *b
		f.cycle = max(0, slices.Index(cycleNames, b.Cycle))
		f.due = b.NextDueAt.Format("2006-01-02")
		if b.Amount != 0 {
			f.amount = fmtAmount(b.Amount)
		}
		if b.Kind == "creditCard" {
			f.kind, f.due = 1, itoa(b.NextDueAt.Day())
		}
	}
	a.billForm = f
}

func (a *app) billEditor(c *ui.Context, k tokens) {
	s := stok(c)
	f := &a.billForm
	title := tr("添加订阅")
	if f.id != "" {
		title = tr("编辑账单")
	}
	field := func(label string, v *string, w float32, ph string) {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			text(c, label, 11, 16, 400, k.muted).Width(56)
			textField(c, k, s, v, w, ph, false)
		})
	}
	ui.Column(c).Padding(10).Gap(8).Radius(14).Background(k.card).Border(1, k.inputBorder).Children(func() {
		ui.Row(c).AlignItems(ui.Center).Children(func() {
			text(c, title, 12, 17, 600, k.fg).Grow(1)
			if a.iconButton(c, k, "x", 20, 12, tr("关闭")) {
				*f = billForm{}
			}
		})
		segmented(c, k, &f.kind, "订阅", "信用卡还款")
		field(tr("名称"), &f.name, 240, tr("如 iCloud / 招行信用卡"))
		field(tr("金额"), &f.amount, 120, tr("信用卡可留空"))
		if f.kind == 0 {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				text(c, tr("周期"), 11, 16, 400, k.muted).Width(56)
				segmented(c, k, &f.cycle, cycleLabels...)
			})
			field(tr("下次到期"), &f.due, 120, "2026-12-01")
		} else {
			field(tr("还款日"), &f.due, 64, tr("每月几号"))
		}
		field(tr("支付方式"), &f.method, 180, tr("如 支付宝 / 尾号 1234"))
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			text(c, tr("提前提醒"), 11, 16, 400, k.muted).Width(56)
			for _, d := range []int{7, 3, 1, 0} {
				on := slices.Contains(f.remind, d)
				label := fmt.Sprintf(tr("%d 天"), d)
				if d == 0 {
					label = tr("当天")
				}
				chip := ui.Box(c).Height(22).Padding(2, 8).Radius(8).Center().Key("rd" + itoa(d))
				col := k.muted
				if on {
					chip.Background(s.navSel).Border(1, s.navSelBorder)
					col = k.fg
				} else {
					chip.Background(k.track).Border(1, ui.Transparent)
				}
				chip.Children(func() { text(c, label, 10, 14, 500, col) })
				if chip.Clicked() {
					if on {
						f.remind = slices.DeleteFunc(f.remind, func(x int) bool { return x == d })
					} else {
						f.remind = append(f.remind, d)
					}
				}
			}
		})
		if f.err != "" {
			text(c, f.err, 11, 16, 400, k.danger)
		}
		ui.Row(c).Gap(6).Justify(ui.End).Children(func() {
			if button(c, s, "取消") {
				*f = billForm{}
			}
			if button(c, s, "保存") {
				a.saveBillForm()
			}
		})
	})
}

func (a *app) saveBillForm() {
	f := &a.billForm
	now := a.now()
	b := f.created
	b.Name, b.PayMethod, b.RemindDays = strings.TrimSpace(f.name), strings.TrimSpace(f.method), slices.Clone(f.remind)
	if b.Name == "" {
		f.err = tr("名称不能为空")
		return
	}
	b.Amount = 0
	if v := strings.TrimSpace(f.amount); v != "" {
		amt, err := strconv.ParseFloat(v, 64)
		if err != nil || amt < 0 {
			f.err = tr("金额无效")
			return
		}
		b.Amount = amt
	}
	if f.kind == 1 {
		day, err := strconv.Atoi(strings.TrimSpace(f.due))
		if err != nil || day < 1 || day > 31 {
			f.err = tr("还款日应为 1–31")
			return
		}
		b.Kind, b.Cycle, b.NextDueAt = "creditCard", "monthly", nextMonthlyDue(day, now)
	} else {
		due, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(f.due), time.Local)
		if err != nil {
			f.err = tr("日期格式应为 YYYY-MM-DD")
			return
		}
		if b.Amount == 0 {
			f.err = tr("订阅需要填写金额")
			return
		}
		b.Kind, b.Cycle, b.NextDueAt = "subscription", cycleNames[f.cycle], due
	}
	if f.id == "" {
		a.store.AddBill(b)
	} else {
		_ = a.store.UpdateBill(b)
	}
	*f = billForm{}
	a.reload()
}

// nextMonthlyDue：「每月 N 日还款」的下一个还款日（今天即今天；短月钳到月末）。
func nextMonthlyDue(day int, now time.Time) time.Time {
	at := func(y int, m time.Month) time.Time {
		last := time.Date(y, m+1, 0, 0, 0, 0, 0, now.Location()).Day()
		return time.Date(y, m, min(day, last), 0, 0, 0, 0, now.Location())
	}
	if t := at(now.Year(), now.Month()); !t.Before(dayStart(now)) {
		return t
	}
	return at(now.Year(), now.Month()+1)
}

// miniSegmented 是 Tauri Segmented size="xs"：槽高 22，项 18 高、10/14 字。
func miniSegmented(c *ui.Context, k tokens, value string, opts [][2]string) (string, bool) {
	picked, changed := value, false
	ui.Row(c).Height(22).Padding(2).Radius(10).Background(k.track).InsetShadow(0, 1, 2, 0, k.insetShadow).Children(func() {
		for _, o := range opts {
			sel := value == o[0]
			b := ui.Box(c).Height(18).Padding(2, 6).Radius(8).Center().Key("ms-" + o[0])
			w, col := 400, k.muted
			if sel {
				w, col = 500, k.fg
				b.Background(k.pill).Shadow(0, 1, 2, 0, k.pillShadow)
				if !k.dark {
					b.InsetShadow(0, 1, 0, 0, k.pillHighlight)
				}
			}
			b.Children(func() { text(c, tr(o[1]), 10, 14, w, col) })
			if b.Clicked() && !sel {
				picked, changed = o[0], true
			}
		}
	})
	return picked, changed
}

// smallButton 是 Tauri Button size="sm"（白底描边主键，图标 14 + 文字）。
func smallButton(c *ui.Context, k tokens, icon, label string) bool {
	s := stok(c)
	b := ui.Row(c).Height(28).Padding(0, 10).Gap(4).Radius(10).Background(s.btn).Border(1, s.btnBorder).Shadow(0, 1, 2, 0, s.btnShadow).AlignItems(ui.Center)
	b.Children(func() {
		licon(c, icon, 14, s.btnFg)
		text(c, label, 12, 17, 500, s.btnFg)
	})
	return b.Clicked()
}
