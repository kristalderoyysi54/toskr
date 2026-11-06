package main

import (
	"fmt"
	"math"
	"time"

	"github.com/egoist/mygo/ui"
)

// 消费分析（同 Tauri BillAnalytics）：盖住面板的对话框——指标卡 2×2（本月 + 环比 / 月固定支出 / 年度累计 / 活跃订阅）、
// 消费趋势（月度近 12 个月 / 年度近 4 年）、按类别环形图 + 图例；多币种有汇率时折算主货币（≈），否则分列。

// categoryColors 同 Tauri CATEGORY_COLORS（数据调色板）。
var categoryColors = map[string]ui.Color{ // token-exception: 数据调色板，非样式 token
	"entertainment": hexColor("#ef4444"), "music": hexColor("#ec4899"), "productivity": hexColor("#22c55e"),
	"dev": hexColor("#3b82f6"), "ai": hexColor("#8b5cf6"), "cloud": hexColor("#14b8a6"), "other": hexColor("#94a3b8"),
}

func categoryColor(cat string) ui.Color {
	if c, ok := categoryColors[cat]; ok {
		return c
	}
	return categoryColors["other"]
}

func categoryName(cat string) string {
	if l, ok := catalogCategoryLabel[cat]; ok && cat != "creditCard" {
		return tr(l)
	}
	return tr("其他")
}

func (a *app) billAnalyticsSheet(c *ui.Context, k tokens, cur string, now time.Time) {
	if !a.billAnalytics {
		return
	}
	if c.Shortcut(0, ui.KeyEscape) {
		a.billAnalytics = false
		return
	}
	s := stok(c)
	w, h := c.Size()
	cv, converted := a.billConv(cur)
	if !converted {
		cv = nil
	}
	distinct := distinctCurrencies(a.bills, cur)
	multi := len(distinct) > 1
	sym := cur
	if !converted && len(distinct) > 0 {
		sym = distinct[0]
	}
	ui.Overlay(c, func() {
		ui.Box(c).Absolute().Left(0).Top(0).Size(w, h).Background(s.bg.Alpha(0.55)).Key("bill-an-dim")
		sheet := ui.Column(c).Absolute().Left(8).Top(8).Size(w-16, h-16).Padding(12).Radius(16).Background(k.card).
			Border(1, k.floatBorder).Shadow(0, 12, 32, -8, k.floatShadowB).Shadow(0, 2, 6, 0, k.floatShadowA).Key("bill-analytics").
			Transition(ui.ElementTransition{Duration: 100 * time.Millisecond, Ease: easeCSS, Enter: &ui.Motion{Y: 8}})
		sheet.Children(func() {
			ui.Row(c).Gap(4).Padding(0, 0, 8, 0).BorderWidth(0, 0, 1, 0).BorderColor(k.inputBorder).AlignItems(ui.Center).Children(func() {
				text(c, tr("消费分析"), 13, 18, 600, k.fg).SingleLine().Grow(1)
				if a.iconButton(c, k, "x", 24, 14, tr("关闭消费分析")) {
					a.billAnalytics = false
				}
			})
			ui.Scroll(c).Grow(1).Margin(8, 0, 0, 0).Scrollbars(false).Children(func() {
				ui.Column(c).Gap(8).Padding(0, 2, 2, 2).Children(func() {
					a.billStatCards(c, k, cur, now, cv, converted, multi)
					a.billTrendSection(c, k, cur, sym, now, cv, converted, multi)
					a.billCategorySection(c, k, cur, sym, cv, converted, multi)
					if converted && a.fx != nil {
						text(c, fmt.Sprintf(tr("汇率更新于 %s · open.er-api.com · 每日缓存，折算仅供参考"), a.fx.FetchedAt.Format("1/2 15:04")), 10, 14, 400, k.muted).Wrap().Padding(0, 4)
					}
				})
			})
		})
	})
}

func statCard(c *ui.Context, k tokens, label, value, sub string, subCol ui.Color) {
	ui.Column(c).Grow(1).Basis(0).Padding(8, 10).Radius(12).Background(k.track).InsetShadow(0, 1, 2, 0, k.insetShadow).Key("sc-" + label).Children(func() {
		text(c, label, 10, 14, 400, k.muted).SingleLine()
		text(c, value, 13, 18, 600, k.fg).SingleLine().Margin(2, 0, 0, 0).Tooltip(value)
		if sub != "" {
			text(c, sub, 10, 14, 400, subCol).SingleLine().Margin(2, 0, 0, 0).Tooltip(sub)
		}
	})
}

