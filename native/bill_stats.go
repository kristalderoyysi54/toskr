package main

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 订阅消费统计与汇率（同 Tauri lib/bills.ts 与 lib/currency.ts）。
// 口径：趋势、本月、年度 = 真实记账（History）+ 本月剩余投影；月固定支出与类别构成 = 活跃订阅按周期折算；
// 信用卡还款波动大，不进消费汇总。conv 把某币种金额换成主货币，nil = 不折算（1:1）。

type conv func(currency string) float64

func (f conv) rate(cur string) float64 {
	if f == nil {
		return 1
	}
	return f(cur)
}

func billCur(b store.Bill, primary string) string { return cmpOr(b.Currency, primary) }

// distinctCurrencies：订阅里出现的币种（缺省币按主货币计）。
func distinctCurrencies(bills []store.Bill, primary string) []string {
	var out []string
	for _, b := range bills {
		if c := billCur(b, primary); b.Kind == "subscription" && !slices.Contains(out, c) {
			out = append(out, c)
		}
	}
	return out
}

// eachMonthSpend 把本月记账与 active 订阅本月剩余投影逐笔交给 add。
func eachMonthSpend(bills []store.Bill, now time.Time, add func(b store.Bill, amount float64)) {
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	end := start.AddDate(0, 1, 0)
	for _, b := range bills {
		if b.Kind != "subscription" {
			continue
		}
		for _, p := range b.History {
			if !p.At.Before(start) && p.At.Before(end) {
				add(b, p.Amount)
			}
		}
		if b.Status != "active" {
			continue
		}
		due := b.NextDueAt
		for g := 0; due.Before(end) && g < 8; g++ { // 周付一个月最多 5 期，8 为安全上限
			if !due.Before(start) {
				add(b, b.Amount)
			}
			due = store.AdvanceCycle(due, b.Cycle)
		}
	}
}

// monthSpend：本月已记账 + active 订阅本月剩余到期投影。
func monthSpend(bills []store.Bill, now time.Time, cv conv) float64 {
	total := 0.0
	eachMonthSpend(bills, now, func(b store.Bill, v float64) { total += v * cv.rate(b.Currency) })
	return total
}

func monthSpendByCur(bills []store.Bill, now time.Time, primary string) map[string]float64 {
	m := map[string]float64{}
	eachMonthSpend(bills, now, func(b store.Bill, v float64) { m[billCur(b, primary)] += v })
	return m
}

// historySum：订阅记账里满足 in 的合计。
func historySum(bills []store.Bill, cv conv, in func(time.Time) bool) float64 {
	total := 0.0
	for _, b := range bills {
		if b.Kind != "subscription" {
			continue
		}
		for _, p := range b.History {
			if in(p.At) {
				total += p.Amount * cv.rate(b.Currency)
			}
		}
	}
	return total
}

func prevMonthSpend(bills []store.Bill, now time.Time, cv conv) float64 {
	start := time.Date(now.Year(), now.Month()-1, 1, 0, 0, 0, 0, now.Location())
	end := start.AddDate(0, 1, 0)
	return historySum(bills, cv, func(t time.Time) bool { return !t.Before(start) && t.Before(end) })
}

func yearSpend(bills []store.Bill, now time.Time, cv conv) float64 {
	return historySum(bills, cv, func(t time.Time) bool { return t.Year() == now.Year() })
}

func yearSpendByCur(bills []store.Bill, now time.Time, primary string) map[string]float64 {
	m := map[string]float64{}
	for _, b := range bills {
		if b.Kind != "subscription" {
			continue
		}
		for _, p := range b.History {
			if p.At.Year() == now.Year() {
				m[billCur(b, primary)] += p.Amount
			}
		}
	}
	return m
}

type monthBucket struct {
	year  int
	month time.Month
	label string
	total float64
}

// spendTrend：近 N 个月记账（按月分桶）。
func spendTrend(bills []store.Bill, now time.Time, months int, cv conv) []monthBucket {
	out := make([]monthBucket, months)
	for i := range out {
		m := time.Date(now.Year(), now.Month()-time.Month(months-1-i), 1, 0, 0, 0, 0, now.Location())
		out[i] = monthBucket{year: m.Year(), month: m.Month(), label: fmt.Sprintf(tr("%d月"), m.Month())}
	}
	for _, b := range bills {
		if b.Kind != "subscription" {
			continue
		}
		for _, p := range b.History {
			for i := range out {
				if p.At.Year() == out[i].year && p.At.Month() == out[i].month {
					out[i].total += p.Amount * cv.rate(b.Currency)
				}
			}
		}
	}
	return out
}

// yearTrend：近 N 年记账（含今年，无数据年补 0）。
func yearTrend(bills []store.Bill, now time.Time, years int, cv conv) []monthBucket {
	out := make([]monthBucket, years)
	for i := range out {
		y := now.Year() - (years - 1 - i)
		out[i] = monthBucket{year: y, label: fmt.Sprint(y)}
	}
	for _, b := range bills {
		if b.Kind != "subscription" {
			continue
		}
		for _, p := range b.History {
			for i := range out {
				if p.At.Year() == out[i].year {
					out[i].total += p.Amount * cv.rate(b.Currency)
				}
			}
		}
	}
	return out
}

func monthlyEquivalent(b store.Bill) float64 { return store.MonthlyCost([]store.Bill{b}) }

func monthlyFixed(bills []store.Bill, cv conv) float64 {
	total := 0.0
	for _, b := range bills {
		total += monthlyEquivalent(b) * cv.rate(b.Currency)
	}
	return total
}

