package main

import (
	"image"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/shot"
	"github.com/toskr/native/internal/store"
)

// 截图编辑器的界面测试：冻结帧为 400×300pt @2x 的合成图，屏上有一扇 (50,40,200,120) 的窗口。

func shotPixel(x, y int) (uint8, uint8, uint8) { return uint8(x % 256), uint8(y % 256), 128 }

func shotTest(t *testing.T) (*app, *shotDisplay, *ui.Tester) {
	t.Helper()
	a, _ := testApp(t)
	img := image.NewRGBA(image.Rect(0, 0, 800, 600))
	for y := range 600 {
		for x := range 800 {
			r, g, b := shotPixel(x, y)
			o := y*img.Stride + x*4
			img.Pix[o], img.Pix[o+1], img.Pix[o+2], img.Pix[o+3] = r, g, b, 255
		}
	}
	d := &shotDisplay{W: 400, H: 300, pxW: 800, pxH: 600, sx: 2, sy: 2, img: img, bm: ui.NewBitmap(img).Pixelated(),
		windows: []shot.Rect{{X: 50, Y: 40, W: 200, H: 120}}}
	a.shot = &shotSession{displays: []*shotDisplay{d}, done: make(chan struct{}), front: "Safari"}
	tt := ui.NewTester(func(c *ui.Context) { a.shotView(c, d) }, 400, 300)
	tt.Frame()
	return a, d, tt
}

func dragOn(tt *ui.Tester, x0, y0, x1, y1 float32) {
	tt.Move(x0, y0)
	tt.Press(x0, y0)
	tt.Move((x0+x1)/2, (y0+y1)/2)
	tt.Move(x1, y1)
	tt.Release(x1, y1)
	tt.Frame()
}

func TestShotClickSelectsHoveredWindow(t *testing.T) {
	_, d, tt := shotTest(t)
	tt.Move(100, 80)
	tt.Frame()
	if !tt.HasText("400 × 240") { // 悬停窗口的像素尺寸
		t.Fatalf("悬停窗口尺寸标签 %v", tt.Texts())
	}
	tt.Press(100, 80)
	tt.Release(101, 80)
	tt.Frame()
	if d.ed.sel == nil || *d.ed.sel != (shot.Rect{X: 50, Y: 40, W: 200, H: 120}) {
		t.Fatalf("单击应选中悬停窗口，实为 %+v", d.ed.sel)
	}
	if _, ok := tt.Find("矩形"); !ok {
		t.Fatalf("选区后应出现工具条 %v", tt.Texts())
	}
}

func TestShotDragResizeAndNudge(t *testing.T) {
	_, d, tt := shotTest(t)
	dragOn(tt, 300, 200, 360, 260)
	if d.ed.sel == nil || *d.ed.sel != (shot.Rect{X: 300, Y: 200, W: 60, H: 60}) {
		t.Fatalf("拖出选区 %+v", d.ed.sel)
	}
	// 整条右边可拖
	dragOn(tt, 360, 230, 380, 230)
	if d.ed.sel.W != 80 {
		t.Fatalf("拖右边改宽 %+v", d.ed.sel)
	}
	tt.Key(ui.Shift, ui.KeyLeft)
	tt.Frame()
	if d.ed.sel.X != 290 {
		t.Fatalf("⇧← 左移 10：%+v", d.ed.sel)
	}
}

func shotSelect(t *testing.T, tt *ui.Tester, d *shotDisplay) {
	t.Helper()
	dragOn(tt, 20, 20, 220, 170)
	if d.ed.sel == nil {
		t.Fatal("未选出选区")
	}
}

