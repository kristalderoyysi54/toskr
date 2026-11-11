package core

import (
	"slices"
	"testing"
	"time"

	"github.com/toskr/native/internal/macos"
)

type sleepRec struct {
	fake
	slept []time.Duration
}

func (s *sleepRec) Sleep(d time.Duration) { s.slept = append(s.slept, d); s.fake.Sleep(d) }

// 多段粘贴：段间等待用 Options.StepGap（设置「多段粘贴间隔」），0 回落 350ms。
func TestStepGapOption(t *testing.T) {
	for _, c := range []struct{ gap, want time.Duration }{{0, stepGap}, {time.Second, time.Second}} {
		s := &sleepRec{fake: fake{activateOK: true, count: 1}}
		p := Payload{Steps: []Step{{Text: "文字"}, {PNG: []byte("a")}, {PNG: []byte("b")}}}
		if _, err := DeliverWith(s, macos.FrontApp{PID: 42}, p, Options{StepGap: c.gap}); err != nil {
			t.Fatal(err)
		}
		WaitIdle()
		if n := len(slices.DeleteFunc(slices.Clone(s.slept), func(d time.Duration) bool { return d != c.want })); n != 2 {
			t.Fatalf("gap=%v 应在两次段间各等 %v：%v", c.gap, c.want, s.slept)
		}
	}
}

// driftFake：第一段粘贴后目标失去前台（用户切走 / 系统弹窗）。
type driftFake struct{ fake }

func (d *driftFake) PostKey(k uint16, flags uint64) {
	d.fake.PostKey(k, flags)
	if k == macos.KeyV {
		d.front = macos.FrontApp{PID: 7}
	}
}

// 同 Tauri：每段粘贴前核对目标仍在前台；中途失焦停止后续段、报失败（不能显示「已发送」），剪贴板还原。
func TestDeliverStopsOnFocusDrift(t *testing.T) {
	d := &driftFake{fake: fake{activateOK: true, items: original()}}
	p := Payload{Steps: []Step{{Text: "文字"}, {PNG: []byte("a")}}}
	_, err := DeliverWith(d, macos.FrontApp{PID: 42}, p, Options{})
	WaitIdle()
	if err != ErrFocusDrift || len(d.pasted) != 1 {
		t.Fatalf("应在第 2 段前停止 err=%v pasted=%v", err, d.pasted)
	}
	if text, _ := d.ReadString(); text != "用户原剪贴板" {
		t.Fatalf("中止后应还原剪贴板 %q", text)
	}
}

// 目标到前台后先等 180ms（同 Tauri pause(180)）再粘贴；首段是图片时再加段间等待。
func TestDeliverSettlesBeforePaste(t *testing.T) {
	s := &sleepRec{fake: fake{activateOK: true}}
	if _, err := DeliverWith(s, macos.FrontApp{PID: 42}, Payload{Steps: []Step{{PNG: []byte("a")}}}, Options{}); err != nil {
		t.Fatal(err)
	}
	WaitIdle()
	if !slices.Contains(s.slept, activateSettle) || !slices.Contains(s.slept, stepGap) {
		t.Fatalf("应先等 activateSettle 再等图片段间隔 %v", s.slept)
	}
}
