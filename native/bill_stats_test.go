package main

import (
	"math"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func TestParseRatesAndConverter(t *testing.T) {
	r, err := parseRates([]byte(`{"result":"success","rates":{"USD":1,"CNY":7.2,"EUR":0.9,"BAD":0,"NEG":-1}}`))
	if err != nil || len(r) != 3 {
		t.Fatal(r, err)
	}
	if _, err := parseRates([]byte(`{"result":"error"}`)); err == nil {
		t.Fatal("服务失败应报错")
	}
	cv := makeConverter("¥", &fxCache{Rates: r})
	if math.Abs(cv("US$")-7.2) > 1e-9 || cv("¥") != 1 || cv("自定义") != 1 {
		t.Fatal(cv("US$"), cv("¥"))
	}
	if makeConverter("₩", &fxCache{Rates: r}) != nil || makeConverter("¥", nil) != nil {
		t.Fatal("主货币不认识或没汇率返回 nil")
	}
}

func testBills(now time.Time) []store.Bill {
	lastMonth := time.Date(now.Year(), now.Month()-1, 5, 0, 0, 0, 0, time.Local)
	thisMonth := time.Date(now.Year(), now.Month(), 2, 0, 0, 0, 0, time.Local)
	return []store.Bill{
		{Kind: "subscription", Name: "Netflix", Amount: 68, Cycle: "monthly", Status: "active", Category: "entertainment",
			NextDueAt: now.AddDate(0, 1, 0), History: []store.Payment{{At: lastMonth, Amount: 68}, {At: thisMonth, Amount: 68}}},
		{Kind: "subscription", Name: "ChatGPT", Amount: 20, Currency: "US$", Cycle: "monthly", Status: "active", Category: "ai",
			NextDueAt: now.AddDate(0, 1, 0), History: []store.Payment{{At: thisMonth, Amount: 20}}},
		{Kind: "subscription", Name: "iCloud", Amount: 252, Cycle: "yearly", Status: "active", NextDueAt: now.AddDate(0, 6, 0)},
		{Kind: "creditCard", Name: "招行", Amount: 3000, Cycle: "monthly", Status: "active", NextDueAt: now.AddDate(0, 0, 3)},
	}
}

func TestBillStats(t *testing.T) {
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.Local)
	bills := testBills(now)
	if got := fmtCurTotals(monthSpendByCur(bills, now, "¥"), "¥"); got != "¥68 + US$20" {
		t.Fatal("分币种并列、主货币在前、信用卡不计：", got)
	}
	cv := conv(func(c string) float64 {
		if c == "US$" {
			return 7
		}
		return 1
	})
	if v := monthSpend(bills, now, cv); v != 68+140 {
		t.Fatal(v)
	}
	if v := prevMonthSpend(bills, now, cv); v != 68 {
		t.Fatal(v)
	}
	if v := monthlyFixed(bills, cv); v != 68+140+21 {
		t.Fatal("年付按 /12 折算", v)
	}
	cats := categoryBreakdown(bills, cv)
	if len(cats) != 3 || cats[0].category != "ai" || cats[2].category != "other" {
		t.Fatalf("降序、未填类别归 other：%+v", cats)
	}
	if y := yearTrend(bills, now, 4, nil); len(y) != 4 || y[3].year != 2026 || y[3].total != 156 {
		t.Fatalf("%+v", y)
	}
	if d := distinctCurrencies(bills, "¥"); len(d) != 2 {
		t.Fatal(d)
	}
}

func TestBillAnalyticsSheet(t *testing.T) {
	a, tt := testApp(t)
	st := a.store.Settings()
	st.SubscriptionsEnabled = true
	_ = a.store.SetSettings(st)
	for _, b := range testBills(a.now()) {
		a.store.AddBill(b)
	}
	a.reload()
	a.switchPage(pageTasks)
	a.taskSub = 2
	tt.SetSize(380, 900)
	a.fxLoaded = true // 不读磁盘缓存
	a.billAnalytics = true
	tt.Frame()
	for _, s := range []string{"消费分析", "本月消费", "月固定支出", "年度累计", "活跃订阅", "汇率未就绪，按币种分列", "消费趋势", "多币种混计", "按类别", "娱乐", "AI", "其他"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q：%v", s, tt.Texts())
		}
	}
	a.fx = &fxCache{FetchedAt: time.Now(), Rates: map[string]float64{"USD": 1, "CNY": 7}}
	tt.Frame()
	found := false
	for _, s := range tt.Texts() {
		if len(s) > 2 && s[:3] == "≈" {
			found = true
		}
	}
	if !found || !tt.HasText("已折算 ¥") {
		t.Fatalf("有汇率应折算：%v", tt.Texts())
	}
	if err := tt.Click("年度"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.billRange != "year" {
		t.Fatal(a.billRange)
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.billAnalytics {
		t.Fatal("Esc 关闭")
	}
}

func TestBillFlowEsc(t *testing.T) {
	a, tt := testApp(t)
	a.openBillForm(nil)
	tt.Frame()
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.billForm.open {
		t.Fatal("Esc 关闭添加订阅对话框")
	}
}
