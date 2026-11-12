package store

import (
	"bytes"
	"testing"
	"time"
)

// 订阅带开始日期：补记开始以来的往期（同 Tauri backfillHistoryEvents），下一期之前每期一笔。
func TestAddBillBackfill(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), bytes.Repeat([]byte{6}, 32))
	start := time.Date(2026, 8, 6, 0, 0, 0, 0, time.Local)
	b := s.AddBill(Bill{Kind: "subscription", Name: "Netflix", Amount: 68, Cycle: "monthly", StartedAt: start, NextDueAt: time.Date(2026, 11, 6, 0, 0, 0, 0, time.Local)})
	if len(b.History) != 3 || !b.History[0].Period.Equal(start) || b.History[2].Amount != 68 {
		t.Fatalf("%+v", b.History)
	}
}
