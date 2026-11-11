package main

import (
	"testing"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func TestZoomAroundKeepsAnchor(t *testing.T) {
	v := zoomAround(fitView, 2, 100, 50)
	if v.zoom != 2 || v.x != -100 || v.y != -50 {
		t.Fatalf("2× 以 (100,50) 为锚 %+v", v)
	}
	if v2 := zoomAround(v, 0.5, 30, 30); v2 != (zoomView{zoom: 0.5}) {
		t.Fatalf("1× 以下应居中清零 %+v", v2)
	}
	if v3 := zoomAround(v, 100, 0, 0); v3.zoom != maxImgZoom {
		t.Fatalf("上限 8× %+v", v3)
	}
}

// 同 Tauri ImagePreviewView：滚轮缩放、页脚显示缩放比例、放大后拖拽平移、双击复位、翻页复位。
func TestDetailImageZoomPan(t *testing.T) {
	a, _ := testApp(t)
	f1, _ := a.store.SaveImage(whitePNG(t, 400, 300))
	f2, _ := a.store.SaveImage(whitePNG(t, 300, 200))
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "图片 400×300", ImageFile: f1, ImageW: 400, ImageH: 300, Attachments: []string{f2}})
	dt := detailTester(t, a, n)
	a.detailImageAt(n, 0)
	dt.Frame()
	dt.Wheel(280, 270, 0, -300)
	dt.Frame()
	if a.detail.view.zoom <= 1 {
		t.Fatalf("向上滚应放大 %+v", a.detail.view)
	}
	if !dt.HasText("%") {
		t.Fatalf("放大后页脚应有缩放比例 %v", dt.Texts())
	}
	x0 := a.detail.view.x
	dt.Press(280, 270)
	dt.Move(320, 290)
	dt.Release(320, 290)
	dt.Frame()
	if a.detail.view.x-x0 != 40 {
		t.Fatalf("拖拽应平移 40：%v → %v", x0, a.detail.view.x)
	}
	dt.ClickAt(280, 270)
	dt.ClickAt(280, 270)
	dt.Frame()
	if a.detail.view != fitView {
		t.Fatalf("双击应复位 %+v", a.detail.view)
	}
	dt.Wheel(280, 270, 0, -300)
	dt.Frame()
	_ = dt.Click("下一张")
	dt.Frame()
	if a.detail.view != fitView || a.detail.img != 1 {
		t.Fatalf("翻页应复位 %+v img=%d", a.detail.view, a.detail.img)
	}
}

// 宽于 1600 的图放大后载入高分辨率版；适配态不载入。
func TestDetailZoomLoadsHiRes(t *testing.T) {
	a, _ := testApp(t)
	f, _ := a.store.SaveImage(whitePNG(t, 4000, 600))
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "图片 4000×600", ImageFile: f, ImageW: 4000, ImageH: 600})
	dt := detailTester(t, a, n)
	a.detailImageAt(n, 0)
	dt.Frame()
	if a.detail.hi != nil {
		t.Fatal("适配态不该载入高分辨率版")
	}
	dt.Wheel(280, 270, 0, -300)
	dt.Frame()
	if a.detail.hi == nil || a.detail.hiFile != f {
		t.Fatalf("放大后应载入高分辨率版 file=%q", a.detail.hiFile)
	}
	if w, _ := ui.ImageSize(a.detail.hi); w != 4000 {
		t.Fatalf("高分辨率版宽 %v", w)
	}
}

// 同 Tauri 图片预览窗：按图片原始尺寸开窗，小图不放大（最小 380×300），大图等比缩进工作区 90%。
func TestImageWindowFrame(t *testing.T) {
	wa := mygo.Rectangle{X: 0, Y: 25, Width: 1440, Height: 875}
	if r := imageWindowFrame(wa, 1000, 600, 82); r.Width != 1016 || r.Height != 682 || r.X != 212 {
		t.Fatalf("原始尺寸 %+v", r)
	}
	if r := imageWindowFrame(wa, 100, 50, 82); r.Width != 380 || r.Height != 300 {
		t.Fatalf("小图不放大、保底窗口尺寸 %+v", r)
	}
	r := imageWindowFrame(wa, 2880, 1800, 121)
	if r.Height > 788 || r.Width > 1313 {
		t.Fatalf("大图应缩进工作区 90%% %+v", r)
	}
}

// 看图层：⌘+ / ⌘− / ⌘0 缩放（不改正文字号），悬停出「− 100% +」胶囊，点百分比适配。
func TestDetailZoomKeysAndControls(t *testing.T) {
	a, _ := testApp(t)
	f, _ := a.store.SaveImage(whitePNG(t, 400, 300))
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "图片 400×300", ImageFile: f, ImageW: 400, ImageH: 300})
	dt := detailTester(t, a, n)
	a.detailImageAt(n, 0)
	fs := a.store.Settings().DetailFontSize
	dt.Key(ui.Cmd, ui.KeyEqual)
	dt.Frame()
	if a.detail.view.zoom != zoomKeyStep || a.store.Settings().DetailFontSize != fs {
		t.Fatalf("⌘+ 应放大一档且不改字号 zoom=%v fs=%v", a.detail.view.zoom, a.store.Settings().DetailFontSize)
	}
	if !dt.HasText("125%") {
		t.Fatalf("已缩放时胶囊常显 %v", dt.Texts())
	}
	if err := dt.Click("放大（⌘+）"); err != nil {
		t.Fatal(err)
	}
	if z := a.detail.view.zoom; z < 1.56 || z > 1.57 {
		t.Fatalf("再放大一档 %v", z)
	}
	if err := dt.Click("适配窗口（⌘0）"); err != nil {
		t.Fatal(err)
	}
	dt.Frame()
	if a.detail.view != fitView {
		t.Fatalf("点百分比应适配 %+v", a.detail.view)
	}
	dt.Key(ui.Cmd, ui.KeyMinus)
	dt.Frame()
	if a.detail.view.zoom != 1/zoomKeyStep {
		t.Fatalf("⌘− 缩小 %v", a.detail.view.zoom)
	}
	dt.Key(ui.Cmd, ui.Key0)
	dt.Frame()
	if a.detail.view != fitView {
		t.Fatal("⌘0 适配")
	}
}

// 缩放时页脚百分比在变，右侧「添加图片说明」位置不动。
func TestDetailZoomFooterStable(t *testing.T) {
	a, _ := testApp(t)
	f1, _ := a.store.SaveImage(whitePNG(t, 400, 300))
	f2, _ := a.store.SaveImage(whitePNG(t, 300, 200))
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "图片 400×300", ImageFile: f1, ImageW: 400, ImageH: 300, Attachments: []string{f2}})
	dt := detailTester(t, a, n)
	a.detailImageAt(n, 0)
	var xs []float32
	for range 6 {
		dt.Key(ui.Cmd, ui.KeyEqual)
		dt.Frame()
		r, ok := dt.Find("添加图片说明")
		if !ok {
			t.Fatal(dt.Texts())
		}
		xs = append(xs, r.X)
	}
	for _, x := range xs[1:] {
		if x != xs[0] {
			t.Fatalf("百分比变化挪动了右侧按钮 %v", xs)
		}
	}
}
