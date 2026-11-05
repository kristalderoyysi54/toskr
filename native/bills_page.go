package main

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

var (
	cycleNames  = []string{"weekly", "monthly", "quarterly", "yearly"}
	cycleLabels = []string{"周", "月", "季", "年"}
)

type billForm struct {
	open   bool
	kind   int // 0 订阅 1 信用卡
	name   string
	amount float64
	cycle  int
	due    string // YYYY-MM-DD
	err    string
}

func (a *app) billsPage(c *ui.Context) {
	t := c.Theme()
	cur := a.store.Settings().Currency
	now := time.Now()
	summary := a.surface(c, ui.Row(c).Padding(10, 12).Gap(12).Radius(12).AlignItems(ui.Center), 0)
	summary.Children(func() {
		ui.Column(c).Gap(2).Grow(1).Children(func() {
			ui.Text(c, tr("订阅月均")).FontSize(11).TextColor(t.TextMuted)
			ui.Text(c, money(cur, store.MonthlyCost(a.bills))).Bold().FontSize(16)
		})
		ui.Column(c).Gap(2).Grow(1).Children(func() {
			ui.Text(c, tr("本月已付")).FontSize(11).TextColor(t.TextMuted)
			ui.Text(c, money(cur, store.SpentInMonth(a.bills, now.Year(), now.Month()))).Bold().FontSize(16)
		})
		if ui.Icon(c, iconPlus).FontSize(16).TextColor(t.Accent).Tooltip(tr("新增账单")).Clicked() {
			a.billForm = billForm{open: !a.billForm.open, cycle: 1, due: now.AddDate(0, 1, 0).Format("2006-01-02")}
		}
	})
	if a.billForm.open {
		a.billEditor(c)
	}
	bills := slices.Clone(a.bills)
	slices.SortStableFunc(bills, func(x, y store.Bill) int {
		if (x.Status == "active") != (y.Status == "active") {
			if x.Status == "active" {
				return -1
			}
			return 1
		}
		return x.NextDueAt.Compare(y.NextDueAt)
	})
	ui.Scroll(c).Grow(1).Children(func() {
		ui.Column(c).Gap(6).Children(func() {
			if len(bills) == 0 {
				ui.Text(c, tr("还没有账单\n记录订阅与信用卡还款，到期前提醒")).TextColor(t.TextMuted).Padding(24).Center()
			}
			for _, b := range bills {
				a.billRow(c, b, cur, now)
			}
		})
	})
}

func (a *app) billEditor(c *ui.Context) {
	t := c.Theme()
	f := &a.billForm
	a.surface(c, ui.Column(c).Padding(10, 12).Gap(8).Radius(12), 0).Children(func() {
		ui.Segmented(c, &f.kind, tr("订阅"), tr("信用卡"))
		ui.TextInput(c, &f.name).Placeholder(tr("名称，如 iCloud / 招行信用卡"))
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, tr("金额"))
			ui.NumberInput(c, &f.amount, 0, 1e7, 1).Width(110)
			if f.kind == 0 {
				ui.Segmented(c, &f.cycle, cycleLabels...)
			}
		})
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, tr("下次到期"))
			ui.TextInput(c, &f.due).Width(120).Placeholder("2026-12-01")
		})
		if f.err != "" {
			ui.Text(c, f.err).FontSize(12).TextColor(t.Danger)
		}
		ui.Row(c).Gap(6).Children(func() {
			if ui.Button(c, tr("保存")).Clicked() {
				a.saveBillForm()
			}
			if ui.Button(c, tr("取消")).Clicked() {
				f.open = false
			}
		})
	})
}

func (a *app) saveBillForm() {
	f := &a.billForm
	due, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(f.due), time.Local)
	if err != nil {
		f.err = tr("日期格式应为 YYYY-MM-DD")
		return
	}
	kind, cycle := "subscription", cycleNames[f.cycle]
	if f.kind == 1 {
		kind, cycle = "creditCard", "monthly"
	}
	if a.store.AddBill(store.Bill{Kind: kind, Name: f.name, Amount: f.amount, Cycle: cycle, NextDueAt: due}).ID == "" {
		f.err = tr("名称不能为空")
		return
	}
	*f = billForm{}
}

func (a *app) billRow(c *ui.Context, b store.Bill, cur string, now time.Time) {
	t := c.Theme()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	days := int(b.NextDueAt.Sub(today).Hours() / 24)
	row := a.surface(c, ui.Row(c).Padding(10, 12).Gap(10).Radius(10).AlignItems(ui.Center).Key(b.ID), 0.5)
	if b.Status != "active" {
		row.Opacity(0.55)
	}
	row.ContextMenu(func(m *ui.Menu) {
		if m.Item(tr("记一笔付款并推进到下期")).Chosen() {
			_ = a.store.MarkPaid(b.ID, 0, time.Now())
		}
		label := tr("暂停")
		if b.Status != "active" {
			label = tr("恢复")
		}
		if m.Item(label).Chosen() {
			if b.Status == "active" {
				b.Status = "paused"
			} else {
				b.Status = "active"
			}
			_ = a.store.UpdateBill(b)
		}
		m.Separator()
		if m.Item(tr("删除")).Chosen() {
			a.store.DeleteBill(b.ID)
		}
	})
	row.Children(func() {
		ui.Column(c).Gap(2).Grow(1).Children(func() {
			ui.Text(c, b.Name).Bold().SingleLine()
			kind := tr("订阅 · 每") + tr(cycleLabels[max(0, slices.Index(cycleNames, b.Cycle))])
			if b.Kind == "creditCard" {
				kind = tr("信用卡还款")
			}
			ui.Text(c, kind+" · "+b.NextDueAt.Format("2006-01-02")).FontSize(10).TextColor(t.TextMuted)
		})
		ui.Column(c).Gap(2).AlignItems(ui.End).Children(func() {
			ui.Text(c, money(cur, b.Amount)).Bold()
			d := ui.Text(c, daysLabel(days)).FontSize(10).TextColor(t.TextMuted)
			if b.Status == "active" && days <= 3 {
				d.TextColor(t.Warning)
			}
			if b.Status == "active" && days < 0 {
				d.TextColor(t.Danger)
			}
		})
	})
}

func daysLabel(d int) string {
	switch {
	case d < 0:
		return fmt.Sprintf(tr("逾期 %d 天"), -d)
	case d == 0:
		return tr("今天到期")
	}
	return fmt.Sprintf(tr("%d 天后"), d)
}

func money(cur string, v float64) string {
	s := strconv.FormatFloat(v, 'f', 2, 64)
	s = strings.TrimSuffix(strings.TrimSuffix(s, "00"), ".")
	return cur + s
}
