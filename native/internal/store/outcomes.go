package store

import (
	"slices"
	"sort"
	"strings"
	"time"
)

// 使用概览的本机事件流（同 Tauri deliveryActivityCore 的 DeliveryEvent 白名单 + outcomeIntelligence 聚合）。
// 只记次数、时间、状态、原因、发送方案与数量，不记正文、Prompt、密钥或脱敏映射。

const (
	OutcomeMaxEvents   = 500 // 同 Tauri DELIVERY_ACTIVITY_MAX_EVENTS
	outcomeDefaultDays = 30
)

// 事件类型（同 Tauri DeliveryEventType）。
const (
	OutDraft     = "draftCreated"
	OutStarted   = "sendStarted"
	OutSent      = "sendSent"
	OutBlocked   = "sendBlocked"
	OutFailed    = "sendFailed"
	OutFirewall  = "firewallBlocked"
	OutClipOK    = "clipboardRestored"
	OutClipSkip  = "clipboardSkipped"
	OutResult    = "resultCaptured"
	OutVerified  = "resultVerified"
	OutRetryNote = "retry-prepared"
)

type OutcomeEvent struct {
	DeliveryID string `json:"deliveryId"`
	Type       string `json:"eventType"`
	AtMs       int64  `json:"timestampMs"`
	Profile    string `json:"profileId,omitempty"` // 发送方案 ID
	Reason     string `json:"reasonCode,omitempty"`
	Findings   int    `json:"findings,omitempty"` // 隐私检查命中总数（Tauri firewallCounts 求和）
	Redactions int    `json:"redactionCount,omitempty"`
	Clipboard  string `json:"clipboardOutcome,omitempty"`
	Verify     string `json:"verificationStatus,omitempty"` // pass | needsReview | blocked
	Recipe     string `json:"transformRecipeId,omitempty"`
	Epoch      int    `json:"metricsEpoch,omitempty"`
}

// OutcomeRetainDays：统计保留天数（7 / 30 / 90，默认 30）。
func (st Settings) OutcomeRetainDays() int {
	switch st.OutcomeRetention {
	case 7, 30, 90:
		return st.OutcomeRetention
	}
	return outcomeDefaultDays
}

// NewDeliveryID：一次发送的 ID（发送前生成，统计事件与「最近发送」记录共用）。
func NewDeliveryID() string { return "dlv-" + newID() }

func (s *Store) Outcomes() []OutcomeEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.outcomes)
}

// RecordOutcome 记一条事件；本机使用统计关着时不记（同 Tauri metricsEligible=false 不进聚合）。
// 同一次发送的后续事件自动沿用首条事件的发送方案。
func (s *Store) RecordOutcome(e OutcomeEvent) {
	if e.DeliveryID == "" || e.Type == "" {
		return
	}
	if e.AtMs == 0 {
		e.AtMs = time.Now().UnixMilli()
	}
	_ = s.mutate(func() bool {
		if s.settings.OutcomeOff {
			return false
		}
		e.Epoch = s.settings.OutcomeEpoch
		if e.Profile == "" {
			for _, x := range s.outcomes {
				if x.DeliveryID == e.DeliveryID && x.Profile != "" {
					e.Profile = x.Profile
				}
			}
		}
		s.outcomes = append(s.outcomes, e)
		s.pruneOutcomesLocked(time.UnixMilli(e.AtMs))
		return true
	})
}

// pruneOutcomesLocked：按保留天数清理，最多留 500 条（最新）。
func (s *Store) pruneOutcomesLocked(now time.Time) {
	cut := now.AddDate(0, 0, -s.settings.OutcomeRetainDays()).UnixMilli()
	s.outcomes = slices.DeleteFunc(s.outcomes, func(e OutcomeEvent) bool { return e.AtMs < cut })
	sort.SliceStable(s.outcomes, func(i, j int) bool { return s.outcomes[i].AtMs < s.outcomes[j].AtMs })
	if n := len(s.outcomes); n > OutcomeMaxEvents {
		s.outcomes = slices.Clone(s.outcomes[n-OutcomeMaxEvents:])
	}
}