func monthlyFixedByCur(bills []store.Bill, primary string) map[string]float64 {
	m := map[string]float64{}
	for _, b := range bills {
		if v := monthlyEquivalent(b); v > 0 {
			m[billCur(b, primary)] += v
		}
	}
	return m
}

type catTotal struct {
	category string
	total    float64
}

// categoryBreakdown：活跃订阅按月折算分桶（未填类别归 other），降序。
func categoryBreakdown(bills []store.Bill, cv conv) []catTotal {
	m := map[string]float64{}
	for _, b := range bills {
		if v := monthlyEquivalent(b); v > 0 {
			m[cmpOr(b.Category, "other")] += v * cv.rate(b.Currency)
		}
	}
	var out []catTotal
	for k, v := range m {
		if v > 0 {
			out = append(out, catTotal{k, v})
		}
	}
	slices.SortFunc(out, func(x, y catTotal) int {
		if c := cmp.Compare(y.total, x.total); c != 0 {
			return c
		}
		return strings.Compare(x.category, y.category)
	})
	return out
}

// fmtCurTotals：「¥68 + US$16」，主货币在前，其余按金额降序；空集显示主货币 0。
func fmtCurTotals(m map[string]float64, primary string) string {
	type kv struct {
		cur string
		v   float64
	}
	var list []kv
	for c, v := range m {
		list = append(list, kv{c, v})
	}
	if len(list) == 0 {
		return primary + "0"
	}
	slices.SortFunc(list, func(x, y kv) int {
		switch {
		case x.cur == primary:
			return -1
		case y.cur == primary:
			return 1
		}
		return cmp.Compare(y.v, x.v)
	})
	parts := make([]string, len(list))
	for i, x := range list {
		parts[i] = money(x.cur, x.v)
	}
	return strings.Join(parts, " + ")
}

func approx(primary string, v float64) string {
	return "≈ " + money(primary, math.Round(v*100)/100)
}

// ---- 汇率（open.er-api.com，USD 基准，每日缓存；失败回退过期缓存，再退分币种分列） ----

var symbolToCode = map[string]string{"¥": "CNY", "US$": "USD", "$": "USD", "€": "EUR", "£": "GBP", "HK$": "HKD", "JP¥": "JPY"}

type fxCache struct {
	FetchedAt time.Time          `json:"fetchedAt"`
	Rates     map[string]float64 `json:"rates"` // code → 每 1 USD 兑换量
}

const fxTTL = 24 * time.Hour

var fxFetch = func() (map[string]float64, error) { // 测试替换
	cl := &http.Client{Timeout: 8 * time.Second}
	resp, err := cl.Get("https://open.er-api.com/v6/latest/USD")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	return parseRates(body)
}

func parseRates(body []byte) (map[string]float64, error) {
	var v struct {
		Result string             `json:"result"`
		Rates  map[string]float64 `json:"rates"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, fmt.Errorf(tr("汇率响应解析失败: %v"), err)
	}
	if v.Result != "success" {
		return nil, errors.New(tr("汇率服务返回失败"))
	}
	out := map[string]float64{}
	for k, r := range v.Rates {
		if r > 0 && !math.IsInf(r, 0) && !math.IsNaN(r) {
			out[k] = r
		}
	}
	if len(out) == 0 {
		return nil, errors.New(tr("汇率数据为空"))
	}
	return out, nil
}

// makeConverter：主货币代码未知或没有汇率返回 nil（调用方回退分列）；未知符号按 1:1。
func makeConverter(primary string, fx *fxCache) conv {
	if fx == nil {
		return nil
	}
	pr := fx.Rates[symbolToCode[primary]]
	if pr <= 0 {
		return nil
	}
	return func(cur string) float64 {
		if cur == "" || cur == primary {
			return 1
		}
		r := fx.Rates[symbolToCode[cur]]
		if r <= 0 {
			return 1
		}
		return pr / r
	}
}

func (a *app) fxPath() string { return filepath.Join(a.store.Dir(), "toskr-fx-rates.json") }

// ensureFx：缓存 24h 内直接用；过期在后台重抓，失败沿用过期缓存。只在真实运行的 App 里联网。
func (a *app) ensureFx() {
	if !a.fxLoaded {
		a.fxLoaded = true
		if raw, err := os.ReadFile(a.fxPath()); err == nil {
			var fx fxCache
			if json.Unmarshal(raw, &fx) == nil && len(fx.Rates) > 0 {
				a.fx = &fx
			}
		}
	}
	if !appLive || a.fxFetching || (a.fx != nil && time.Since(a.fx.FetchedAt) < fxTTL) {
		return
	}
	a.fxFetching = true
	go func() {
		rates, err := fxFetch()
		a.onMain(func() {
			a.fxFetching = false
			if err != nil {
				diag.Push("汇率抓取失败: %v", err)
				return
			}
			a.fx = &fxCache{FetchedAt: time.Now(), Rates: rates}
			if raw, err := json.Marshal(a.fx); err == nil {
				_ = os.WriteFile(a.fxPath(), raw, 0o600)
			}
		})
	}()
}

// billConv：多币种且有汇率才折算（同 Tauri：单一币种原币原值）。
func (a *app) billConv(primary string) (conv, bool) {
	a.ensureFx()
	cv := makeConverter(primary, a.fx)
	return cv, cv != nil && len(distinctCurrencies(a.bills, primary)) > 1
}