func (a *app) billStatCards(c *ui.Context, k tokens, cur string, now time.Time, cv conv, converted, multi bool) {
	monthParts := fmtCurTotals(monthSpendByCur(a.bills, now, cur), cur)
	fixedParts := fmtCurTotals(monthlyFixedByCur(a.bills, cur), cur)
	yearParts := fmtCurTotals(yearSpendByCur(a.bills, now, cur), cur)
	monthText, fixedText, yearText := monthParts, fixedParts, yearParts
	monthTotal := monthSpend(a.bills, now, cv)
	if converted {
		monthText, fixedText, yearText = approx(cur, monthTotal), approx(cur, monthlyFixed(a.bills, cv)), approx(cur, yearSpend(a.bills, now, cv))
	}
	prev := prevMonthSpend(a.bills, now, cv)
	monthSub, monthCol := tr("上月无记账"), k.muted
	switch {
	case prev > 0 && (converted || !multi): // 环比只在同口径可比时给
		pct := (monthTotal - prev) / prev * 100
		arrow, col := "↑", k.danger
		if pct < 0 {
			arrow, col = "↓", k.ok
		}
		monthSub, monthCol = fmt.Sprintf(tr("%s 较上月 %.0f%%"), arrow, math.Abs(pct)), col
	case multi && converted:
		monthSub = monthParts
	case multi:
		monthSub = tr("汇率未就绪，按币种分列")
	}
	fixedSub, yearSub := tr("活跃订阅按周期折算"), fmt.Sprintf(tr("%d 年已记账"), now.Year())
	if multi && converted {
		fixedSub, yearSub = fixedParts, yearParts
	}
	active, total := 0, 0
	for _, b := range a.bills {
		if b.Kind == "subscription" {
			total++
			if b.Status == "active" {
				active++
			}
		}
	}
	ui.Row(c).Gap(6).Children(func() {
		statCard(c, k, tr("本月消费"), monthText, monthSub, monthCol)
		statCard(c, k, tr("月固定支出"), fixedText, fixedSub, k.muted)
	})
	ui.Row(c).Gap(6).Children(func() {
		statCard(c, k, tr("年度累计"), yearText, yearSub, k.muted)
		statCard(c, k, tr("活跃订阅"), itoa(active), fmt.Sprintf(tr("共 %d 笔订阅"), total), k.muted)
	})
}

func (a *app) billTrendSection(c *ui.Context, k tokens, cur, sym string, now time.Time, cv conv, converted, multi bool) {
	rng := cmpOr(a.billRange, "month")
	trend := spendTrend(a.bills, now, 12, cv)
	if rng == "year" {
		trend = yearTrend(a.bills, now, 4, cv)
	}
	peak := 0.0
	for _, m := range trend {
		peak = max(peak, m.total)
	}
	ui.Column(c).Padding(8).Radius(12).Background(k.track).InsetShadow(0, 1, 2, 0, k.insetShadow).Children(func() {
		ui.Row(c).Padding(0, 0, 4, 4).AlignItems(ui.Center).Children(func() {
			spans := []ui.Span{{Text: tr("消费趋势"), Color: k.fg, Weight: 600}}
			if multi {
				note := tr("多币种混计")
				if converted {
					note = fmt.Sprintf(tr("已折算 %s"), cur)
				}
				spans = append(spans, ui.Span{Text: "  " + note, Color: k.muted})
			}
			ui.RichText(c, spans...).Font(fontSans).FontSize(11).FixedLineHeight(16).Grow(1)
			if v, ok := miniSegmented(c, k, rng, [][2]string{{"month", "月度"}, {"year", "年度"}}); ok {
				a.billRange = v
			}
		})
		if peak <= 0 {
			text(c, tr("还没有记账数据；订阅到期滚动或信用卡标记已还后自动积累"), 11, 16, 400, k.muted).Padding(24, 8).TextAlign(ui.Center).FillWidth().Wrap()
			return
		}
		a.swapView(ui.Row(c), "bill-range", map[string]int{"month": 0, "year": 1}[rng]).Gap(4).Padding(0, 4).AlignItems(ui.End).Children(func() {
			for i, m := range trend {
				current := i == len(trend)-1
				showLabel := rng == "year" || (len(trend)-1-i)%2 == 0 // 12 根柱挤：从当月往回隔月显示标签
				amt := money(sym, math.Round(m.total*100)/100)
				col := ui.Column(c).Grow(1).Basis(0).Gap(2).AlignItems(ui.Center).Key("tb-" + m.label + itoa(m.year)).Tooltip(m.label + " " + amt)
				hov := col.Hovered()
				col.Children(func() {
					v := ""
					if m.total > 0 {
						v = amt
					}
					t := text(c, v, 10, 12, 400, k.muted).SingleLine()
					show := float32(0)
					if hov {
						show = 1
					}
					t.Opacity(t.AnimateTo("show", show, tweenTw))
					ui.Column(c).FillWidth().Height(80).Justify(ui.End).Children(func() {
						pct := max(m.total/peak*100, 2)
						if m.total > 0 {
							pct = max(pct, 5)
						}
						bar := k.muted.Alpha(0.3)
						if current {
							bar = k.muted.Alpha(0.7)
						}
						ui.Box(c).FillWidth().Height(float32(pct * 0.8)).Radius(3).Background(bar)
					})
					lc := k.muted
					if current {
						lc = k.fg
					}
					l := ""
					if showLabel {
						l = m.label
					}
					text(c, l, 10, 14, 400, lc).SingleLine()
				})
			}
		})
	})
}

