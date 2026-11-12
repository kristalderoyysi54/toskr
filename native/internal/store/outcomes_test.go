package store

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func outAt(t time.Time, d, typ string, mod ...func(*OutcomeEvent)) OutcomeEvent {
	e := OutcomeEvent{DeliveryID: d, Type: typ, AtMs: t.UnixMilli(), Profile: "p1"}
	for _, m := range mod {
		m(&e)
	}
	return e
}

func TestAggregateOutcomes(t *testing.T) {
	loc := time.UTC
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, loc)
	d1 := now.Add(-48 * time.Hour)
	ev := []OutcomeEvent{
		outAt(d1, "a", OutDraft),
		outAt(d1.Add(10*time.Second), "a", OutStarted),
		outAt(d1.Add(20*time.Second), "a", OutSent, func(e *OutcomeEvent) { e.Findings, e.Redactions = 3, 2 }),
		outAt(d1.Add(21*time.Second), "a", OutClipOK, func(e *OutcomeEvent) { e.Clipboard = "restored" }),
		outAt(d1.Add(80*time.Second), "a", OutResult),
		outAt(d1.Add(90*time.Second), "a", OutVerified, func(e *OutcomeEvent) { e.Verify = "needsReview" }),
		outAt(now.Add(-time.Hour), "b", OutDraft),
		outAt(now.Add(-time.Hour), "b", OutStarted),
		outAt(now.Add(-time.Hour), "b", OutStarted),
		outAt(now.Add(-time.Hour+5*time.Second), "b", OutBlocked, func(e *OutcomeEvent) { e.Reason = "target-not-ready" }),
		outAt(now.Add(-time.Hour), "c", OutFailed, func(e *OutcomeEvent) { e.Reason = "paste_failed"; e.Profile = "p2" }),
		outAt(now.Add(-40*24*time.Hour), "old", OutSent),
		outAt(now.Add(-time.Hour), "gone", OutSent, func(e *OutcomeEvent) { e.Epoch = 1 }),
	}
	m := AggregateOutcomes(ev, OutcomeFilter{Range: "30d", Now: now, Loc: loc})
	if m.Attempts != 3 || m.Sent != 1 || m.Blocked["target-not-ready"] != 1 || m.Failed["paste_failed"] != 1 || m.TargetBlocks != 1 {
		t.Fatalf("计数不对 %+v", m)
	}
	if m.Findings != 3 || m.Redactions != 2 || m.Clipboard["restored"] != 1 || m.Retries != 1 || m.Verify["needsReview"] != 1 {
		t.Fatalf("明细不对 %+v", m)
	}
	if m.DraftToSend != 20*time.Second || m.SendToResult != 60*time.Second || m.Workflow != 80*time.Second {
		t.Fatalf("用时不对 %v %v %v", m.DraftToSend, m.SendToResult, m.Workflow)
	}
	if !m.Insufficient || m.Trend != "" || len(m.Daily) != 2 || m.Daily[1].Attempts != 2 {
		t.Fatalf("趋势不对 %+v", m.Daily)
	}
	if all := AggregateOutcomes(ev, OutcomeFilter{Range: "all", Now: now, Loc: loc}); all.Attempts != 4 {
		t.Fatalf("全部范围应含 40 天前的 %d", all.Attempts)
	}
	if p := AggregateOutcomes(ev, OutcomeFilter{Range: "30d", Now: now, Loc: loc, Profile: "p2"}); p.Attempts != 1 || p.Failed["paste_failed"] != 1 {
		t.Fatalf("方案筛选不对 %+v", p)
	}
	if w := AggregateOutcomes(ev, OutcomeFilter{Range: "7d", Now: now, Loc: loc}); w.DraftToSend != 20*time.Second {
		t.Fatal("7 天内应含两天前的发送")
	}
	if e := AggregateOutcomes(ev, OutcomeFilter{Range: "all", Now: now, Loc: loc, Epoch: 1}); e.Attempts != 1 {
		t.Fatal("代次过滤不对")
	}
}

