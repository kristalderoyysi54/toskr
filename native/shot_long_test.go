package main

import (
	"image"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/shot"
	"github.com/toskr/native/internal/store"
)

func longTest(t *testing.T, pin *pinWin) (*app, *longEditor, *ui.Tester) {
	t.Helper()
	a, _ := testApp(t)
	img := image.NewRGBA(image.Rect(0, 0, 800, 3000))
	for i := 3; i < len(img.Pix); i += 4 {
		img.Pix[i-3], img.Pix[i] = uint8(i/3200), 255
	}
	d := &shotDisplay{W: 400, H: 1500, pxW: 800, pxH: 3000, sx: 2, sy: 2, img: img, bm: ui.NewBitmap(img)}
	le := &longEditor{d: d, z: 1, origin: longOrigin{front: "Safari", pin: pin}}
	tt := ui.NewTester(func(c *ui.Context) { a.longEditorView(c, le) }, 900, 600)
	tt.Frame()
	return a, le, tt
}

func press(a *app, le *longEditor, kind ui.InputKind, x, y float32) {
	a.longInput(le, ui.InputEvent{Kind: kind, X: x * float32(le.z), Y: y * float32(le.z)})
}

func TestLongEditorDrawCropAndSave(t *testing.T) {
	a, le, tt := longTest(t, nil)
	if !tt.HasText("800 × 3000") {
		t.Fatalf("出图尺寸 %v", tt.Texts())
	}
	_ = tt.Click("矩形")
	tt.Frame()
	press(a, le, ui.InputPointerDown, 20, 20)
	press(a, le, ui.InputPointerMove, 120, 90)
	press(a, le, ui.InputPointerUp, 120, 90)
	tt.Frame()
	if len(le.d.ed.hist.Shapes) != 1 {
		t.Fatal("长图上画矩形")
	}
	_ = tt.Click("裁剪")
	tt.Frame()
	press(a, le, ui.InputPointerDown, 400, 1500) // 右下角手柄
	press(a, le, ui.InputPointerMove, 300, 1000)
	press(a, le, ui.InputPointerUp, 300, 1000)
	tt.Frame()
	if le.crop == nil || *le.crop != (shot.Rect{W: 300, H: 1000}) || !tt.HasText("600 × 2000") {
		t.Fatalf("裁剪 %+v %v", le.crop, tt.Texts())
	}
	tt.Key(0, ui.KeyEscape) // 结束裁剪
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	clips := a.store.Section(store.SectionClipboard)
	if !le.closed || len(clips) != 1 || clips[0].ImageW != 600 || clips[0].ImageH != 2000 || clips[0].SourceApp != "Safari" {
		t.Fatalf("✓ 存入剪贴 %+v", clips)
	}
}

func TestLongEditorWritesBackToPin(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 200, 100))
	p := &pinWin{img: img, bm: ui.NewBitmap(img), w: 100, h: 50, factor: 1, alpha: 100}
	a, le, tt := longTest(t, p)
	le.crop = &shot.Rect{W: 100, H: 60}
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if p.original != img || p.img.Rect.Dx() != 200 || p.img.Rect.Dy() != 120 || p.w != 100 || p.h != 60 {
		t.Fatalf("写回钉图 %v %v×%v", p.img.Rect, p.w, p.h)
	}
	if n := len(a.store.Section(store.SectionClipboard)); n != 0 {
		t.Fatal("钉图写回不入库")
	}
	a.pinRestore(p)
	if p.img != img || p.original != nil || p.h != 50 {
		t.Fatal("还原原图")
	}
}

func TestLongPreviewPanel(t *testing.T) {
	a, _ := testApp(t)
	lc := &longCapture{}
	st := shot.NewStitcher(make([]byte, 800*600*4), 800, 600)
	lc.stitched(a, st)
	lc.setStalled(a, true)
	tt := ui.NewTester(func(c *ui.Context) { a.longPreviewView(c, lc) }, 220, 400)
	tt.Frame()
	if !tt.HasText("800 × 600") || !tt.HasText("滚太快接不上，往回滚一点") || lc.bm == nil {
		t.Fatalf("预览面板 %v", tt.Texts())
	}
	_ = tt.Click("完成")
	tt.Frame()
	if shot.Stop(lc.stop.Load()) != shot.StopFinished || !lc.done {
		t.Fatal("点完成")
	}
	if a.longEsc() {
		t.Fatal("没有进行中的长截屏时 Esc 不处理")
	}
	a.longCap.Store(lc)
	if !a.longEsc() || shot.Stop(lc.stop.Load()) != shot.StopCancelled {
		t.Fatal("Esc 取消")
	}
}
