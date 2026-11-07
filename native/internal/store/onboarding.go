package store

import (
	"encoding/json"
	"math"
	"slices"
)

// 上手演练状态机（同 Tauri src/lib/onboarding.ts）：纯函数，时间一律为毫秒时间戳。
// 字段名与 Tauri settings.onboarding 一致，可空时间用指针（JSON null）。

const (
	OnboardingVersion         = 3
	SafeRehearsalActivationMs = 60_000
	SafeRehearsalText         = "请把这段内容概括成一句话。示例邮箱 demo.user@example.com。"
	RehearsalNotStarted       = "notStarted"
	RehearsalActive           = "active"
	RehearsalPaused           = "paused"
	RehearsalSkipped          = "skipped"
	RehearsalCompleted        = "completed"
	StepPermissions           = "permissions"
	StepCapture               = "capture"
	StepTarget                = "target"
	StepFirewall              = "firewall"
	StepDelivery              = "delivery"
	StepComplete              = "complete"
)

var (
	onboardingSteps   = []string{StepPermissions, StepCapture, StepTarget, StepFirewall, StepDelivery, StepComplete}
	rehearsalStatuses = []string{RehearsalNotStarted, RehearsalActive, RehearsalPaused, RehearsalSkipped, RehearsalCompleted}
)

type OnboardingState struct {
	Captured                      bool    `json:"captured"`
	Sent                          bool    `json:"sent"`
	Done                          bool    `json:"done"`
	OnboardingVersion             int     `json:"onboardingVersion"`
	RehearsalStatus               string  `json:"rehearsalStatus"`
	RehearsalStep                 string  `json:"rehearsalStep"`
	RehearsalActive               bool    `json:"rehearsalActive"`
	RehearsalNoteID               *string `json:"rehearsalNoteId"`
	RehearsalStartedAtMs          *int64  `json:"rehearsalStartedAtMs"`
	RehearsalPausedAtMs           *int64  `json:"rehearsalPausedAtMs"`
	RehearsalCompletedAtMs        *int64  `json:"rehearsalCompletedAtMs"`
	RehearsalSkippedAtMs          *int64  `json:"rehearsalSkippedAtMs"`
	RehearsalDeferredAtMs         *int64  `json:"rehearsalDeferredAtMs"`
	PermissionsCompletedAtMs      *int64  `json:"permissionsCompletedAtMs"`
	RecoveryTutorialCompletedAtMs *int64  `json:"recoveryTutorialCompletedAtMs"`
	MergeTutorialCompletedAtMs    *int64  `json:"mergeTutorialCompletedAtMs"`
	ActivationStartedAtMs         *int64  `json:"activationStartedAtMs"`
	ActivationWithin60s           *bool   `json:"activationWithin60s"`
}

// OnboardingEvent：Type 同 Tauri OnboardingEvent.type；NoteID 只用于 sampleCaptured。
type OnboardingEvent struct {
	Type   string
	NoteID string
}

func DefaultOnboarding() OnboardingState {
	return OnboardingState{OnboardingVersion: OnboardingVersion, RehearsalStatus: RehearsalNotStarted, RehearsalStep: StepPermissions}
}

// UnmarshalJSON：读盘 / 导入时一律经迁移（v1 三布尔、v2 defer 误判完成、缺字段）。
func (o *OnboardingState) UnmarshalJSON(b []byte) error {
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		raw = nil // 非对象（null、数组）按全新处理，同 Tauri
	}
	*o = OnboardingFromPersisted(raw)
	return nil
}

// Normalized：任意来源的状态（含零值）走一遍迁移，得到 v3 规范形。
func (o OnboardingState) Normalized() OnboardingState {
	type plain OnboardingState // 去掉 UnmarshalJSON，避免递归
	b, _ := json.Marshal(plain(o))
	var raw map[string]any
	_ = json.Unmarshal(b, &raw)
	return OnboardingFromPersisted(raw)
}

func finiteTime(v any) *int64 {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return nil
	}
	n := int64(f)
	return &n
}

