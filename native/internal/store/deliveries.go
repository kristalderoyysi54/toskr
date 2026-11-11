package store

import (
	"slices"
	"time"
)

// Delivery 是一次发送记录（同 Tauri deliveryActivity 的「一轮」：发往哪个应用、发了什么、结果与回复）。
type Delivery struct {
	ID           string    `json:"id"`
	At           time.Time `json:"at"`
	TargetName   string    `json:"targetName,omitempty"`
	TargetBundle string    `json:"targetBundle,omitempty"`
	Status       string    `json:"status"` // sent | failed | blocked
	Err          string    `json:"err,omitempty"`
	SourceIDs    []string  `json:"sourceIds,omitempty"`
	TextChars    int       `json:"textChars,omitempty"`
	ImageCount   int       `json:"imageCount,omitempty"`
	Redactions   int       `json:"redactions,omitempty"`
	Unconfirmed  bool      `json:"unconfirmed,omitempty"` // 已粘贴但输入框未变化
	ResultNoteID string    `json:"resultNoteId,omitempty"`
	Profile      string    `json:"profile,omitempty"` // 发送方案名
	Fanout       string    `json:"fanout,omitempty"`  // 多目标发送的组编号：同一组的回复可并排对比
}

// Provenance：回复笔记来自哪次发送（同 Tauri NoteProvenance，kind = deliveryResult）。
type Provenance struct {
	Kind         string   `json:"kind"`
	DeliveryID   string   `json:"deliveryId"`
	CapturedAtMs int64    `json:"capturedAtMs"`
	SourceBundle string   `json:"sourceBundle"`
	SourceIDs    []string `json:"sourceItemIds"`
}

// ResultWindow：捕获的回复与发送的最大间隔（同 Tauri RESULT_ASSOCIATION_WINDOW_MS）。
const ResultWindow = 30 * time.Minute

const deliveryKeep = 200

func (s *Store) Deliveries() []Delivery {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.deliveries)
}

// AddDelivery 记一次发送（最新在前，保留 200 轮）。
func (s *Store) AddDelivery(d Delivery) Delivery {
	if d.ID == "" {
		d.ID = "dlv-" + newID()
	}
	if d.At.IsZero() {
		d.At = time.Now()
	}
	_ = s.mutate(func() bool {
		s.deliveries = slices.Insert(s.deliveries, 0, d)
		if len(s.deliveries) > deliveryKeep {
			s.deliveries = s.deliveries[:deliveryKeep]
		}
		return true
	})
	return d
}

// DeliveryCandidates：可能以该笔记为回复的发送（成功发往笔记来源应用、发送后 30 分钟内捕获），最新在前。
func DeliveryCandidates(n Note, ds []Delivery) []Delivery {
	if n.BundleID == "" {
		return nil
	}
	var out []Delivery
	for _, d := range ds {
		gap := n.CreatedAt.Sub(d.At)
		if d.Status == "sent" && d.TargetBundle == n.BundleID && gap >= 0 && gap <= ResultWindow {
			out = append(out, d)
		}
	}
	return out
}

// ResultCandidates：某次发送可能的回复笔记（来自目标应用、发送后 30 分钟内），最早在前。
func ResultCandidates(d Delivery, notes []Note) []Note {
	if d.Status != "sent" || d.TargetBundle == "" {
		return nil
	}
	var out []Note
	for _, n := range notes {
		gap := n.CreatedAt.Sub(d.At)
		if n.BundleID == d.TargetBundle && gap >= 0 && gap <= ResultWindow {
			out = append(out, n)
		}
	}
	slices.SortFunc(out, func(x, y Note) int { return x.CreatedAt.Compare(y.CreatedAt) })
	return out
}

// LinkResult 把笔记设为该次发送的回复（替换原有回复；笔记写入 provenance）。返回原回复 ID 供撤销。
func (s *Store) LinkResult(deliveryID, noteID string) (prev string, ok bool) {
	_ = s.mutate(func() bool {
		di := slices.IndexFunc(s.deliveries, func(d Delivery) bool { return d.ID == deliveryID })
		ni := s.index(noteID)
		if di < 0 || ni < 0 {
			return false
		}
		d := &s.deliveries[di]
		prev = d.ResultNoteID
		if prev != "" && prev != noteID {
			if pi := s.index(prev); pi >= 0 && s.notes[pi].Provenance != nil && s.notes[pi].Provenance.DeliveryID == deliveryID {
				s.notes[pi].Provenance = nil
			}
		}
		d.ResultNoteID = noteID
		s.notes[ni].Provenance = &Provenance{Kind: "deliveryResult", DeliveryID: deliveryID, CapturedAtMs: s.notes[ni].CreatedAt.UnixMilli(),
			SourceBundle: d.TargetBundle, SourceIDs: slices.Clone(d.SourceIDs)}
		ok = true
		return true
	})
	return prev, ok
}

// UnlinkResult 解除回复关联。
func (s *Store) UnlinkResult(deliveryID string) {
	_ = s.mutate(func() bool {
		di := slices.IndexFunc(s.deliveries, func(d Delivery) bool { return d.ID == deliveryID })
		if di < 0 || s.deliveries[di].ResultNoteID == "" {
			return false
		}
		if ni := s.index(s.deliveries[di].ResultNoteID); ni >= 0 {
			s.notes[ni].Provenance = nil
		}
		s.deliveries[di].ResultNoteID = ""
		return true
	})
}

// ClearDeliveries 清空发送记录（回复笔记的 provenance 保留，同 Tauri 清除记录只清活动流）。
func (s *Store) ClearDeliveries() {
	_ = s.mutate(func() bool {
		if len(s.deliveries) == 0 {
			return false
		}
		s.deliveries = nil
		return true
	})
}

// RestoreDeliveries 撤销清除。
func (s *Store) RestoreDeliveries(ds []Delivery) {
	_ = s.mutate(func() bool { s.deliveries = slices.Clone(ds); return true })
}

// UnlinkNote 解除笔记的回复关联（发送记录已清除时也能清掉笔记上的溯源）。返回原发送 ID 供撤销。
func (s *Store) UnlinkNote(noteID string) (deliveryID string) {
	_ = s.mutate(func() bool {
		ni := s.index(noteID)
		if ni < 0 || s.notes[ni].Provenance == nil {
			return false
		}
		deliveryID = s.notes[ni].Provenance.DeliveryID
		s.notes[ni].Provenance = nil
		for i := range s.deliveries {
			if s.deliveries[i].ResultNoteID == noteID {
				s.deliveries[i].ResultNoteID = ""
			}
		}
		return true
	})
	return deliveryID
}
