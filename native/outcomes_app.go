package main

import (
	"errors"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/store"
)

// 使用概览的事件埋点（同 Tauri preflight / executeDraft / deliveryEventsFromResult）：
// 准备发送 → 开始投递 → 结果（发出 / 受阻 / 失败）→ 剪贴板还原；回复关联与回复检查在 drawer.go / result_verify.go 记。
// 只记 ID、时间、方案、原因与数量，不碰正文。

type outcomeDraft struct {
	id, profile string
	findings    int
}

// outcomeDraftCreated：一次发送开始准备（sendT），findings 为文字隐私检查命中数。
func (a *app) outcomeDraftCreated(findings int) {
	r, _ := a.resolution()
	a.out = outcomeDraft{id: store.NewDeliveryID(), profile: r.Profile.ID, findings: findings}
	e := store.OutcomeEvent{DeliveryID: a.out.id, Type: store.OutDraft, Profile: a.out.profile}
	if a.outRetry {
		e.Reason = store.OutRetryNote
	}
	a.store.RecordOutcome(e)
}

// outcomeBlocked：还没投递就被拦下（如没有目标应用），记为一次受阻的尝试。
func (a *app) outcomeBlocked(reason string) {
	a.outcomeDraftCreated(0)
	a.store.RecordOutcome(store.OutcomeEvent{DeliveryID: a.out.id, Type: store.OutBlocked, Reason: reason})
	a.out = outcomeDraft{}
}

// outcomeStarted：开始投递；返回这次发送，之后的结果都记到它名下。
func (a *app) outcomeStarted() outcomeDraft {
	if a.out.id == "" { // 没走 sendT 的投递路径
		a.outcomeDraftCreated(0)
	}
	o := a.out
	a.store.RecordOutcome(store.OutcomeEvent{DeliveryID: o.id, Type: store.OutStarted})
	a.out = outcomeDraft{}
	return o
}

// outcomeReason：投递错误 → Tauri 的受阻 / 失败原因码。
func outcomeReason(err error) (typ, reason string) {
	switch {
	case err == nil:
		return store.OutSent, ""
	case errors.Is(err, core.ErrNoTarget), errors.Is(err, core.ErrTargetFocus):
		return store.OutBlocked, "target-not-ready"
	case errors.Is(err, core.ErrTargetExited):
		return store.OutBlocked, "target_exited"
	case errors.Is(err, core.ErrTargetChanged):
		return store.OutBlocked, "draft-target-changed"
	}
	return store.OutFailed, "paste_failed"
}

func (a *app) outcomeFinal(deliveryID string, redactions int, err error) {
	typ, reason := outcomeReason(err)
	a.store.RecordOutcome(store.OutcomeEvent{DeliveryID: deliveryID, Type: typ, Reason: reason, Profile: a.out.profile,
		Findings: a.out.findings, Redactions: redactions})
}

func (a *app) outcomeClipboard(o outcomeDraft, result string) {
	typ := store.OutClipSkip
	if result == "restored" {
		typ = store.OutClipOK
	}
	a.store.RecordOutcome(store.OutcomeEvent{DeliveryID: o.id, Type: typ, Clipboard: result})
}