// SetOutcomeRetention 改保留天数并立即清理过期事件。
func (s *Store) SetOutcomeRetention(days int, now time.Time) {
	_ = s.mutate(func() bool {
		s.settings.OutcomeRetention = days
		s.pruneOutcomesLocked(now)
		return true
	})
}

// ClearOutcomes 清除使用统计：推进代次并丢弃事件；「最近发送」记录不动（同 Tauri outcomeMetricsEpoch + 1）。
func (s *Store) ClearOutcomes() {
	_ = s.mutate(func() bool {
		s.settings.OutcomeEpoch++
		s.outcomes = nil
		return true
	})
}

// ---- 聚合（同 Tauri aggregateOutcomeMetrics） ----

type OutcomeFilter struct {
	Range   string // 7d | 30d | all
	Now     time.Time
	Profile string // 空 = 全部
	Recipe  string
	Epoch   int
	Loc     *time.Location
}

type OutcomeDay struct {
	Day            string
	Attempts, Sent int
}

// OutcomeMetrics：时长字段 < 0 表示无数据（Tauri 的 null）。
type OutcomeMetrics struct {
	Attempts, Sent                              int
	SuccessRate                                 float64 // Attempts == 0 时无意义
	Blocked, Failed, Clipboard                  map[string]int
	TargetBlocks, Findings, Redactions, Retries int
	DraftToSend, SendToResult, Workflow         time.Duration
	Verify                                      map[string]int // pass / needsReview / blocked
	Sample                                      int
	Insufficient                                bool
	Daily                                       []OutcomeDay
	Trend                                       string // up | down | flat | ""
}

func isFinal(t string) bool {
	return t == OutFirewall || t == OutSent || t == OutBlocked || t == OutFailed
}

func isTargetBlock(r string) bool {
	if r == "" {
		return false
	}
	return strings.Contains(r, "target") || r == "draft-target-changed" || r == "target_exited" || r == "target-not-ready"
}

func dayKey(ms int64, loc *time.Location) string {
	return time.UnixMilli(ms).In(loc).Format("2006-01-02")
}

func rangeDays(f OutcomeFilter) map[string]bool {
	n := map[string]int{"7d": 7, "30d": 30}[f.Range]
	if n == 0 {
		return nil
	}
	today := f.Now.In(f.Loc)
	keys := map[string]bool{}
	for i := 0; i < n; i++ {
		keys[time.Date(today.Year(), today.Month(), today.Day()-i, 12, 0, 0, 0, f.Loc).Format("2006-01-02")] = true
	}
	return keys
}

func medianDur(v []time.Duration) time.Duration {
	if len(v) == 0 {
		return -1
	}
	s := slices.Clone(v)
	slices.Sort(s)
	m := len(s) / 2
	if len(s)%2 == 1 {
		return s[m]
	}
	return (s[m-1] + s[m]) / 2
}

