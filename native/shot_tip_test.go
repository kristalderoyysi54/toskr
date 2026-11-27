package main

import (
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func countText(tt *ui.Tester, s string) int {
	n := 0
	for _, x := range tt.Texts() {
		if x == s {
			n++
		}
	}
	return n
}

// 截图工具条与样式行：光标停在按钮上 400ms 自动出简短说明（不靠额外事件唤醒）；
// 移走立即收起，相邻按钮热切，点过后移开再回来仍能触发。
func TestShotToolbarHoverTip(t *testing.T) {
	_, d, tt := shotTest(t)
	tt.Move(100, 80)
	tt.Frame()
	tt.Press(100, 80)
	tt.Release(101, 80)
	tt.Frame()
	r, ok := tt.Find("矩形")
	if !ok {
		t.Fatal("没有工具条")
	}
	// 光标停在按钮上不动：不能再补 tt.Frame()，必须由定时器自己唤醒（回归 fadeColor 过渡帧清掉单次 After 的缺陷）。
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	if countText(tt, "矩形") != 1 {
		t.Fatalf("刚移上去不应立刻出说明 %v", tt.Texts())
	}
	tt.Advance(450 * time.Millisecond)
	if countText(tt, "矩形") != 2 || d.ed.tip != "矩形" {
		t.Fatalf("悬停 400ms 后应自动出说明 tip=%q texts=%v", d.ed.tip, tt.Texts())
	}

	// 热切：紧接着滑到相邻图标，不必再等 400ms。
	r2, ok := tt.Find("椭圆")
	if !ok {
		t.Fatal("没有椭圆按钮")
	}
	tt.Move(r2.X+r2.W/2, r2.Y+r2.H/2)
	tt.Frame()
	if countText(tt, "椭圆") != 2 || d.ed.tip != "椭圆" {
		t.Fatalf("相邻按钮应热切出说明 tip=%q texts=%v", d.ed.tip, tt.Texts())
	}

	// 移走光标：说明立即收起。
	tt.Move(10, 10)
	tt.Frame()
	if countText(tt, "椭圆") != 1 || d.ed.tip != "" {
		t.Fatalf("光标移走后说明应立即收起 tip=%q texts=%v", d.ed.tip, tt.Texts())
	}

	// 点击按钮后收起说明，移开再悬停回来应恢复显示。
	if err := tt.Click("矩形"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if countText(tt, "矩形") != 1 {
		t.Fatalf("点击后不应留说明 %v", tt.Texts())
	}
	tt.Move(10, 10)
	tt.Frame()
	tt.Advance(500 * time.Millisecond) // 过热切窗口
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	tt.Advance(450 * time.Millisecond)
	if countText(tt, "矩形") != 2 || d.ed.tip != "矩形" {
		t.Fatalf("移开再悬停回来应重新显示说明 tip=%q texts=%v", d.ed.tip, tt.Texts())
	}

	// 样式行：粗细与颜色同样自动触发。
	for _, want := range []string{"粗", "蓝"} {
		tt.Move(10, 10)
		tt.Frame()
		tt.Advance(500 * time.Millisecond)
		sr, ok := tt.Find(want)
		if !ok {
			t.Fatalf("样式行没有「%s」", want)
		}
		tt.Move(sr.X+sr.W/2, sr.Y+sr.H/2)
		tt.Frame()
		tt.Advance(450 * time.Millisecond)
		if countText(tt, want) != 2 || d.ed.tip != want {
			t.Fatalf("悬停后应自动出说明「%s」，实为 tip=%q texts=%v", want, d.ed.tip, tt.Texts())
		}
	}
}

// 长图标注窗工具条悬停同样不依赖额外事件触发提示。
func TestLongEditorHoverTip(t *testing.T) {
	_, le, tt := longTest(t, nil)
	r, ok := tt.Find("裁剪")
	if !ok {
		t.Fatal("长图标注窗缺少裁剪按钮")
	}
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	tt.Advance(450 * time.Millisecond)
	if countText(tt, "裁剪") != 2 || le.d.ed.tip != "裁剪" {
		t.Fatalf("悬停后应自动出说明「裁剪」，实为 tip=%q texts=%v", le.d.ed.tip, tt.Texts())
	}
}

// 浅 / 深色截图目检（TOSKR_SHOT_DIR 落盘）：核对工具条悬停气泡位置与文案。
func TestShotHoverTipShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("TOSKR_SHOT_DIR 未设置")
	}
	for _, mode := range []struct {
		name string
		dark bool
	}{{"light", false}, {"dark", true}} {
		_, _, tt := shotTest(t)
		tt.SetScale(2)
		tt.SetDark(mode.dark)
		tt.Move(100, 80)
		tt.Frame()
		tt.Press(100, 80)
		tt.Release(101, 80)
		tt.Frame()
		r, ok := tt.Find("批注")
		if !ok {
			t.Fatal("没有批注按钮")
		}
		tt.Move(r.X+r.W/2, r.Y+r.H/2)
		tt.Frame()
		tt.Advance(450 * time.Millisecond)
		f, err := os.Create(filepath.Join(dir, "shot-tip-"+mode.name+".png"))
		if err != nil {
			t.Fatal(err)
		}
		_ = png.Encode(f, tt.Image())
		f.Close()
	}
}
