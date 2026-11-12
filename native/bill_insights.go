package main

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 订阅页洞察（原生版新增，Tauri 只有同色迷你柱）：近 6 个月柱图按类别分段、当月常显合计、悬停读每一类；
// 「未来 30 天」扣款时间线（圆点大小 = 金额）；从记账里检出涨价与即将首次扣款。
// 只统计订阅：信用卡还款金额大一个量级，混进来会把订阅压成细线。类别配色沿用消费分析环形图的 categoryColors（同一类别全应用同色）。

// billCatOrder：分段自下而上的固定顺序（颜色跟类别走，不跟排名走）。
var billCatOrder = []string{"entertainment", "music", "productivity", "dev", "ai", "cloud", "other"}

type catBucket struct {
	monthBucket
	cats map[string]float64
}

// spendTrendByCat：近 N 个月记账，按月再按类别分桶（未填类别归 other）。
func spendTrendByCat(bills []store.Bill, now time.Time, months int, cv conv) []catBucket {
	base := spendTrend(nil, now, months, cv)
	out := make([]catBucket, months)
	for i := range out {
		out[i] = catBucket{monthBucket: base[i], cats: map[string]float64{}}
	}
	for _, b := range bills {
		if b.Kind != "subscription" {
			continue
		}
		cat := cmpOr(b.Category, "other")
		if !slices.Contains(billCatOrder, cat) {
			cat = "other"
		}
		for _, p := range b.History {
			for i := range out {
				if p.At.Year() == out[i].year && p.At.Month() == out[i].month {
					v := p.Amount * cv.rate(b.Currency)
					out[i].cats[cat] += v
					out[i].total += v
				}
			}
		}
	}
	return out
}

type billCharge struct {
	bill store.Bill
	at   time.Time
}

// upcomingCharges：未来 days 天内 active 订阅的每一次扣款，按日期升序。
func upcomingCharges(bills []store.Bill, now time.Time, days int) []billCharge {
	from := dayStart(now)
	to := from.AddDate(0, 0, days)
	var out []billCharge
	for _, b := range bills {
		if b.Kind != "subscription" || b.Status != "active" {
			continue
		}
		due := b.NextDueAt
		for g := 0; due.Before(to) && g < 8; g++ {
			if !due.Before(from) {
				out = append(out, billCharge{b, dayStart(due)})
			}
			due = store.AdvanceCycle(due, b.Cycle)
		}
	}
	slices.SortStableFunc(out, func(x, y billCharge) int { return x.at.Compare(y.at) })
	return out
}

type billInsight struct {
	bill         store.Bill
	kind         string // raise | first
	title, sub   string
	chip         string
	from, to     float64
	daysToCharge int
}

// billInsights：涨价（最近 62 天内的记账比上一笔贵，或当前金额比最近一笔记账贵）与即将首次扣款（没有记账、7 天内到期）。
func billInsights(bills []store.Bill, now time.Time, primary string) []billInsight {
	var out []billInsight
	for _, b := range bills {
		if b.Kind != "subscription" || b.Status != "active" {
			continue
		}
		cur := billCur(b, primary)
		hist := slices.Clone(b.History)
		slices.SortStableFunc(hist, func(x, y store.Payment) int { return x.At.Compare(y.At) })
		if len(hist) == 0 {
			if d := int(math.Round(dayStart(b.NextDueAt).Sub(dayStart(now)).Hours() / 24)); d >= 0 && d <= 7 {
				when := fmt.Sprintf(tr("还剩 %d 天"), d)
				if d == 0 {
					when = tr("就在今天")
				}
				out = append(out, billInsight{bill: b, kind: "first", daysToCharge: d,
					title: fmt.Sprintf(tr("%s 首次扣款%s"), b.Name, when), sub: fmt.Sprintf(tr("到期自动扣 %s"), money(cur, b.Amount))})
			}
			continue
		}
		last := hist[len(hist)-1]
		from, to, when := 0.0, 0.0, ""
		if b.Amount > last.Amount+0.005 { // 改过金额、还没扣：下一期起
			from, to, when = last.Amount, b.Amount, tr("下一期起")
		} else {
			for i := len(hist) - 1; i >= 1 && now.Sub(hist[i].At) < 62*24*time.Hour; i-- { // 最近 62 天里最后一次上调
				if hist[i].Amount > hist[i-1].Amount+0.005 {
					from, to, when = hist[i-1].Amount, hist[i].Amount, fmt.Sprintf(tr("%d月起"), hist[i].At.Month())
					break
				}
			}
		}
		if when == "" {
			continue
		}
		out = append(out, billInsight{bill: b, kind: "raise", from: from, to: to,
			title: fmt.Sprintf(tr("%s 涨价了"), b.Name), sub: fmt.Sprintf(tr("%s %s 变 %s"), when, money(cur, from), money(cur, to)),
			chip: "+" + money(cur, math.Round((to-from)*100)/100)})
	}
	slices.SortStableFunc(out, func(x, y billInsight) int { return strings.Compare(x.kind, y.kind) }) // 首次扣款在前（有时限）
	return out
}

