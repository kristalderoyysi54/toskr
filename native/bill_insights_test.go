package main

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func insightBills(now time.Time) []store.Bill {
	m := func(back, day int) time.Time {
		return time.Date(now.Year(), now.Month()-time.Month(back), day, 0, 0, 0, 0, time.Local)
	}
	return []store.Bill{
		{ID: "v", Kind: "subscription", Name: "视频会员", Amount: 68, Cycle: "monthly", Status: "active", Category: "entertainment", NextDueAt: now.AddDate(0, 0, 12),
			History: []store.Payment{{At: m(5, 3), Amount: 60}, {At: m(4, 3), Amount: 60}, {At: m(3, 3), Amount: 60}, {At: m(2, 3), Amount: 60}, {At: m(1, 3), Amount: 68}, {At: m(0, 3), Amount: 68}}},
		{ID: "d", Kind: "subscription", Name: "设计工具", Amount: 98, Cycle: "monthly", Status: "active", Category: "productivity", NextDueAt: now.AddDate(0, 0, 5)},
		{ID: "c", Kind: "subscription", Name: "云盘", Amount: 21, Cycle: "monthly", Status: "active", Category: "cloud", NextDueAt: now.AddDate(0, 0, 20),
			History: []store.Payment{{At: m(3, 9), Amount: 21}, {At: m(2, 9), Amount: 21}, {At: m(1, 9), Amount: 21}, {At: m(0, 9), Amount: 21}}},
		{ID: "w", Kind: "subscription", Name: "周刊", Amount: 9, Cycle: "weekly", Status: "active", NextDueAt: now.AddDate(0, 0, 2),
			History: []store.Payment{{At: m(0, 4), Amount: 9}}},
		{ID: "p", Kind: "subscription", Name: "停掉的", Amount: 30, Cycle: "monthly", Status: "paused", Category: "ai", NextDueAt: now.AddDate(0, 0, 1)},
		{ID: "k", Kind: "creditCard", Name: "招行信用卡", Amount: 3260, Cycle: "monthly", Status: "active", NextDueAt: now.AddDate(0, 0, 9),
			History: []store.Payment{{At: m(1, 5), Amount: 3000, Manual: true}}},
	}
}

func TestBillInsightStats(t *testing.T) {
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.Local)
	bills := insightBills(now)
	trend := spendTrendByCat(bills, now, 6, nil)
	if len(trend) != 6 || trend[5].total != 68+21+9 || trend[5].cats["entertainment"] != 68 || trend[5].cats["cloud"] != 21 || trend[5].cats["other"] != 9 {
		t.Fatalf("当月分桶 %+v", trend[5])
	}
	if trend[0].total != 60 || trend[4].cats["entertainment"] != 68 {
		t.Fatalf("历史分桶 %+v %+v", trend[0], trend[4])
	}
	for _, m := range trend { // 信用卡不进柱图；分段之和等于合计
		sum := 0.0
		for _, v := range m.cats {
			sum += v
		}
		if math.Abs(sum-m.total) > 1e-9 || m.total > 200 {
			t.Fatalf("%s 合计 %v 分段和 %v", m.label, m.total, sum)
		}
	}
	ch := upcomingCharges(bills, now, 30)
	weekly := 0
	for i, c := range ch {
		if c.bill.Kind != "subscription" || c.bill.Status != "active" || i > 0 && c.at.Before(ch[i-1].at) {
			t.Fatalf("只含 active 订阅且按日期升序 %+v", c)
		}
		if c.bill.ID == "w" {
			weekly++
		}
	}
	if weekly != 4 || len(ch) != 7 { // 周刊 +2 +9 +16 +23；视频 +12；设计 +5；云盘 +20
		t.Fatalf("未来 30 天 %d 笔（周刊 %d）", len(ch), weekly)
	}
	ins := billInsights(bills, now, "¥")
	if len(ins) != 2 || ins[0].kind != "first" || ins[0].bill.ID != "d" || ins[0].title != "设计工具 首次扣款还剩 5 天" ||
		ins[1].kind != "raise" || ins[1].chip != "+¥8" || ins[1].sub != "10月起 ¥60 变 ¥68" {
		t.Fatalf("%+v", ins)
	}
	// 改了金额还没扣：下一期起
	bills[2].Amount = 25
	if got := billInsights(bills[2:3], now, "¥"); len(got) != 1 || got[0].sub != "下一期起 ¥21 变 ¥25" {
		t.Fatalf("%+v", got)
	}
	// 很久以前涨的价不再提
	old := []store.Bill{{Kind: "subscription", Name: "旧", Amount: 12, Cycle: "yearly", Status: "active", NextDueAt: now.AddDate(0, 5, 0),
		History: []store.Payment{{At: now.AddDate(-2, 0, 0), Amount: 10}, {At: now.AddDate(-1, 0, 0), Amount: 12}}}}
	if got := billInsights(old, now, "¥"); len(got) != 0 {
		t.Fatalf("%+v", got)
	}
}

// 订阅页：分段柱 + 图例 + 未来 30 天 + 洞察行渲染出来；点洞察行打开该订阅的编辑。
func TestBillInsightView(t *testing.T) {
	a, _ := testApp(t)
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	a.patchSettings(func(x *store.Settings) { x.SubscriptionsEnabled, x.Currency = true, "¥" })
	for _, b := range insightBills(now) {
		a.store.RestoreBill(b)
	}
	a.reload()
	a.switchPage(pageTasks)
	a.taskSub = 2
	for _, dark := range []bool{false, true} {
		v := ui.NewTester(a.panelView, 320, 900)
		v.SetDark(dark)
		v.Frame()
		v.Frame()
		for _, s := range []string{"近 6 个月消费", "较上月 +", "折合每年", "娱乐", "云存储", "其他", "未来 30 天", "7 笔，合计 ¥223", "视频会员 涨价了", "+¥8", "设计工具 首次扣款还剩 5 天"} {
			if !v.HasText(s) {
				t.Fatalf("缺 %q %v", s, v.Texts())
			}
		}
		if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
			save(t, filepath.Join(dir, "bills-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), v.Image())
		}
		if !dark {
			if err := v.Click("视频会员 涨价了"); err != nil {
				t.Fatal(err)
			}
			if !a.billForm.open {
				t.Fatal("点洞察行应打开订阅编辑")
			}
			a.billForm.open = false
		}
	}
}