func TestShotDrawUndoAndEditShape(t *testing.T) {
	_, d, tt := shotTest(t)
	shotSelect(t, tt, d)
	if err := tt.Click("矩形"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if d.ed.tool != shot.RectK || !strings.Contains(strings.Join(tt.Texts(), ""), "") {
		t.Fatal("选中矩形工具")
	}
	dragOn(tt, 40, 80, 120, 140)
	if len(d.ed.hist.Shapes) != 1 || d.ed.hist.Shapes[0].Kind != shot.RectK {
		t.Fatalf("画矩形 %+v", d.ed.hist.Shapes)
	}
	// 同类工具下点中描边即选中，拖动移动且是一步历史
	dragOn(tt, 40, 110, 50, 120)
	if b := shot.Box(d.ed.hist.Shapes[0]); b.X != 50 || b.Y != 90 || len(d.ed.hist.Undo) != 2 {
		t.Fatalf("移动图形 %+v undo=%d", b, len(d.ed.hist.Undo))
	}
	tt.Key(ui.Cmd, ui.KeyZ)
	tt.Frame()
	if b := shot.Box(d.ed.hist.Shapes[0]); b.X != 40 {
		t.Fatalf("撤销移动 %+v", b)
	}
	// 选着标注工具且已有标注时，仍可直接拖选框边角调整截图区域，且标注锚定底图不错位
	dragOn(tt, 220, 95, 250, 95)
	if d.ed.sel.W != 230 || d.ed.tool != shot.RectK {
		t.Fatalf("选着工具拖右边应调宽且保持工具：sel=%+v tool=%q", d.ed.sel, d.ed.tool)
	}
	if b := shot.Box(d.ed.hist.Shapes[0]); b.X != 40 || b.Y != 80 {
		t.Fatalf("调整选区后标注应锚定底图原坐标 %+v", b)
	}
	tt.Key(0, ui.KeyEscape) // 撤销后选中项已失效：Esc 直接退出工具
	tt.Frame()
	if d.ed.tool != "" || d.ed.sel == nil {
		t.Fatalf("Esc 逐级：tool=%q sel=%v", d.ed.tool, d.ed.sel)
	}
	// 退出工具后即使已有标注，仍可平移选区与方向键微调；点击选区外部不误清标注
	dragOn(tt, 150, 150, 160, 160)
	if d.ed.sel.X != 30 || d.ed.sel.Y != 30 {
		t.Fatalf("退出工具后应可平移选区 %+v", d.ed.sel)
	}
	tt.Key(ui.Shift, ui.KeyLeft)
	tt.Frame()
	if d.ed.sel.X != 20 {
		t.Fatalf("有标注时方向键微调应生效 %+v", d.ed.sel)
	}
	dragOn(tt, 350, 260, 390, 290) // 选区外拖动：保护已有标注，不重拉新选区
	if d.ed.sel.X != 20 || d.ed.sel.W != 230 || len(d.ed.hist.Shapes) != 1 {
		t.Fatalf("选区外误拖不应覆盖已有选区与标注 sel=%+v shapes=%d", d.ed.sel, len(d.ed.hist.Shapes))
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if d.ed.sel != nil || len(d.ed.hist.Shapes) != 0 {
		t.Fatal("Esc 清掉选区与标注")
	}
}

// 使用箭头等标注工具后，不退出工具也能直接拖边角扩/缩选区，已画箭头随底图对齐且出图正确裁切。
func TestShotResizeAfterArrowKeepsAnchor(t *testing.T) {
	_, d, tt := shotTest(t)
	shotSelect(t, tt, d) // (20, 20, 200, 150)
	if err := tt.Click("箭头"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	dragOn(tt, 60, 80, 140, 140)
	if len(d.ed.hist.Shapes) != 1 || d.ed.hist.Shapes[0].Kind != shot.Arrow {
		t.Fatalf("画箭头 %+v", d.ed.hist.Shapes)
	}
	// 光标悬停右缘应给左右缩放光标，直接拖动调整选区宽与底边
	tt.Move(220, 95)
	tt.Frame()
	if cur := d.ed.tool; cur != shot.Arrow {
		t.Fatalf("仍保持箭头工具 %q", cur)
	}
	dragOn(tt, 220, 170, 260, 200) // 拖右下角扩选区
	if d.ed.sel.W != 240 || d.ed.sel.H != 180 {
		t.Fatalf("箭头工具下应能拖角缩放选区 %+v", d.ed.sel)
	}
	s := d.ed.hist.Shapes[0]
	if s.X1 != 60 || s.Y1 != 80 || s.X2 != 140 || s.Y2 != 140 {
		t.Fatalf("箭头坐标应保持锚定底图 %+v", s)
	}
	// 出图按新选区尺寸裁切
	out := renderShot(d, *d.ed.sel, d.ed.allShapes(), shotFrame{})
	if out.Rect.Dx() != 480 || out.Rect.Dy() != 360 {
		t.Fatalf("出图尺寸应为新选区 480×360，实为 %v", out.Rect)
	}
}

// 缩小选区裁掉第一条批注后：编辑态标签隐藏被裁项，导出文案只保留仍在选区内的批注并重新从 ① 编号。
func TestShotCalloutPromptExcludesCroppedOut(t *testing.T) {
	a, d, tt := shotTest(t)
	shotSelect(t, tt, d) // (20, 20, 200, 150)
	_ = tt.Click("批注")
	tt.Frame()
	dragOn(tt, 30, 80, 70, 110)
	tt.Type("左边被裁掉")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	dragOn(tt, 140, 80, 190, 120)
	tt.Type("右边保留")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if !tt.HasText("左边被裁掉") || !tt.HasText("右边保留") {
		t.Fatalf("两处批注说明都应可见 %v", tt.Texts())
	}
	// 把选区左边向右拖到 110，完全裁掉第一条批注 (30..70)
	dragOn(tt, 20, 95, 110, 95)
	if tt.HasText("左边被裁掉") || !tt.HasText("右边保留") {
		t.Fatalf("裁出选区的批注浮标应隐藏 %v", tt.Texts())
	}
	tt.Key(0, ui.KeyEscape) // 退出工具
	tt.Frame()
	tt.Key(0, ui.KeyEnter) // 确认出图
	tt.Frame()
	clips := a.store.Section(store.SectionClipboard)
	want := "图上的标注（序号对应图中区域）：\n① 右边保留"
	if len(clips) != 1 || clips[0].Text != want {
		t.Fatalf("导出批注说明应只含选区内项且从 ① 编号，实为 %+v", clips)
	}
}

// 选区调整支持 ⌘Z / ⇧⌘Z 与图形标注交替撤销重做，且拖动边角靠近窗口边界时自动吸附。
func TestShotSelectionUndoRedoAndSnap(t *testing.T) {
	_, d, tt := shotTest(t)
	// 窗口在 (50, 40, 200, 120) → 右边 x=250，底边 y=160
	shotSelect(t, tt, d) // (20, 20, 200, 150) → 右边 220，底边 170
	_ = tt.Click("箭头")
	tt.Frame()
	dragOn(tt, 60, 80, 140, 130) // 步骤 1：画箭头
	// 步骤 2：拖右边到 246（距窗口右缘 250 仅 4pt <= 6pt），应自动吸附到 250（宽 230）
	dragOn(tt, 220, 95, 246, 95)
	if d.ed.sel.W != 230 {
		t.Fatalf("拖右边靠近窗口缘 250 应吸附，实为 %+v", d.ed.sel)
	}
	// 步骤 3：退出工具并按 ⇧→ 微调
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	tt.Key(ui.Shift, ui.KeyRight)
	tt.Frame()
	if d.ed.sel.X != 30 {
		t.Fatalf("微调后 X 应为 30，实为 %+v", d.ed.sel)
	}
	// ⌘Z #1：撤回微调 → X=20, W=230
	tt.Key(ui.Cmd, ui.KeyZ)
	tt.Frame()
	if *d.ed.sel != (shot.Rect{X: 20, Y: 20, W: 230, H: 150}) || len(d.ed.hist.Shapes) != 1 {
		t.Fatalf("撤销 #1 应回退微调：sel=%+v shapes=%d", d.ed.sel, len(d.ed.hist.Shapes))
	}
	// ⌘Z #2：撤回缩放 → W=200，箭头仍在
	tt.Key(ui.Cmd, ui.KeyZ)
	tt.Frame()
	if *d.ed.sel != (shot.Rect{X: 20, Y: 20, W: 200, H: 150}) || len(d.ed.hist.Shapes) != 1 {
		t.Fatalf("撤销 #2 应回退缩放：sel=%+v shapes=%d", d.ed.sel, len(d.ed.hist.Shapes))
	}
	// ⌘Z #3：撤回箭头 → 图形清空
	tt.Key(ui.Cmd, ui.KeyZ)
	tt.Frame()
	if len(d.ed.hist.Shapes) != 0 {
		t.Fatalf("撤销 #3 应撤回箭头 %+v", d.ed.hist.Shapes)
	}
	// ⇧⌘Z 三次依次恢复：箭头 → 缩放 → 微调
	tt.Key(ui.Cmd|ui.Shift, ui.KeyZ)
	tt.Frame()
	if len(d.ed.hist.Shapes) != 1 {
		t.Fatal("重做 #1 应恢复箭头")
	}
	tt.Key(ui.Cmd|ui.Shift, ui.KeyZ)
	tt.Frame()
	if d.ed.sel.W != 230 {
		t.Fatalf("重做 #2 应恢复缩放 %+v", d.ed.sel)
	}
	tt.Key(ui.Cmd|ui.Shift, ui.KeyZ)
	tt.Frame()
	if d.ed.sel.X != 30 {
		t.Fatalf("重做 #3 应恢复微调 %+v", d.ed.sel)
	}
}

func TestShotTextAndCallout(t *testing.T) {
	_, d, tt := shotTest(t)
	shotSelect(t, tt, d)
	_ = tt.Click("文字")
	tt.Frame()
	tt.Move(60, 90)
	tt.Press(60, 90)
	tt.Release(60, 90)
	tt.Frame()
	if d.ed.editing == nil {
		t.Fatal("点击开始输入文字")
	}
	tt.Type("你好")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if len(d.ed.hist.Shapes) != 1 || d.ed.hist.Shapes[0].Text != "你好" || d.ed.editing != nil {
		t.Fatalf("Enter 完成文字 %+v", d.ed.hist.Shapes)
	}
	_ = tt.Click("批注")
	tt.Frame()
	dragOn(tt, 100, 90, 180, 140)
	if d.ed.note == nil || !tt.HasText("批注说明") {
		t.Fatalf("批注画完出说明卡 %v", tt.Texts())
	}
	tt.Type("改标题")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	last := d.ed.hist.Shapes[len(d.ed.hist.Shapes)-1]
	if last.Kind != shot.Callout || last.Note != "改标题" || !tt.HasText("改标题") {
		t.Fatalf("说明入历史并贴标签 %+v %v", last, tt.Texts())
	}
}

func TestShotExportPixelsAndFrame(t *testing.T) {
	_, d, _ := shotTest(t)
	sel := shot.Rect{X: 10, Y: 20, W: 50, H: 30}
	out := renderShot(d, sel, nil, shotFrame{})
	if out.Rect.Dx() != 100 || out.Rect.Dy() != 60 {
		t.Fatalf("出图像素尺寸 %v", out.Rect)
	}
	for _, p := range [][2]int{{0, 0}, {37, 21}, {99, 59}} {
		o := p[1]*out.Stride + p[0]*4
		r, g, b := shotPixel(20+p[0], 40+p[1])
		if got := out.Pix[o : o+3]; got[0] != r || got[1] != g || got[2] != b {
			t.Fatalf("像素 %v 应原样 %v，实为 %v", p, []uint8{r, g, b}, got)
		}
	}
	framed := renderShot(d, sel, nil, shotFrame{Radius: 10, Shadow: 8, ShadowAlpha: 45})
	if framed.Rect.Dx() != 100+32 || framed.Rect.Dy() != 60+32 {
		t.Fatalf("阴影边距 %v", framed.Rect)
	}
	if a := framed.Pix[16*framed.Stride+16*4+3]; a == 255 {
		t.Fatal("圆角外应透明")
	}
	if a := framed.Pix[50*framed.Stride+60*4+3]; a != 255 {
		t.Fatal("图内应不透明")
	}
	mid := (60+16)*framed.Stride + 60*4
	if framed.Pix[mid+3] == 0 {
		t.Fatal("下方应有投影")
	}
}

func TestShotExportDrawsShapes(t *testing.T) {
	_, d, _ := shotTest(t)
	sel := shot.Rect{X: 0, Y: 0, W: 100, H: 100}
	shapes := []*shot.Shape{{Kind: shot.RectK, X1: 10, Y1: 10, X2: 90, Y2: 90, Color: "#FF3B30", Size: 1}}
	out := renderShot(d, sel, shapes, shotFrame{})
	o := 20*out.Stride + 100*4 // 上边描边中点（pt 50,10 → px 100,20）
	if r, g := out.Pix[o], out.Pix[o+1]; r < 200 || g > 120 {
		t.Fatalf("描边应为红色，实为 %v", out.Pix[o:o+4])
	}
	mosaic := []*shot.Shape{{Kind: shot.Mosaic, X1: 0, Y1: 0, X2: 18, Y2: 18, Color: "#000000", Size: 1}}
	m := renderShot(d, sel, mosaic, shotFrame{})
	if m.Pix[0] != m.Pix[4*10] || m.Pix[0] == m.Pix[4*30] {
		t.Fatal("马赛克块内同色、块间不同")
	}
}

func TestShotSaveStoresClipWithCaption(t *testing.T) {
	a, d, tt := shotTest(t)
	shotSelect(t, tt, d)
	_ = tt.Click("批注")
	tt.Frame()
	dragOn(tt, 40, 80, 100, 140)
	tt.Type("删掉这行")
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	tt.Key(0, ui.KeyEscape) // 退出工具
	tt.Frame()
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if a.shot != nil {
		t.Fatal("完成后结束截图")
	}
	clips := a.store.Section(store.SectionClipboard)
	if len(clips) != 1 || clips[0].Kind != "image" || clips[0].ImageW != 400 || clips[0].SourceApp != "Safari" ||
		clips[0].Text != "图上的标注（序号对应图中区域）：\n① 删掉这行" {
		t.Fatalf("存入剪贴 %+v", clips)
	}
}

func TestShotLoupeAndCopyColor(t *testing.T) {
	a, d, tt := shotTest(t)
	tt.Move(10, 5)
	tt.Frame()
	r, g, b := shotPixel(20, 10)
	want := strings.ToUpper(string([]byte{hexDigit(r >> 4), hexDigit(r & 15), hexDigit(g >> 4), hexDigit(g & 15), hexDigit(b >> 4), hexDigit(b & 15)}))
	if d.ed.sampled != "#"+want || !tt.HasText("20, 10") {
		t.Fatalf("取色 %q 应为 #%s；%v", d.ed.sampled, want, tt.Texts())
	}
	tt.Key(0, ui.KeyC)
	tt.Frame()
	if clips := a.store.Section(store.SectionClipboard); len(clips) != 1 || clips[0].Text != "#"+want || !tt.HasText("已复制") {
		t.Fatalf("C 复制色值 %+v", clips)
	}
}

func hexDigit(v uint8) byte { return "0123456789abcdef"[v] }

// 先打码再用聚光灯：框外的打码与其余画面一样压暗（不再像被高亮）；框内的打码保持原亮度且仍是打码，不被原图盖回。
func TestShotSpotlightDimsMosaicOutside(t *testing.T) {
	_, d, _ := shotTest(t)
	sel := shot.Rect{X: 0, Y: 0, W: 100, H: 100}
	outMosaic := &shot.Shape{Kind: shot.Mosaic, X1: 60, Y1: 60, X2: 90, Y2: 90, Size: 1}
	inMosaic := &shot.Shape{Kind: shot.Mosaic, X1: 5, Y1: 5, X2: 35, Y2: 35, Size: 1}
	spot := &shot.Shape{Kind: shot.Spotlight, X1: 0, Y1: 0, X2: 40, Y2: 40}
	plain := renderShot(d, sel, []*shot.Shape{outMosaic, inMosaic}, shotFrame{})
	lit := renderShot(d, sel, []*shot.Shape{outMosaic, inMosaic, spot}, shotFrame{})
	px := func(img *image.RGBA, x, y int) []uint8 { o := y*img.Stride + x*4; return img.Pix[o : o+3] }
	sum := func(p []uint8) int { return int(p[0]) + int(p[1]) + int(p[2]) }
	// 框外打码（pt 75,75 → px 150,150）：应压暗
	if a, b := sum(px(plain, 150, 150)), sum(px(lit, 150, 150)); b >= a*7/10 || a == 0 {
		t.Fatalf("框外打码应压暗：原 %d 现 %d", a, b)
	}
	// 框内打码（pt 20,20 → px 40,40）：与无聚光灯时完全一致（仍是打码，不压暗）
	if a, b := px(plain, 40, 40), px(lit, 40, 40); a[0] != b[0] || a[1] != b[1] || a[2] != b[2] {
		t.Fatalf("框内打码应保持原样 %v vs %v", a, b)
	}
	// 框内未打码处（pt 38,2 → px 76,4）：原图原亮度
	r, g, b := shotPixel(76, 4)
	near := func(x, y uint8) bool { return int(x)-int(y) <= 2 && int(y)-int(x) <= 2 } // 重采样允许相邻像素差
	if p := px(lit, 76, 4); !near(p[0], r) || !near(p[1], g) || !near(p[2], b) {
		t.Fatalf("框内原图应原样 %v want %v", p, []uint8{r, g, b})
	}
}