// billTrend：近 6 个月消费（类别分段柱 + 图例 + 未来 30 天 + 洞察行）。
func (a *app) billTrend(c *ui.Context, k tokens, cur string, now time.Time) {
	cv, converted := a.billConv(cur)
	sym := cur
	if !converted {
		cv = nil
		if d := distinctCurrencies(a.bills, cur); len(d) > 0 {
			sym = d[0] // 单一币种用原币符号；汇率未就绪的多币种按主符号混计（同 Tauri BillTrendChart）
		}
	}
	amount := func(v float64) string {
		s := money(sym, math.Round(v*100)/100)
		if converted {
			s = "≈" + s
		}
		return s
	}
	trend := spendTrendByCat(a.bills, now, 6, cv)
	peak := 0.0
	present := map[string]bool{}
	for _, m := range trend {
		peak = max(peak, m.total)
		for cat, v := range m.cats {
			if v > 0 {
				present[cat] = true
			}
		}
	}
	charges := upcomingCharges(a.bills, now, 30)
	insights := billInsights(a.bills, now, cur)
	if peak <= 0 && len(charges) == 0 && len(insights) == 0 {
		return
	}
	box := ui.Column(c).Padding(10, 10, 8, 10).Gap(8).Radius(rr(14)).Background(k.track).Key("bill-trend")
	box.Children(func() {
		if peak > 0 {
			a.billTrendBars(c, k, trend, peak, present, amount)
		}
		if len(charges) > 0 {
			a.billRunway(c, k, charges, now, cv, amount)
		}
		for _, in := range insights {
			a.billInsightRow(c, k, in)
		}
	})
}

const billBarH = 56

func (a *app) billTrendBars(c *ui.Context, k tokens, trend []catBucket, peak float64, present map[string]bool, amount func(float64) string) {
	ui.Column(c).Gap(6).Children(func() {
		ui.Row(c).AlignItems(ui.Center).Gap(8).Children(func() {
			text(c, tr("近 6 个月消费"), 10, 14, 500, k.fg).Shrink(0)
			cv := cvOrNil(a, trend)
			if prev := prevMonthSpend(a.bills, a.now(), cv); prev > 0 { // 较上月：本月（含未到期投影）− 上月记账；只有上涨用琥珀
				if d := math.Round(monthSpend(a.bills, a.now(), cv) - prev); d > 0 {
					text(c, fmt.Sprintf(tr("较上月 +%s"), amount(d)), 10, 14, 500, k.amberText).Padding(0, 5).Radius(5).Background(k.amberBar.Alpha(0.15)).Shrink(0)
				} else if d < 0 {
					text(c, fmt.Sprintf(tr("较上月 −%s"), amount(-d)), 10, 14, 400, k.muted).Shrink(0)
				}
			}
			if year := monthlyFixed(a.bills, cvOrNil(a, trend)) * 12; year > 0 {
				text(c, fmt.Sprintf(tr("折合每年 %s"), amount(math.Round(year))), 10, 14, 400, k.muted).SingleLine().Grow(1).Basis(0).TextAlign(ui.End)
			}
		})
		ui.Row(c).Wrap().Gap(8).Children(func() { // 图例常在：身份不只靠颜色
			for _, cat := range billCatOrder {
				if present[cat] {
					ui.Row(c).Gap(3).AlignItems(ui.Center).Children(func() {
						ui.Box(c).Size(7, 7).Radius(2).Background(categoryColor(cat))
						text(c, categoryName(cat), 10, 14, 400, k.muted)
					})
				}
			}
		})
		ui.Row(c).Padding(0, 2).Gap(8).AlignItems(ui.End).Children(func() {
			for i, m := range trend {
				current := i == len(trend)-1
				var tip []string
				for _, cat := range billCatOrder {
					if v := m.cats[cat]; v > 0 {
						tip = append(tip, categoryName(cat)+" "+amount(v))
					}
				}
				col := ui.Column(c).Grow(1).Basis(0).Gap(2).AlignItems(ui.Center).Key(fmt.Sprint(m.year, m.month)).
					Role(ui.RoleButton).Label(m.label + " " + amount(m.total))
				if len(tip) > 0 {
					tipOf(c, col, m.label+" "+amount(m.total)+"\n"+strings.Join(tip, "\n"))
				}
				hov := col.Hovered()
				col.Children(func() {
					amt := text(c, amount(m.total), 10, 12, 500, k.fg).SingleLine()
					show := float32(0)
					if (hov || current) && m.total > 0 { // 当月常显合计，其余悬停才显
						show = 1
					}
					amt.Opacity(amt.AnimateTo("show", show, tweenTw))
					dim := float32(0.5)
					if current || hov {
						dim = 1
					}
					bar := ui.Column(c).FillWidth().Height(billBarH).Justify(ui.End).Gap(2)
					bar.Opacity(bar.AnimateTo("dim", dim, tweenTw))
					bar.Children(func() {
						if m.total <= 0 {
							ui.Box(c).FillWidth().Height(2).Radius(1).Background(k.muted.Alpha(0.3))
							return
						}
						var cats []string
						for _, cat := range billCatOrder {
							if m.cats[cat] > 0 {
								cats = append(cats, cat)
							}
						}
						full := float64(billBarH)*m.total/peak - float64(len(cats)-1)*2
						for j := len(cats) - 1; j >= 0; j-- { // 自上而下画：最上一段圆顶
							seg := ui.Box(c).FillWidth().Height(float32(max(full*m.cats[cats[j]]/m.total, 2))).Background(categoryColor(cats[j])).Key(cats[j])
							if j == len(cats)-1 {
								seg.Radius(4, 4, 0, 0)
							}
						}
					})
					lcol := k.muted
					if current {
						lcol = k.fg
					}
					text(c, m.label, 10, 14, 400, lcol)
				})
				if col.Clicked() {
					a.billAnalytics = true
				}
			}
		})
	})
}

