package store

import (
	"slices"
	"strings"
	"time"
)

// Bill 是订阅 / 信用卡还款。语义参照 Tauri 版 lib/bills.ts。
type Bill struct {
	ID         string    `json:"id"`
	Kind       string    `json:"kind"` // subscription | creditCard
	Name       string    `json:"name"`
	Amount     float64   `json:"amount"`
	Currency   string    `json:"currency,omitempty"`
	Cycle      string    `json:"cycle"` // weekly | monthly | quarterly | semiannual | yearly
	NextDueAt  time.Time `json:"nextDueAt"`
	Status     string    `json:"status"` // active | paused | canceled
	RemindDays []int     `json:"remindDays,omitempty"`
	Reminded   []int     `json:"reminded,omitempty"` // 当前账期已提醒的档位
	PayMethod  string    `json:"payMethod,omitempty"`
	History    []Payment `json:"history,omitempty"`
	// 与 Tauri Bill 同名字段
	IconFile      string    `json:"iconFile,omitempty"`      // 媒体库里的站点图标
	FallbackColor string    `json:"fallbackColor,omitempty"` // 首字色块兜底色
	Category      string    `json:"category,omitempty"`
	Note          string    `json:"note,omitempty"`
	StartedAt     time.Time `json:"startedAt,omitzero"`
	CreatedAt     time.Time `json:"createdAt,omitzero"`
	CatalogID     string    `json:"catalogId,omitempty"`
}

type Payment struct {
	At     time.Time `json:"at"`
	Amount float64   `json:"amount"`
	Period time.Time `json:"periodDueAt,omitzero"` // 记的是哪一期（推进前的到期日）
	Manual bool      `json:"manual,omitempty"`     // 手工「标记已还」；自动续期为 false
}

// CardPaidForCurrentCycle：信用卡本期已还（有一笔手工记账，其账期推进一个周期恰为当前到期日）。
func CardPaidForCurrentCycle(b Bill, now time.Time) bool {
	if b.Kind != "creditCard" || !b.NextDueAt.After(now) {
		return false
	}
	for _, p := range b.History {
		if p.Manual && !p.Period.IsZero() && AdvanceCycle(p.Period, b.Cycle).Equal(b.NextDueAt) {
			return true
		}
	}
	return false
}

const billHistoryMax = 60

func (s *Store) Bills() []Bill { s.mu.Lock(); defer s.mu.Unlock(); return slices.Clone(s.bills) }
func (s *Store) billIndex(id string) int {
	return slices.IndexFunc(s.bills, func(b Bill) bool { return b.ID == id })
}

func (s *Store) AddBill(b Bill) Bill {
	if b.Name = strings.TrimSpace(b.Name); b.Name == "" {
		return Bill{}
	}
	b.ID = newID()
	if b.Status == "" {
		b.Status = "active"
	}
	if b.Cycle == "" || b.Kind == "creditCard" {
		b.Cycle = "monthly"
	}
	if b.RemindDays == nil {
		b.RemindDays = []int{3, 0}
	}
	if b.Kind == "subscription" && !b.StartedAt.IsZero() && len(b.History) == 0 { // 同 Tauri backfillHistoryEvents：补记开始以来的往期
		var periods []time.Time
		for due, guard := b.StartedAt, 0; due.Before(b.NextDueAt) && guard < 400; due, guard = AdvanceCycle(due, b.Cycle), guard+1 {
			periods = append(periods, due)
		}
		for _, p := range periods[max(0, len(periods)-billHistoryMax):] {
			b.History = append(b.History, Payment{At: p, Amount: b.Amount, Period: p})
		}
	}
	_ = s.mutate(func() bool { s.bills = append(s.bills, b); return true })
	return b
}

func (s *Store) UpdateBill(b Bill) error {
	return s.mutate(func() bool {
		i := s.billIndex(b.ID)
		if i < 0 {
			return false
		}
		if !s.bills[i].NextDueAt.Equal(b.NextDueAt) {
			b.Reminded = nil
		}
		s.bills[i] = b
		return true
	})
}

func (s *Store) DeleteBill(id string) bool {
	ok := false
	_ = s.mutate(func() bool {
		i := s.billIndex(id)
		if i < 0 {
			return false
		}
		s.bills, ok = slices.Delete(s.bills, i, i+1), true
		return true
	})
	return ok
}