func (a *app) billCategorySection(c *ui.Context, k tokens, cur, sym string, cv conv, converted, multi bool) {
	cats := categoryBreakdown(a.bills, cv)
	sum := 0.0
	for _, x := range cats {
		sum += x.total
	}
	ui.Column(c).Padding(8).Radius(12).Background(k.track).InsetShadow(0, 1, 2, 0, k.insetShadow).Children(func() {
		note := tr("· 月固定支出构成")
		if multi {
			if converted {
				note += fmt.Sprintf(tr("（已折算 %s）"), cur)
			} else {
				note += tr("（多币种混计）")
			}
		}
		ui.RichText(c, ui.Span{Text: tr("按类别") + " ", Color: k.fg, Weight: 600}, ui.Span{Text: note, Color: k.muted}).
			Font(fontSans).FontSize(11).FixedLineHeight(16).Padding(0, 0, 6, 4)
		if sum <= 0 {
			text(c, tr("还没有活跃订阅"), 11, 16, 400, k.muted).Padding(24, 8).TextAlign(ui.Center).FillWidth()
			return
		}
		ui.Row(c).Gap(12).Padding(0, 4, 4, 4).AlignItems(ui.Center).Children(func() {
			var stops []ui.GradientStop
			acc := 0.0
			for _, x := range cats { // 每段两个同色色标 = 硬边扇区（同 Tauri conic-gradient）
				col := categoryColor(x.category)
				stops = append(stops, ui.GradientStop{Color: col, At: float32(acc / sum)})
				acc += x.total
				stops = append(stops, ui.GradientStop{Color: col, At: float32(acc / sum)})
			}
			ui.Box(c).Size(96, 96).Radius(48).ConicGradient(ui.ConicGradient{Stops: stops}).Role(ui.RoleImage).Label(tr("类别构成环形图")).Children(func() {
				ui.Column(c).Absolute().Left(12).Top(12).Size(72, 72).Radius(36).Background(k.card).Justify(ui.Center).AlignItems(ui.Center).Children(func() {
					text(c, money(sym, math.Round(sum)), 11, 16, 600, k.fg).SingleLine()
					text(c, tr("/月"), 10, 14, 400, k.muted)
				})
			})
			ui.Column(c).Grow(1).Basis(0).Gap(4).Children(func() {
				for _, x := range cats {
					ui.Row(c).Gap(6).AlignItems(ui.Center).Key("cat-" + x.category).Children(func() {
						ui.Box(c).Size(8, 8).Radius(4).Background(categoryColor(x.category))
						text(c, categoryName(x.category), 11, 16, 400, k.fg).SingleLine().Grow(1).Basis(0)
						ui.RichText(c, ui.Span{Text: money(sym, math.Round(x.total)), Color: k.muted},
							ui.Span{Text: fmt.Sprintf(" %d%%", int(math.Round(x.total/sum*100))), Color: k.muted.Alpha(0.8)}).
							Font(fontSans).FontSize(11).FixedLineHeight(16)
					})
				}
			})
		})
	})
}