// OnboardingFromPersisted 同 Tauri onboardingStateFromPersisted（未知字段不保留：Go 结构体只存已知字段）。
func OnboardingFromPersisted(raw map[string]any) OnboardingState {
	str := func(k string) string { s, _ := raw[k].(string); return s }
	legacyDone, _ := raw["done"].(bool)
	legacyCaptured, _ := raw["captured"].(bool)
	legacySent, _ := raw["sent"].(bool)
	step := str("rehearsalStep")
	if !slices.Contains(onboardingSteps, step) {
		step = StepPermissions
		if legacyDone {
			step = StepComplete
		}
	}
	completedAt, skippedAt := finiteTime(raw["rehearsalCompletedAtMs"]), finiteTime(raw["rehearsalSkippedAtMs"])
	deferredAt, pausedAt := finiteTime(raw["rehearsalDeferredAtMs"]), finiteTime(raw["rehearsalPausedAtMs"])
	startedAt := finiteTime(raw["rehearsalStartedAtMs"])
	version := -1 // 非整数 = null
	if f, ok := raw["onboardingVersion"].(float64); ok && f == math.Trunc(f) {
		version = int(f)
	}
	var noteID *string
	if s := str("rehearsalNoteId"); s != "" {
		noteID = &s
	}
	hasProgress := startedAt != nil || pausedAt != nil || noteID != nil ||
		finiteTime(raw["permissionsCompletedAtMs"]) != nil || finiteTime(raw["activationStartedAtMs"]) != nil || step != StepPermissions
	// v2 的「稍后」曾被写成 done=true/step=complete：没有真实完成时间时只能算退出了演练
	v2False := version == 2 && completedAt == nil && (deferredAt != nil || legacyDone || step == StepComplete)
	explicit := str("rehearsalStatus")
	if !slices.Contains(rehearsalStatuses, explicit) {
		explicit = ""
	}
	status := RehearsalNotStarted
	switch {
	case version == OnboardingVersion && explicit != "":
		status = explicit
	case completedAt != nil || (version != 2 && legacyDone):
		status = RehearsalCompleted
	case v2False:
		status = RehearsalSkipped
	case hasProgress:
		status = RehearsalPaused
		if active, _ := raw["rehearsalActive"].(bool); active {
			status = RehearsalActive
		}
	}
	completed := status == RehearsalCompleted || completedAt != nil || (version == OnboardingVersion && legacyDone)
	out := DefaultOnboarding()
	out.Captured, out.Sent, out.Done = legacyCaptured, legacySent, completed
	out.RehearsalStatus = status
	switch {
	case status == RehearsalCompleted:
		out.RehearsalStep = StepComplete
	case v2False:
		out.RehearsalStep = StepPermissions
	default:
		out.RehearsalStep = step
	}
	out.RehearsalActive = status == RehearsalActive
	out.RehearsalNoteID = noteID
	out.RehearsalStartedAtMs, out.RehearsalPausedAtMs, out.RehearsalCompletedAtMs = startedAt, pausedAt, completedAt
	out.RehearsalSkippedAtMs = skippedAt
	if skippedAt == nil && v2False {
		out.RehearsalSkippedAtMs = deferredAt
	}
	out.RehearsalDeferredAtMs = deferredAt
	out.PermissionsCompletedAtMs = finiteTime(raw["permissionsCompletedAtMs"])
	out.RecoveryTutorialCompletedAtMs = finiteTime(raw["recoveryTutorialCompletedAtMs"])
	out.MergeTutorialCompletedAtMs = finiteTime(raw["mergeTutorialCompletedAtMs"])
	out.ActivationStartedAtMs = finiteTime(raw["activationStartedAtMs"])
	if b, ok := raw["activationWithin60s"].(bool); ok {
		out.ActivationWithin60s = &b
	}
	return out
}

func ptr[T any](v T) *T { return &v }

func orNow(p *int64, now int64) *int64 {
	if p != nil {
		return p
	}
	return &now
}

