package store

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// 与 Tauri src/lib/onboarding.test.ts 逐条对应。

func persisted(t *testing.T, js string) OnboardingState {
	t.Helper()
	var o OnboardingState
	if err := json.Unmarshal([]byte(js), &o); err != nil {
		t.Fatal(err)
	}
	return o
}

func i64(p *int64) int64 {
	if p == nil {
		return -1
	}
	return *p
}

func run(s OnboardingState, steps ...any) OnboardingState {
	for i := 0; i < len(steps); i += 2 {
		ev := steps[i].(OnboardingEvent)
		s = OnboardingAfter(s, ev, int64(steps[i+1].(int)))
	}
	return s
}

var (
	evStart     = OnboardingEvent{Type: "start"}
	evReady     = OnboardingEvent{Type: "permissionsReady"}
	evCaptured  = OnboardingEvent{Type: "sampleCaptured", NoteID: "sample-note"}
	evTarget    = OnboardingEvent{Type: "targetConfirmed"}
	evPreflight = OnboardingEvent{Type: "preflightOpened"}
	evSent      = OnboardingEvent{Type: "deliverySent"}
)

func TestOnboardingMigration(t *testing.T) {
	cases := []struct {
		name, js                    string
		status, step                string
		done, captured, sent, activ bool
		noteID                      string
		skippedAt, completedAt      int64
	}{
		{"旧版已完成用户迁移后保持完成且不强制重跑", `{"captured":true,"sent":true,"done":true}`, RehearsalCompleted, StepComplete, true, true, true, false, "", -1, -1},
		{"新用户默认未开始", `null`, RehearsalNotStarted, StepPermissions, false, false, false, false, "", -1, -1},
		{"v2 defer 的错误完成态迁移为已跳过", `{"onboardingVersion":2,"captured":false,"sent":false,"done":true,"rehearsalStep":"complete","rehearsalActive":false,"rehearsalDeferredAtMs":9000,"rehearsalCompletedAtMs":null}`,
			RehearsalSkipped, StepPermissions, false, false, false, false, "", 9000, -1},
		{"v2 未完成会话迁移为暂停并保留步骤", `{"onboardingVersion":2,"done":false,"rehearsalStep":"target","rehearsalActive":false,"rehearsalStartedAtMs":1000,"rehearsalNoteId":"sample-note"}`,
			RehearsalPaused, StepTarget, false, false, false, false, "sample-note", -1, -1},
		{"非法字段按缺省处理", `{"onboardingVersion":"3","rehearsalStep":"bogus","rehearsalStartedAtMs":-5,"rehearsalNoteId":7}`, RehearsalNotStarted, StepPermissions, false, false, false, false, "", -1, -1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			o := persisted(t, c.js)
			note := ""
			if o.RehearsalNoteID != nil {
				note = *o.RehearsalNoteID
			}
			if o.OnboardingVersion != OnboardingVersion || o.RehearsalStatus != c.status || o.RehearsalStep != c.step || o.Done != c.done ||
				o.Captured != c.captured || o.Sent != c.sent || o.RehearsalActive != c.activ || note != c.noteID ||
				i64(o.RehearsalSkippedAtMs) != c.skippedAt || i64(o.RehearsalCompletedAtMs) != c.completedAt {
				t.Fatalf("%+v", o)
			}
		})
	}
}

func TestOnboardingStartOnlyWhenAsked(t *testing.T) {
	s := OnboardingAfter(DefaultOnboarding(), evStart, 500)
	if s.Done || s.RehearsalStatus != RehearsalActive || !s.RehearsalActive || i64(s.RehearsalStartedAtMs) != 500 {
		t.Fatalf("%+v", s)
	}
	// 零值（Settings 里缺字段）与默认值等价
	if !reflect.DeepEqual(OnboardingState{}.Normalized(), DefaultOnboarding()) {
		t.Fatalf("%+v", OnboardingState{}.Normalized())
	}
}

func TestOnboardingPauseResumeKeepsStep(t *testing.T) {
	captured := run(DefaultOnboarding(), evStart, 500, evReady, 1000, evCaptured, 2000)
	paused := OnboardingAfter(captured, OnboardingEvent{Type: "pause"}, 3000)
	resumed := OnboardingAfter(paused, OnboardingEvent{Type: "resume"}, 9000)
	if paused.RehearsalStep != StepTarget || paused.RehearsalStatus != RehearsalPaused || paused.RehearsalActive ||
		*paused.RehearsalNoteID != "sample-note" || i64(paused.RehearsalPausedAtMs) != 3000 {
		t.Fatalf("paused %+v", paused)
	}
	if resumed.RehearsalStep != StepTarget || resumed.RehearsalStatus != RehearsalActive || !resumed.RehearsalActive ||
		*resumed.RehearsalNoteID != "sample-note" || resumed.RehearsalPausedAtMs != nil {
		t.Fatalf("resumed %+v", resumed)
	}
}

