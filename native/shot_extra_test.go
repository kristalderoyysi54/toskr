package main

import (
	"image"
	"os"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/shot"
)

func TestErasePatchKeepsBackground(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 40, 20))
	for i := range img.Pix {
		img.Pix[i] = 240
	}
	for x := 10; x < 30; x++ { // 一道黑色笔画
		o := 10*img.Stride + x*4
		img.Pix[o], img.Pix[o+1], img.Pix[o+2] = 0, 0, 0
	}
	patch, bg := erasePatch(img, 5, 5, 30, 10, 2)
	if bg != [3]uint8{240, 240, 240} || patch.Rect.Dx() != 34 || patch.Rect.Dy() != 14 {
		t.Fatalf("背景 %v 尺寸 %v", bg, patch.Rect)
	}
	for i := 0; i < len(patch.Pix); i += 4 {
		if patch.Pix[i] != 240 {
			t.Fatalf("笔画应抹成背景色，第 %d 像素 %v", i/4, patch.Pix[i:i+4])
		}
	}
}

func TestParseTranslatedLines(t *testing.T) {
	got, err := parseLines("```json\n[\"你好\", \"世界\"]\n```", 2)
	if err != nil || got[1] != "世界" {
		t.Fatal(got, err)
	}
	if _, err := parseLines(`["只有一行"]`, 2); err == nil {
		t.Fatal("行数不符应报错")
	}
}

func TestShotApplyTranslation(t *testing.T) {
	a, d, tt := shotTest(t)
	shotSelect(t, tt, d)
	d.ed.translated = &shotTranslateJob{
		lines: []macos.OCRLine{{Text: "Hello", X: 20, Y: 20, W: 120, H: 30}},
		out:   []string{"你好"}, pr: shot.Rect{X: 40, Y: 40, W: 400, H: 300}, sel: *d.ed.sel,
	}
	tt.Frame()
	if len(d.ed.hist.Shapes) != 1 || d.ed.hist.Shapes[0].Kind != shot.Translate {
		t.Fatalf("译文入历史 %+v", d.ed.hist.Shapes)
	}
	it := d.ed.hist.Shapes[0].Items[0]
	if it.X != 30 || it.Y != 30 || it.W != 60 || it.FontSize < 8 || it.Patch == nil || it.Text != "你好" {
		t.Fatalf("覆盖项 %+v", it)
	}
	// 再点一次去掉（测试窗比工具条窄，直接调用按钮动作）
	a.shotTranslate(nil, d)
	tt.Frame()
	if len(d.ed.hist.Shapes) != 0 {
		t.Fatal("再点去掉译文")
	}
}

func TestShotOCRPanelEsc(t *testing.T) {
	_, d, tt := shotTest(t)
	shotSelect(t, tt, d)
	d.ed.ocr = &shotOCR{text: "识别出的文字"}
	tt.Frame()
	if !tt.HasText("识别结果") || !tt.HasText("存入「剪贴」") {
		t.Fatalf("文字面板 %v", tt.Texts())
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if d.ed.ocr != nil || d.ed.sel == nil {
		t.Fatal("Esc 先关文字面板，选区保留")
	}
}

// Vision 逐行识别带位置（真机框架；验证 boundingBox 结构体返回与坐标换算）。
func TestOCRLinesFindsText(t *testing.T) {
	img := ui.Render(func(c *ui.Context) {
		c.Root().Background(colWhite)
		ui.Box(c).Padding(40, 60).Children(func() {
			text(c, "Hello Toskr 2026", 48, 64, 600, colBlack)
		})
	}, 700, 160, 1)
	f, _ := os.CreateTemp("", "ocr-*.png")
	f.Close()
	defer os.Remove(f.Name())
	lines, err := ocrImage(img)
	if err != nil || len(lines) == 0 {
		t.Fatalf("识别 %v %v", lines, err)
	}
	l := lines[0]
	if !strings.Contains(l.Text, "Toskr") || l.X < 30 || l.X > 120 || l.Y < 20 || l.Y > 80 || l.W < 300 {
		t.Fatalf("行框 %+v", l)
	}
}

func TestPinWheelZoom(t *testing.T) {
	a, _ := testApp(t)
	img := image.NewRGBA(image.Rect(0, 0, 200, 100))
	p := &pinWin{img: img, bm: ui.NewBitmap(img), w: 100, h: 50, factor: 1, alpha: 100}
	tt := ui.NewTester(func(c *ui.Context) { a.pinView(c, p) }, 100, 50)
	tt.Frame()
	tt.Wheel(50, 25, 0, -200)
	tt.Frame()
	if p.factor <= 1 || !tt.HasText("140%") {
		t.Fatalf("滚轮放大 %v %v", p.factor, tt.Texts())
	}
}
