package store

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// Tauri 的「最近发送」是明文 JSONL 事件流（activity.rs：toskr-delivery-activity.jsonl 与归档 .1.jsonl），
// 同一 deliveryId 多条事件；这里折叠成原生的一轮 Delivery（只保留发出 / 失败 / 拦截过的轮次）。
type tauriActivityEvent struct {
	DeliveryID     string   `json:"deliveryId"`
	EventType      string   `json:"eventType"`
	TimestampMs    int64    `json:"timestampMs"`
	SourceItemIDs  []string `json:"sourceItemIds"`
	TargetBundleID *string  `json:"targetBundleId"`
	TargetAppName  *string  `json:"targetAppName"`
	ProfileID      string   `json:"profileId"`
	ReasonCode     *string  `json:"reasonCode"`
	TextCharCount  int      `json:"textCharCount"`
	ImageCount     int      `json:"imageCount"`
	RedactionCount int      `json:"redactionCount"`
	ResultNoteID   *string  `json:"resultNoteId"`
}

func readTauriActivity(dir string, profiles []TargetProfile) []Delivery {
	byID := map[string]*Delivery{}
	var order []string
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	for _, name := range []string{"toskr-delivery-activity.1.jsonl", "toskr-delivery-activity.jsonl"} { // 归档在前，时间顺序
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 4<<20)
		for sc.Scan() {
			var e tauriActivityEvent
			if json.Unmarshal(sc.Bytes(), &e) != nil || e.DeliveryID == "" {
				continue
			}
			d := byID[e.DeliveryID]
			if d == nil {
				d = &Delivery{ID: e.DeliveryID}
				byID[e.DeliveryID] = d
				order = append(order, e.DeliveryID)
			}
			if v := str(e.TargetAppName); v != "" {
				d.TargetName = v
			}
			if v := str(e.TargetBundleID); v != "" {
				d.TargetBundle = v
			}
			if len(e.SourceItemIDs) > 0 {
				d.SourceIDs = e.SourceItemIDs
			}
			if e.ProfileID != "" {
				d.Profile = e.ProfileID
				if i := slices.IndexFunc(profiles, func(p TargetProfile) bool { return p.ID == e.ProfileID }); i >= 0 {
					d.Profile = profiles[i].Name
				}
			}
			if v := str(e.ResultNoteID); v != "" {
				d.ResultNoteID = v
			}
			status := ""
			switch e.EventType {
			case "sendSent":
				status = "sent"
			case "sendFailed":
				status = "failed"
			case "sendBlocked", "firewallBlocked":
				status = "blocked"
			}
			if status != "" {
				d.Status, d.At = status, time.UnixMilli(e.TimestampMs)
				d.TextChars, d.ImageCount, d.Redactions = e.TextCharCount, e.ImageCount, e.RedactionCount
				if status != "sent" {
					d.Err = str(e.ReasonCode)
				}
			}
		}
		f.Close()
	}
	var out []Delivery
	for _, id := range order {
		if d := byID[id]; d.Status != "" {
			out = append(out, *d)
		}
	}
	return out
}

// mergeDeliveries：按 ID 合并（已有的不覆盖），按时间倒序，保留 200 轮。返回新增数。
func mergeDeliveries(dst *[]Delivery, in []Delivery) int {
	n := 0
	for _, d := range in {
		if !slices.ContainsFunc(*dst, func(x Delivery) bool { return x.ID == d.ID }) {
			*dst = append(*dst, d)
			n++
		}
	}
	slices.SortStableFunc(*dst, func(a, b Delivery) int { return b.At.Compare(a.At) })
	*dst = (*dst)[:min(len(*dst), deliveryKeep)]
	return n
}
