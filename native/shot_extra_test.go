package main

import (
	"image"
	"os"
	"path/filepath"
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

// 点「复制」：只写剪贴板、不入库，结束截图并用气泡回报字数（不再靠按钮上的「已复制」小字）。
func TestShotOCRCopyCloses(t *testing.T) {
	a, d, tt := shotTest(t)
	rec := &recSys{}
	a.sys = rec
	shotSelect(t, tt, d)
	d.ed.ocr = &shotOCR{text: "识别出的文字", anchor: -1}
	tt.Frame()
	before := len(a.store.Notes())
	if err := tt.Click("复制"); err != nil {
		t.Fatal(err)
	}
	if len(rec.writes) != 1 || rec.writes[0] != "识别出的文字" {
		t.Fatalf("剪贴板 %v", rec.writes)
	}
	if a.shot != nil || a.hudText != "已复制 6 字" {
		t.Fatalf("应结束截图并回报 shot=%v hud=%q", a.shot != nil, a.hudText)
	}
	if len(a.store.Notes()) != before {
		t.Fatal("只复制不入库")
	}
}

// 拖动选区时不画全屏十字线（放大镜仍在）；圆角 / 阴影滑块默认收起，点按钮展开。
func TestShotCrossAndFrameToggle(t *testing.T) {
	a, d, tt := shotTest(t)
	tt.Move(100, 100)
	if !d.ed.showCross() {
		t.Fatal("没有选区时画十字线")
	}
	tt.Press(20, 20)
	tt.Move(120, 100)
	if !d.ed.dragging || d.ed.showCross() || !d.ed.showLoupe() {
		t.Fatalf("拖动中：不画十字线、放大镜保留 dragging=%v", d.ed.dragging)
	}
	tt.Move(220, 170)
	tt.Release(220, 170)
	tt.Frame()
	if _, ok := tt.Find("fs-layers-2"); ok || a.shotFrameOpen {
		t.Fatal("滑块默认收起")
	}
	if err := tt.Click("圆角与阴影"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !a.shotFrameOpen {
		t.Fatal("点按钮展开滑块")
	}
}

// 尺寸条与选框的间隔同工具条（8），且任何位置都不与工具条、选框边重叠。
func TestShotFrameBarTop(t *testing.T) {
	const th = 44.0
	for _, tc := range []struct {
		name          string
		sel           shot.Rect
		toolbarTop, w float64
	}{
		{"工具条在下、上方放得下", shot.Rect{X: 20, Y: 100, W: 200, H: 80}, 188, 54},
		{"工具条在下、上方放不下", shot.Rect{X: 20, Y: 20, W: 200, H: 80}, 108, 28},
		{"工具条被挤到上方", shot.Rect{X: 20, Y: 150, W: 200, H: 140}, 98, 158},
		{"全屏选区、工具条盖在顶部", shot.Rect{X: 0, Y: 0, W: 400, H: 300}, 0, 52},
	} {
		got := shotFrameBarTop(tc.sel, tc.toolbarTop, th)
		if got != tc.w {
			t.Fatalf("%s：%v，应为 %v", tc.name, got, tc.w)
		}
		if got < tc.toolbarTop+th && got+shotFrameBarH > tc.toolbarTop {
			t.Fatalf("%s：与工具条重叠", tc.name)
		}
		if got < tc.sel.Y && got+shotFrameBarH > tc.sel.Y {
			t.Fatalf("%s：压住选框上沿", tc.name)
		}
	}
}

// 识别面板与选框间隔同工具条，且不与工具条相交（工具条贴左、盖进选区等位置）。
func TestShotOCRPanelPlace(t *testing.T) {
	const dW, dH, th, h = 1200.0, 600.0, 44.0, 240.0
	for _, tc := range []struct {
		name       string
		sel        shot.Rect
		toolbarTop float64
		left, top  float64
	}{
		{"右侧放得下、工具条贴选区右缘", shot.Rect{X: 300, Y: 200, W: 500, H: 300}, 508, 808, 200},
		{"选区靠左且矮：工具条贴左伸到面板下面，面板收到工具条上方", shot.Rect{X: 40, Y: 300, W: 300, H: 100}, 408, 348, 160},
		{"选区靠右：面板换到左侧", shot.Rect{X: 700, Y: 100, W: 480, H: 300}, 408, 372, 100},
		{"全屏选区：进内侧右上，让到工具条下面", shot.Rect{X: 0, Y: 0, W: 1200, H: 600}, 0, 872, 52},
	} {
		left, top := shotOCRPanelPlace(tc.sel, dW, dH, tc.toolbarTop, th, h)
		if left != tc.left || top != tc.top {
			t.Fatalf("%s：%v,%v，应为 %v,%v", tc.name, left, top, tc.left, tc.top)
		}
		tl := tc.sel.X + tc.sel.W - shotToolbarWEst
		if tc.sel.X+tc.sel.W < shotToolbarWEst {
			tl = 4
		}
		if left < tl+shotToolbarWEst && left+shotOCRPanelW > tl && top < tc.toolbarTop+th && top+h > tc.toolbarTop {
			t.Fatalf("%s：与工具条重叠", tc.name)
		}
	}
}

// TestShotOverlayShots：截图遮罩浮层（尺寸条 / 工具条 / 识别面板 / 操作提示）在居中、贴顶、贴底、靠左、全屏五种选区位置下的浅深色整屏截图，
// 供改浮条后目检间隔与重叠（TOSKR_SHOT_DIR 未设时跳过）。
func TestShotOverlayShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	cases := []struct {
		name           string
		x0, y0, x1, y1 float32
	}{{"center", 300, 200, 900, 400}, {"top", 300, 20, 900, 300}, {"bottom", 300, 380, 900, 590}, {"left", 40, 300, 340, 400}, {"full", 4, 4, 1196, 596}}
	for _, dark := range []bool{false, true} {
		for i, tc := range cases {
			a, _ := testApp(t)
			img := image.NewRGBA(image.Rect(0, 0, 2400, 1200))
			for y := range 1200 {
				for x := range 2400 {
					o := y*img.Stride + x*4
					img.Pix[o], img.Pix[o+1], img.Pix[o+2], img.Pix[o+3] = uint8(120+x/40), uint8(140+y/20), 170, 255
				}
			}
			d := &shotDisplay{W: 1200, H: 600, pxW: 2400, pxH: 1200, sx: 2, sy: 2, img: img, bm: ui.NewBitmap(img)}
			a.shot = &shotSession{displays: []*shotDisplay{d}, done: make(chan struct{}), front: "Safari"}
			tt := ui.NewTester(func(c *ui.Context) { a.shotView(c, d) }, 1200, 600)
			tt.SetDark(dark)
			tt.Frame()
			a.shotFrameOpen = i%2 == 1
			dragOn(tt, tc.x0, tc.y0, tc.x1, tc.y1)
			mode := map[bool]string{false: "light", true: "dark"}[dark]
			d.ed.notice, d.ed.noticeAt = "已切换到矩形", tt.Now()
			tt.Move(600, 598)
			tt.Frame()
			save(t, filepath.Join(dir, "shot-overlay-"+tc.name+"-bar-"+mode+".png"), tt.Image()) // 尺寸条 + 工具条 + 操作提示
			d.ed.ocr = &shotOCR{text: "第一行文字\n第二行文字\n第三行文字", anchor: -1}
			tt.Frame()
			tt.Frame()
			save(t, filepath.Join(dir, "shot-overlay-"+tc.name+"-ocr-"+mode+".png"), tt.Image()) // 识别面板开着：尺寸条收起
		}
	}
}