// OnboardingAfter 同 Tauri onboardingAfter：不满足前置条件的事件原样返回（已规范化）。
func OnboardingAfter(cur OnboardingState, ev OnboardingEvent, now int64) OnboardingState {
	s := cur.Normalized()
	active := s.RehearsalStatus == RehearsalActive
	hasNote := s.RehearsalNoteID != nil
	switch ev.Type {
	case "start":
		s.RehearsalStatus, s.RehearsalStep, s.RehearsalActive = RehearsalActive, StepPermissions, true
		s.RehearsalNoteID, s.RehearsalStartedAtMs = nil, ptr(now)
		s.RehearsalPausedAtMs, s.RehearsalSkippedAtMs, s.RehearsalDeferredAtMs = nil, nil, nil
		s.ActivationStartedAtMs, s.ActivationWithin60s = nil, nil
	case "resume":
		if s.RehearsalStatus == RehearsalPaused || active {
			s.RehearsalStatus, s.RehearsalActive = RehearsalActive, true
			s.RehearsalStartedAtMs = orNow(s.RehearsalStartedAtMs, now)
			s.RehearsalPausedAtMs = nil
		}
	case "pause":
		if active {
			s.RehearsalStatus, s.RehearsalActive, s.RehearsalPausedAtMs = RehearsalPaused, false, ptr(now)
		}
	case "permissionsReady":
		if active && s.RehearsalStep == StepPermissions {
			s.RehearsalStep = StepCapture
			s.PermissionsCompletedAtMs = orNow(s.PermissionsCompletedAtMs, now)
		}
	case "samplePrepared":
		if active && s.RehearsalStep == StepCapture {
			s.ActivationStartedAtMs = orNow(s.ActivationStartedAtMs, now)
		}
	case "sampleCaptured":
		if active && s.RehearsalStep == StepCapture && ev.NoteID != "" {
			s.Captured, s.RehearsalStep, s.RehearsalNoteID = true, StepTarget, ptr(ev.NoteID)
			s.ActivationStartedAtMs = orNow(s.ActivationStartedAtMs, now)
		}
	case "targetConfirmed":
		if active && s.RehearsalStep == StepTarget && hasNote {
			s.RehearsalStep = StepFirewall
		}
	case "preflightOpened":
		if active && (s.RehearsalStep == StepFirewall || s.RehearsalStep == StepDelivery) && hasNote {
			s.RehearsalStep = StepDelivery
		}
	case "deliverySent":
		if !active || s.RehearsalStep != StepDelivery || !hasNote {
			return s
		}
		s.Sent, s.Done = true, true
		s.RehearsalStatus, s.RehearsalStep, s.RehearsalActive = RehearsalCompleted, StepComplete, false
		s.RehearsalCompletedAtMs, s.RehearsalPausedAtMs = ptr(now), nil
		s.ActivationWithin60s = nil
		if st := s.ActivationStartedAtMs; st != nil {
			s.ActivationWithin60s = ptr(now-*st <= SafeRehearsalActivationMs)
		}
	case "recoveryTutorialCompleted":
		s.RecoveryTutorialCompletedAtMs = orNow(s.RecoveryTutorialCompletedAtMs, now)
	case "mergeTutorialCompleted":
		s.MergeTutorialCompletedAtMs = orNow(s.MergeTutorialCompletedAtMs, now)
	case "skip":
		if active || s.RehearsalStatus == RehearsalPaused {
			s.RehearsalStatus, s.RehearsalActive = RehearsalSkipped, false
			s.RehearsalSkippedAtMs, s.RehearsalPausedAtMs, s.ActivationWithin60s = ptr(now), nil, nil
		}
	}
	return s
}

// SafeRehearsalLaunchEvent：「继续」只恢复未完成步骤；已完成或显式重跑都从权限检查重新开始。
func SafeRehearsalLaunchEvent(cur OnboardingState, mode string) OnboardingEvent {
	s := cur.Normalized()
	if mode == "resume" && (s.RehearsalStatus == RehearsalPaused || s.RehearsalStatus == RehearsalActive) {
		return OnboardingEvent{Type: "resume"}
	}
	return OnboardingEvent{Type: "start"}
}

// PermissionRehearsalStatus 同 Tauri permissionRehearsalStatus。
func PermissionRehearsalStatus(accessibility, installed, receiving, stuck bool) string {
	switch {
	case !accessibility:
		return "accessibilityDenied"
	case !installed:
		return "tapUnavailable"
	case receiving:
		return "ready"
	case stuck:
		return "inputMonitoringBlocked"
	}
	return "waitingForEvents"
}
