package main

import (
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func TestMarqueeOffset(t *testing.T) {
	for _, c := range []struct {
		t    time.Duration
		want float32
	}{{0, 0}, {400 * time.Millisecond, 0}, {450*time.Millisecond + 1000*time.Millisecond, 50}, {450*time.Millisecond + 2000*time.Millisecond + 100*time.Millisecond, 100}, {450*time.Millisecond + 2000*time.Millisecond + 700*time.Millisecond, 0}} {
		if got := marqueeOffset(c.t, 100); got != c.want {
			t.Fatalf("t=%v 偏移 %v，应 %v", c.t, got, c.want)
		}
	}
}

// 同 Tauri transient_peek_frame：上方放得下放上方；小图不放大（最小 240×180）；超出工作区等比缩。
func TestPeekFrame(t *testing.T) {
	wa := mygo.Rectangle{X: 0, Y: 25, Width: 1440, Height: 875}
	x, y, w, h := peekFrame(700, 600, wa, 400, 300)
	if w != 400 || h != 300 || y != 600-12-300 || x != 500 {
		t.Fatalf("上方 %v %v %v %v", x, y, w, h)
	}
	_, y, _, _ = peekFrame(700, 100, wa, 400, 300)
	if y != 124 {
		t.Fatalf("上方放不下应放下方 y=%v", y)
	}
	_, _, w, h = peekFrame(700, 600, wa, 100, 50)
	if w != 240 || h != 180 {
		t.Fatalf("最小尺寸 %v×%v", w, h)
	}
	_, _, w, h = peekFrame(700, 800, wa, 4000, 2000)
	if w > 1440*0.9+0.01 || h > 875*0.9+0.01 || w/h < 1.99 || w/h > 2.01 {
		t.Fatalf("大图应等比缩进工作区 %v×%v", w, h)
	}
}

// 紧凑行：指针移入认领悬停（驱动跑马灯），滚动把行送到静止指针下不算；溢出文字滚动。
func TestCompactRowHoverMarquee(t *testing.T) {
	long := strings.Repeat("很长的一行文字用来测试跑马灯滚动效果，", 6)
	a, tt := testApp(t, long, "第二条")
	st := a.store.Settings()
	st.CardDensity = "compact"
	_ = a.store.SetSettings(st)
	tt.Frame()
	r, ok := tt.Find(long)
	if !ok {
		t.Fatalf("找不到长行 %v", tt.Texts())
	}
	row := func() []uint8 { // 长行所在那条像素带
		img := tt.Image()
		y := int(r.Y + r.H/2)
		return append([]uint8(nil), img.Pix[y*img.Stride:(y+1)*img.Stride]...)
	}
	rest := row()
	tt.Move(r.X+20, r.Y+r.H/2)
	tt.Frame()
	n := a.store.Notes()[0]
	if a.rowHov.id != n.ID {
		t.Fatalf("指针移入应认领悬停 %q", a.rowHov.id)
	}
	before := row()
	tt.Advance(1500 * time.Millisecond)
	if string(row()) == string(before) {
		t.Fatal("悬停 1.5s 后溢出的长行应在滚动")
	}
	tt.Move(r.X+20, r.Y-200)
	tt.Frame()
	if a.rowHov.id != "" {
		t.Fatal("离行应释放")
	}
	tt.Advance(300 * time.Millisecond)
	if string(row()) != string(rest) {
		t.Fatal("离行文字应回位")
	}
}

// 悬停窥视多图：面板里 ← / → 换张（夹在首尾），不动列表选择；窥视窗显示「i / N」。
func TestPeekArrowSwitchesImage(t *testing.T) {
	a, tt := testApp(t, "甲", "乙")
	var files []string
	for i := range 3 {
		f, _ := a.store.SaveImage(whitePNG(t, 40+i, 30))
		files = append(files, f)
	}
	a.peekOn, a.peekFiles, a.peekIdx = true, files, 0
	sel := a.selected
	tt.Key(0, ui.KeyRight)
	tt.Frame()
	if a.peekIdx != 1 || a.selected != sel || a.focusList {
		t.Fatalf("→ 应换到第 2 张且不动列表 idx=%d sel=%d", a.peekIdx, a.selected)
	}
	tt.Key(0, ui.KeyLeft)
	tt.Key(0, ui.KeyLeft)
	tt.Frame()
	if a.peekIdx != 0 {
		t.Fatalf("← 夹在首张 %d", a.peekIdx)
	}
	pt := ui.NewTester(a.peekView, 300, 200)
	pt.Frame()
	if !pt.HasText("1 / 3") {
		t.Fatalf("窥视窗应显示张序 %v", pt.Texts())
	}
}
