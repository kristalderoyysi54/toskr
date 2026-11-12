package detector

import (
	"testing"
	"time"
)

var base = time.Unix(1_000, 0)

func at(ms int) time.Time { return base.Add(time.Duration(ms) * time.Millisecond) }
func down(ms int) Event   { return Event{Kind: TargetDown, At: at(ms)} }
func up(ms int) Event     { return Event{Kind: TargetUp, At: at(ms)} }

func run(d *Detector, evs ...Event) (last Outcome) {
	for _, e := range evs {
		last = d.Feed(e)
	}
	return
}

func TestDoubleTapTriggers(t *testing.T) {
	if !run(New(), down(0), up(80), down(200), up(280)).Triggered {
		t.Fatal("双击应触发")
	}
}

func TestSlowSecondReleaseStillWithinHold(t *testing.T) {
	if !run(New(), down(0), up(100), down(250), up(800)).Triggered {
		t.Fatal("第二击按住 550ms < 650ms 应触发")
	}
}

func TestGapTimeoutRejectsAndRestarts(t *testing.T) {
	d := New()
	o := run(d, down(0), up(80), down(600))
	if o.Rejected != "两击间隔超时" || o.Ms != 520 {
		t.Fatalf("got %+v", o)
	}
	// 超时那一击作为新的第一击
	if !run(d, up(650), down(700), up(760)).Triggered {
		t.Fatal("超时后重新计为第一击，应能再触发")
	}
}

func TestOtherKeyDuringTapRejects(t *testing.T) {
	d := New()
	if o := run(d, down(0), Event{Kind: Other}, up(80)); o.Rejected != "第一击夹杂其他按键" {
		t.Fatalf("got %+v", o)
	}
	if o := run(d, down(100), up(150), down(200), Event{Kind: Other}, up(260)); o.Rejected != "第二击夹杂其他按键" {
		t.Fatalf("got %+v", o)
	}
}

func TestShiftWithOtherModifierRejects(t *testing.T) {
	o := run(New(), Event{Kind: TargetDown, At: at(0), OtherMods: true}, up(80))
	if o.Rejected != "第一击夹杂其他按键" {
		t.Fatalf("got %+v", o)
	}
}

func TestLongHoldRejects(t *testing.T) {
	if o := run(New(), down(0), up(700)); o.Rejected != "第一击按住过长" {
		t.Fatalf("got %+v", o)
	}
	if o := run(New(), down(0), up(80), down(200), up(900)); o.Rejected != "第二击按住过长" {
		t.Fatalf("got %+v", o)
	}
}

func TestTypingBetweenTapsCancels(t *testing.T) {
	if run(New(), down(0), up(80), Event{Kind: Other}, down(200), up(260)).Triggered {
		t.Fatal("两击之间打字应作废")
	}
}

func TestConfigurableGap(t *testing.T) {
	d := New()
	d.ReleaseGap = 200 * time.Millisecond
	if o := run(d, down(0), up(80), down(350)); o.Rejected != "两击间隔超时" {
		t.Fatalf("got %+v", o)
	}
}