func TestOutcomeTrend(t *testing.T) {
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	var ev []OutcomeEvent
	add := func(daysAgo, n int) {
		for i := 0; i < n; i++ {
			ev = append(ev, outAt(now.AddDate(0, 0, -daysAgo).Add(time.Duration(i)*time.Minute-time.Hour), "d"+itoaTest(daysAgo)+"-"+itoaTest(i), OutSent))
		}
	}
	add(3, 1)
	add(1, 4)
	m := AggregateOutcomes(ev, OutcomeFilter{Range: "7d", Now: now, Loc: time.UTC})
	if m.Insufficient || m.Trend != "up" {
		t.Fatalf("应判上升 %+v", m)
	}
}

func itoaTest(i int) string { return string(rune('0' + i)) }

func TestRecordOutcomeRespectsSwitchCapAndClear(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), bytes.Repeat([]byte{3}, 32))
	now := time.Now()
	s.RecordOutcome(OutcomeEvent{DeliveryID: "a", Type: OutDraft, AtMs: now.UnixMilli(), Profile: "p9"})
	s.RecordOutcome(OutcomeEvent{DeliveryID: "a", Type: OutSent, AtMs: now.UnixMilli()})
	if got := s.Outcomes(); len(got) != 2 || got[1].Profile != "p9" {
		t.Fatalf("后续事件应沿用方案 %+v", got)
	}
	for i := 0; i < OutcomeMaxEvents+20; i++ {
		s.RecordOutcome(OutcomeEvent{DeliveryID: "x", Type: OutSent, AtMs: now.UnixMilli() + int64(i)})
	}
	if n := len(s.Outcomes()); n != OutcomeMaxEvents {
		t.Fatalf("上限 500，得到 %d", n)
	}
	s.RecordOutcome(OutcomeEvent{DeliveryID: "old", Type: OutSent, AtMs: now.AddDate(0, 0, -31).UnixMilli()})
	for _, e := range s.Outcomes() {
		if e.DeliveryID == "old" {
			t.Fatal("超过 30 天的应被清理")
		}
	}
	s.ClearOutcomes()
	if len(s.Outcomes()) != 0 || s.Settings().OutcomeEpoch != 1 {
		t.Fatal("清除应清空并推进代次")
	}
	s.RecordOutcome(OutcomeEvent{DeliveryID: "n", Type: OutSent})
	if got := s.Outcomes(); len(got) != 1 || got[0].Epoch != 1 {
		t.Fatalf("新事件应记新代次 %+v", got)
	}
	st := s.Settings()
	st.OutcomeOff = true
	_ = s.SetSettings(st)
	s.RecordOutcome(OutcomeEvent{DeliveryID: "m", Type: OutSent})
	if len(s.Outcomes()) != 1 {
		t.Fatal("关掉统计后不应再记")
	}
}

func TestReadTauriOutcomes(t *testing.T) {
	dir := t.TempDir()
	lines := `{"deliveryId":"d1","eventType":"sendSent","timestampMs":1000,"profileId":"p","firewallCounts":{"email":2,"phone":1},"redactionCount":3,"clipboardOutcome":null,"metricsEpoch":2}
{"deliveryId":"d1","eventType":"clipboardRestored","timestampMs":1001,"profileId":"p","clipboardOutcome":"restored"}
{"deliveryId":"d2","eventType":"sendSent","timestampMs":2000,"profileId":"p","metricsEligible":false}
`
	if err := os.WriteFile(filepath.Join(dir, "toskr-delivery-activity.jsonl"), []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}
	got := readTauriOutcomes(dir)
	if len(got) != 2 || got[0].Findings != 3 || got[0].Redactions != 3 || got[0].Epoch != 2 || got[1].Clipboard != "restored" {
		t.Fatalf("%+v", got)
	}
	var dst []OutcomeEvent
	mergeOutcomes(&dst, got)
	mergeOutcomes(&dst, got)
	if len(dst) != 2 {
		t.Fatal("重复导入不应翻倍")
	}
}
