package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/toskr/native/internal/store"
)

// 回复里的占位符恢复（同 Tauri resultReturn rememberDeliveryRedactionMap / previewRestoredPlaceholders）：
// 发送时把「原文 → 占位符」映射只记在本次运行的内存里（最多 50 次发送），凭据类占位符只出不进、永不还原；
// 关联了这次发送的回复卡，右键「回复关联 → 恢复占位符」把占位符换回原文（可撤销）。

const maxRedactionSessions = 50

var irreversiblePH = regexp.MustCompile(`^\[(?:PRIVATE_KEY|AUTHORIZATION|API_KEY|DATABASE_URL|COOKIE|SESSION)_[0-9]{2,}\]$`)

type redactionSession struct {
	id  string
	raw map[string]string // 原文 → 占位符（仅可逆项）
}

func (a *app) rememberRedactionMap(deliveryID string, ph map[string]string) {
	m := map[string]string{}
	for raw, p := range ph {
		if raw != "" && p != "" && !irreversiblePH.MatchString(p) {
			m[raw] = p
		}
	}
	if deliveryID == "" || len(m) == 0 {
		return
	}
	a.redactions = append(a.redactions, redactionSession{deliveryID, m})
	if len(a.redactions) > maxRedactionSessions {
		a.redactions = a.redactions[len(a.redactions)-maxRedactionSessions:]
	}
}

func (a *app) redactionMap(deliveryID string) map[string]string {
	for i := len(a.redactions) - 1; i >= 0; i-- {
		if a.redactions[i].id == deliveryID {
			return a.redactions[i].raw
		}
	}
	return nil
}

// restorePlaceholders：长占位符优先替换，返回还原后的文本与次数。
func restorePlaceholders(m map[string]string, text string) (string, int) {
	type pair struct{ raw, ph string }
	var ps []pair
	for raw, ph := range m {
		ps = append(ps, pair{raw, ph})
	}
	sort.Slice(ps, func(i, j int) bool { return len(ps[i].ph) > len(ps[j].ph) })
	n := 0
	for _, p := range ps {
		if c := strings.Count(text, p.ph); c > 0 {
			n += c
			text = strings.ReplaceAll(text, p.ph, p.raw)
		}
	}
	return text, n
}

// restoreReplyPlaceholders：把回复卡里的占位符换回本次发送的原文。
func (a *app) restoreReplyPlaceholders(n store.Note) {
	if n.Provenance == nil {
		return
	}
	m := a.redactionMap(n.Provenance.DeliveryID)
	if m == nil {
		a.showHUD("info", tr("这次发送的占位符映射已不在本次运行中，无法恢复"))
		return
	}
	out, cnt := restorePlaceholders(m, n.Text)
	if cnt == 0 {
		a.showHUD("info", tr("回复里没有这次发送的占位符"))
		return
	}
	prev := n.Text
	_ = a.store.Update(n.ID, out)
	a.showHUDUndo("ok", fmt.Sprintf(tr("已恢复 %d 处占位符"), cnt), func() { _ = a.store.Update(n.ID, prev) })
}