func AggregateOutcomes(in []OutcomeEvent, f OutcomeFilter) OutcomeMetrics {
	if f.Loc == nil {
		f.Loc = time.Local
	}
	days := rangeDays(f)
	inRange := func(e OutcomeEvent) bool { return days == nil || days[dayKey(e.AtMs, f.Loc)] }
	nowMs := f.Now.UnixMilli()
	var events []OutcomeEvent
	for _, e := range in {
		if e.DeliveryID != "" && e.AtMs <= nowMs && e.Epoch == f.Epoch {
			events = append(events, e)
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].AtMs < events[j].AtMs })
	var finals []OutcomeEvent
	for _, e := range events {
		if isFinal(e.Type) && inRange(e) && (f.Profile == "" || e.Profile == f.Profile) && (f.Recipe == "" || e.Recipe == f.Recipe) {
			finals = append(finals, e)
		}
	}
	included := map[string]bool{}
	sentBy := map[string]OutcomeEvent{}
	m := OutcomeMetrics{Blocked: map[string]int{}, Failed: map[string]int{}, Clipboard: map[string]int{},
		Verify: map[string]int{"pass": 0, "needsReview": 0, "blocked": 0}}
	inc := func(t map[string]int, k string) {
		if k == "" {
			k = "unknown"
		}
		t[k]++
	}
	for _, e := range finals {
		included[e.DeliveryID] = true
		switch e.Type {
		case OutSent:
			sentBy[e.DeliveryID] = e
			m.Sent++
		case OutFirewall, OutBlocked:
			inc(m.Blocked, e.Reason)
			if isTargetBlock(e.Reason) {
				m.TargetBlocks++
			}
		case OutFailed:
			inc(m.Failed, e.Reason)
		}
		m.Findings += e.Findings
		m.Redactions += e.Redactions
	}
	groups := map[string][]OutcomeEvent{}
	var order []string
	for _, e := range events {
		if !included[e.DeliveryID] {
			continue
		}
		if _, ok := groups[e.DeliveryID]; !ok {
			order = append(order, e.DeliveryID)
		}
		groups[e.DeliveryID] = append(groups[e.DeliveryID], e)
		if inRange(e) && (e.Type == OutClipOK || e.Type == OutClipSkip) && e.Clipboard != "" {
			inc(m.Clipboard, e.Clipboard)
		}
	}
	var d2s, s2r, flow []time.Duration
	ms := func(a, b int64) time.Duration { return time.Duration(b-a) * time.Millisecond }
	for _, id := range order {
		g := groups[id]
		sent, hasSent := sentBy[id]
		var draft *OutcomeEvent
		if hasSent {
			for i := len(g) - 1; i >= 0; i-- {
				if g[i].Type == OutDraft && g[i].AtMs <= sent.AtMs {
					draft = &g[i]
					break
				}
			}
		} else {
			for i := range g {
				if g[i].Type == OutDraft {
					draft = &g[i]
					break
				}
			}
		}
		starts := 0
		var result *OutcomeEvent
		var verify string
		for i := range g {
			switch e := g[i]; e.Type {
			case OutStarted:
				starts++
			case OutDraft:
				if e.Reason == OutRetryNote {
					m.Retries++
				}
			case OutResult:
				if result == nil && (!hasSent || e.AtMs >= sent.AtMs) {
					result = &g[i]
				}
			case OutVerified:
				verify = e.Verify
			}
		}
		m.Retries += max(0, starts-1)
		if draft != nil && hasSent && sent.AtMs >= draft.AtMs {
			d2s = append(d2s, ms(draft.AtMs, sent.AtMs))
		}
		if hasSent && result != nil && result.AtMs >= sent.AtMs {
			s2r = append(s2r, ms(sent.AtMs, result.AtMs))
		}
		if draft != nil && result != nil && result.AtMs >= draft.AtMs {
			flow = append(flow, ms(draft.AtMs, result.AtMs))
		}
		if _, ok := m.Verify[verify]; ok {
			m.Verify[verify]++
		}
	}
	daily := map[string]*OutcomeDay{}
	for _, e := range finals {
		k := dayKey(e.AtMs, f.Loc)
		p := daily[k]
		if p == nil {
			p = &OutcomeDay{Day: k}
			daily[k] = p
		}
		p.Attempts++
		if e.Type == OutSent {
			p.Sent++
		}
	}
	for _, p := range daily {
		m.Daily = append(m.Daily, *p)
	}
	slices.SortFunc(m.Daily, func(a, b OutcomeDay) int {
		if a.Day < b.Day {
			return -1
		}
		if a.Day > b.Day {
			return 1
		}
		return 0
	})
	m.Attempts, m.Sample = len(finals), len(finals)
	if m.Attempts > 0 {
		m.SuccessRate = float64(m.Sent) / float64(m.Attempts)
	}
	m.Insufficient = m.Sample < 5
	if m.Sample >= 5 && len(m.Daily) >= 2 {
		half := len(m.Daily) / 2
		first, second := 0, 0
		for _, p := range m.Daily[:half] {
			first += p.Sent
		}
		for _, p := range m.Daily[len(m.Daily)-half:] {
			second += p.Sent
		}
		switch {
		case second == first:
			m.Trend = "flat"
		case second > first:
			m.Trend = "up"
		default:
			m.Trend = "down"
		}
	}
	m.DraftToSend, m.SendToResult, m.Workflow = medianDur(d2s), medianDur(s2r), medianDur(flow)
	return m
}