func TestPermissionRehearsalStatus(t *testing.T) {
	for _, c := range []struct {
		ax, inst, recv, stuck bool
		want                  string
	}{
		{false, false, false, false, "accessibilityDenied"},
		{true, false, false, false, "tapUnavailable"},
		{true, true, false, false, "waitingForEvents"},
		{true, true, false, true, "inputMonitoringBlocked"},
		{true, true, true, false, "ready"},
	} {
		if got := PermissionRehearsalStatus(c.ax, c.inst, c.recv, c.stuck); got != c.want {
			t.Fatalf("%+v → %s", c, got)
		}
	}
}

func TestOnboardingActivationWithin60s(t *testing.T) {
	start := run(DefaultOnboarding(), evStart, 500, evReady, 1000)
	delivered := run(start, OnboardingEvent{Type: "samplePrepared"}, 10_000, evCaptured, 11_000, evTarget, 12_000, evPreflight, 13_000, evSent, 69_999)
	if !delivered.Done || delivered.RehearsalStatus != RehearsalCompleted || delivered.RehearsalActive || delivered.RehearsalStep != StepComplete ||
		delivered.ActivationWithin60s == nil || !*delivered.ActivationWithin60s || delivered.RecoveryTutorialCompletedAtMs != nil {
		t.Fatalf("%+v", delivered)
	}
	skipped := OnboardingAfter(start, OnboardingEvent{Type: "skip"}, 999_000)
	if skipped.Done || skipped.RehearsalStatus != RehearsalSkipped || skipped.RehearsalActive || i64(skipped.RehearsalSkippedAtMs) != 999_000 ||
		skipped.RehearsalCompletedAtMs != nil || skipped.ActivationWithin60s != nil {
		t.Fatalf("%+v", skipped)
	}
}

func TestOnboardingAchievementsSurviveRestart(t *testing.T) {
	ready := run(DefaultOnboarding(), evStart, 500, evReady, 1000)
	delivered := run(ready, evCaptured, 1100, evTarget, 1200, evPreflight, 1300, evSent, 2000)
	recovered := OnboardingAfter(delivered, OnboardingEvent{Type: "recoveryTutorialCompleted"}, 3000)
	restarted := OnboardingAfter(recovered, evStart, 4000)
	if i64(ready.PermissionsCompletedAtMs) != 1000 || delivered.RecoveryTutorialCompletedAtMs != nil || i64(recovered.RecoveryTutorialCompletedAtMs) != 3000 {
		t.Fatal("成就时间不对")
	}
	if !restarted.Done || restarted.RehearsalStatus != RehearsalActive || restarted.RehearsalStep != StepPermissions ||
		i64(restarted.RehearsalCompletedAtMs) != 2000 || i64(restarted.PermissionsCompletedAtMs) != 1000 || i64(restarted.RecoveryTutorialCompletedAtMs) != 3000 {
		t.Fatalf("%+v", restarted)
	}
	merged := OnboardingAfter(OnboardingAfter(restarted, OnboardingEvent{Type: "mergeTutorialCompleted"}, 5000), OnboardingEvent{Type: "mergeTutorialCompleted"}, 6000)
	if i64(merged.MergeTutorialCompletedAtMs) != 5000 {
		t.Fatal("合并课完成时间只记第一次")
	}
}

func TestSafeRehearsalLaunchEvent(t *testing.T) {
	captured := run(DefaultOnboarding(), evStart, 500, evReady, 750, evCaptured, 1000)
	complete := run(captured, evTarget, 1200, evPreflight, 1400, evSent, 2000)
	for _, c := range []struct {
		s    OnboardingState
		mode string
		want string
	}{{captured, "resume", "resume"}, {complete, "resume", "start"}, {captured, "start", "start"}} {
		if got := SafeRehearsalLaunchEvent(c.s, c.mode).Type; got != c.want {
			t.Fatalf("%s → %s", c.mode, got)
		}
	}
}

func TestOnboardingIgnoresMismatchedEvents(t *testing.T) {
	initial := DefaultOnboarding()
	for _, ev := range []OnboardingEvent{evReady, {Type: "sampleCaptured", NoteID: "unexpected"}, evSent, {Type: "skip"}} {
		if got := OnboardingAfter(initial, ev, 1000); !reflect.DeepEqual(got, initial) {
			t.Fatalf("%s 不应改写：%+v", ev.Type, got)
		}
	}
	active := OnboardingAfter(initial, evStart, 2000)
	if got := OnboardingAfter(active, evTarget, 3000); !reflect.DeepEqual(got, active) {
		t.Fatalf("%+v", got)
	}
	if !strings.Contains(SafeRehearsalText, "demo.user@example.com") {
		t.Fatal(SafeRehearsalText)
	}
}

func TestOnboardingJSONRoundTrip(t *testing.T) {
	s := run(DefaultOnboarding(), evStart, 500, evReady, 1000, evCaptured, 2000)
	b, _ := json.Marshal(s)
	if !strings.Contains(string(b), `"rehearsalNoteId":"sample-note"`) || !strings.Contains(string(b), `"rehearsalPausedAtMs":null`) {
		t.Fatal(string(b))
	}
	var back OnboardingState
	if err := json.Unmarshal(b, &back); err != nil || !reflect.DeepEqual(back, s) {
		t.Fatalf("%+v %v", back, err)
	}
}