// cvOrNil：与柱图同一折算口径（有汇率用汇率，否则按主符号混计）。
func cvOrNil(a *app, _ []catBucket) conv {
	if cv, ok := a.billConv(a.store.Settings().Currency); ok {
		return cv
	}
	return nil
}

// billRunway：未来 30 天扣款时间线——圆点位置 = 日期，大小 = 金额；两端标日期，右侧给笔数与合计。
func (a *app) billRunway(c *ui.Context, k tokens, charges []billCharge, now time.Time, cv conv, amount func(float64) string) {
	total, top := 0.0, 0.0
	for _, ch := range charges {
		v := ch.bill.Amount * cv.rate(ch.bill.Currency)
		total += v
		top = max(top, v)
	}
	from := dayStart(now)
	ui.Column(c).Gap(2).Key("bill-runway").Children(func() {
		ui.Row(c).AlignItems(ui.Center).Gap(8).Children(func() {
			text(c, tr("未来 30 天"), 10, 14, 500, k.fg).Shrink(0)
			text(c, fmt.Sprintf(tr("%d 笔，合计 %s"), len(charges), amount(total)), 10, 14, 400, k.muted).SingleLine().Grow(1).Basis(0).TextAlign(ui.End)
		})
		line := ui.Box(c).FillWidth().Height(18).Margin(0, 7)
		line.Children(func() {
			ui.Box(c).Absolute().Left(0).Right(0).Top(8.5).Height(1).Background(k.fg.Alpha(0.14))
			for i, ch := range charges {
				day := ch.at.Sub(from).Hours() / 24
				v := ch.bill.Amount * cv.rate(ch.bill.Currency)
				d := float32(6 + 8*math.Sqrt(v/top)) // 面积随金额：直径 6–14
				cat := cmpOr(ch.bill.Category, "other")
				tip := fmt.Sprintf("%s · %s · %s", monthDay(ch.at), ch.bill.Name, money(billCur(ch.bill, a.store.Settings().Currency), ch.bill.Amount))
				tipOf(c, ui.Box(c).Absolute().LeftPercent(float32(day/30*100)).Top(9-d/2).Size(d, d).Margin(0, 0, 0, -d/2).Radius(d/2).
					Background(categoryColor(cat)).Border(1.5, k.card).Key(fmt.Sprint("run-", i)).Label(tip), tip)
			}
		})
		ui.Row(c).Children(func() {
			text(c, tr("今天"), 10, 14, 400, k.muted).Grow(1).Basis(0)
			text(c, monthDay(from.AddDate(0, 0, 30)), 10, 14, 400, k.muted)
		})
	})
}

func (a *app) billInsightRow(c *ui.Context, k tokens, in billInsight) {
	row := ui.Row(c).Padding(6, 0, 0, 0).Gap(8).AlignItems(ui.Center).BorderWidth(1, 0, 0, 0).BorderColor(k.fg.Alpha(0.08)).
		Key("insight-" + in.kind + in.bill.ID).Role(ui.RoleButton).Label(in.title)
	row.Children(func() {
		billAvatar(c, in.bill, 22)
		ui.Column(c).Grow(1).Basis(0).Children(func() {
			text(c, in.title, 11, 16, 500, k.fg).SingleLine()
			text(c, in.sub, 10, 14, 400, k.muted).SingleLine()
		})
		if in.chip != "" {
			text(c, in.chip, 10, 14, 500, k.amberText).Padding(1, 5).Radius(5).Background(k.amberBar.Alpha(0.15)).Shrink(0)
		} else {
			text(c, tr("查看"), 10, 14, 400, k.muted).Underline().Shrink(0)
		}
	})
	if row.Clicked() { // 打开这条订阅的编辑（可暂停 / 取消 / 改金额）
		b := in.bill
		a.openBillForm(&b)
	}
}