// MarkPaid 记一笔付款并把下次到期推进一个周期；amount<=0 用账单金额。
func (s *Store) MarkPaid(id string, amount float64, at time.Time) error {
	return s.mutate(func() bool {
		i := s.billIndex(id)
		if i < 0 {
			return false
		}
		b := &s.bills[i]
		if amount <= 0 {
			amount = b.Amount
		}
		b.History = append(b.History, Payment{At: at, Amount: amount, Period: b.NextDueAt, Manual: true})
		if len(b.History) > billHistoryMax {
			b.History = b.History[len(b.History)-billHistoryMax:]
		}
		b.NextDueAt, b.Reminded = AdvanceCycle(b.NextDueAt, b.Cycle), nil
		return true
	})
}

// RollForward 把已过期的活跃订阅自动续到未来（订阅默认自动扣费，信用卡不滚动），
// 每滚一期记一笔历史付款。返回滚动的期数。
func (s *Store) RollForward(now time.Time) int {
	rolled := 0
	_ = s.mutate(func() bool {
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		for i := range s.bills {
			b := &s.bills[i]
			if b.Kind != "subscription" || b.Status != "active" {
				continue
			}
			for b.NextDueAt.Before(today) {
				b.History = append(b.History, Payment{At: b.NextDueAt, Amount: b.Amount, Period: b.NextDueAt})
				b.NextDueAt, b.Reminded = AdvanceCycle(b.NextDueAt, b.Cycle), nil
				rolled++
			}
			if len(b.History) > billHistoryMax {
				b.History = b.History[len(b.History)-billHistoryMax:]
			}
		}
		return rolled > 0
	})
	return rolled
}

// BillsToRemind 返回今天应提醒的（账单, 剩余天数），并记入已提醒档位。
func (s *Store) BillsToRemind(now time.Time) []BillReminder {
	var out []BillReminder
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	_ = s.mutate(func() bool {
		for i := range s.bills {
			b := &s.bills[i]
			if b.Status != "active" {
				continue
			}
			days := int(b.NextDueAt.Sub(today).Hours() / 24)
			for _, d := range b.RemindDays {
				if days == d && !slices.Contains(b.Reminded, d) {
					b.Reminded = append(b.Reminded, d)
					out = append(out, BillReminder{Bill: *b, Days: d})
				}
			}
		}
		return len(out) > 0
	})
	return out
}

type BillReminder struct {
	Bill Bill
	Days int
}

func AdvanceCycle(t time.Time, cycle string) time.Time {
	switch cycle {
	case "weekly":
		return t.AddDate(0, 0, 7)
	case "quarterly":
		return AddMonthsClamped(t, 3)
	case "semiannual":
		return AddMonthsClamped(t, 6)
	case "yearly":
		return AddMonthsClamped(t, 12)
	}
	return AddMonthsClamped(t, 1)
}

// MonthlyCost 把活跃订阅折算成月均支出（跨币种直接相加，与 Tauri 版一致不做汇率）。
func MonthlyCost(bills []Bill) float64 {
	total := 0.0
	for _, b := range bills {
		if b.Status != "active" || b.Kind != "subscription" {
			continue
		}
		switch b.Cycle {
		case "weekly":
			total += b.Amount * 52 / 12
		case "quarterly":
			total += b.Amount / 3
		case "semiannual":
			total += b.Amount / 6
		case "yearly":
			total += b.Amount / 12
		default:
			total += b.Amount
		}
	}
	return total
}

// SpentInMonth 统计某月实际付款总额。
func SpentInMonth(bills []Bill, y int, m time.Month) float64 {
	total := 0.0
	for _, b := range bills {
		for _, p := range b.History {
			if p.At.Year() == y && p.At.Month() == m {
				total += p.Amount
			}
		}
	}
	return total
}

// RestoreBill 撤销删除：放回列表末尾（列表按到期排序展示，位置无关）。
func (s *Store) RestoreBill(b Bill) error {
	return s.mutate(func() bool {
		if s.billIndex(b.ID) >= 0 {
			return false
		}
		s.bills = append(s.bills, b)
		return true
	})
}
