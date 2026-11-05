package main

import (
	"bytes"
	"image"
	"image/png"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/shot"
	"github.com/toskr/native/internal/store"
)

func redactTest(t *testing.T) (*app, *redactEditor, *ui.Tester) {
	t.Helper()
	recheckOCR = func(*image.RGBA) ([]macos.OCRLine, error) { return nil, nil }
	t.Cleanup(func() { recheckOCR = ocrImage })
	a, _ := testApp(t)
	img := image.NewRGBA(image.Rect(0, 0, 400, 200))
	for i := range img.Pix {
		img.Pix[i] = uint8(i)
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	file, _ := a.store.SaveImage(buf.Bytes())
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", ImageFile: file, ImageW: 400, ImageH: 200, Text: "图片 400×200"})
	re, err := a.newRedactor(n)
	if err != nil {
		t.Fatal(err)
	}
	tt := ui.NewTester(func(c *ui.Context) { a.redactView(c, re) }, 416, 216)
	tt.Frame()
	tt.Frame()
	return a, re, tt
}

func TestRedactDrawSelectStyleApplyUndo(t *testing.T) {
	a, re, tt := redactTest(t)
	if re.area.W != 400 || re.area.H != 200 {
		t.Fatalf("画布 %+v", re.area)
	}
	in := func(k ui.InputKind, x, y float32) { a.redactInput(re, ui.InputEvent{Kind: k, X: x, Y: y}) }
	in(ui.InputPointerDown, 10, 10)
	in(ui.InputPointerMove, 60, 40)
	in(ui.InputPointerUp, 60, 40)
	tt.Frame()
	if len(re.present) != 1 || re.present[0].PxBox != (shot.PxBox{X: 10, Y: 10, W: 50, H: 30}) || re.selected != 0 || !tt.HasText("1 处") {
		t.Fatalf("画框 %+v %v", re.present, tt.Texts())
	}
	_ = tt.Click("改为黑色")
	tt.Frame()
	if re.present[0].Style.Kind != shot.RedactSolid || len(re.past) != 2 {
		t.Fatalf("换样式 %+v", re.present[0].Style)
	}
	// 拖动移动、拖角缩放各一步历史
	in(ui.InputPointerDown, 30, 20)
	in(ui.InputPointerMove, 40, 30)
	in(ui.InputPointerUp, 40, 30)
	if re.present[0].PxBox != (shot.PxBox{X: 20, Y: 20, W: 50, H: 30}) {
		t.Fatalf("移动 %+v", re.present[0].PxBox)
	}
	in(ui.InputPointerDown, 70, 50)
	in(ui.InputPointerMove, 100, 80)
	in(ui.InputPointerUp, 100, 80)
	if re.present[0].PxBox != (shot.PxBox{X: 20, Y: 20, W: 80, H: 60}) {
		t.Fatalf("缩放 %+v", re.present[0].PxBox)
	}
	a.redactInput(re, ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyZ, Mods: ui.Cmd})
	if re.present[0].PxBox.W != 50 {
		t.Fatal("⌘Z 撤销缩放")
	}
	a.redactInput(re, ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyEnter, Mods: ui.Cmd})
	n, _ := a.store.Note(re.note.ID)
	if !re.closed || n.ImageFile == re.note.ImageFile {
		t.Fatal("⌘⏎ 应用写回")
	}
	raw, _ := a.store.LoadImage(n.ImageFile)
	out, _ := png.Decode(bytes.NewReader(raw))
	if r, g, b, _ := out.At(30, 30).RGBA(); r>>8 != 20 || g>>8 != 20 || b>>8 != 22 {
		t.Fatalf("框内应为近黑实色 %v %v %v", r>>8, g>>8, b>>8)
	}
	_ = tt.Click("撤销") // HUD 撤销需窗口；直接调存储验证可换回
	if _, _, _, err := a.store.ReplaceImage(n.ID, re.note.ImageFile, 400, 200); err != nil {
		t.Fatal(err)
	}
}

func TestRedactCandidatesFromOCR(t *testing.T) {
	a, re, tt := redactTest(t)
	lines := []macos.OCRLine{{Text: "卡号 6222021234567890128 余额", X: 10, Y: 100, W: 270, H: 20}}
	found := sensitiveBoxes(lines, re.W, re.H)
	if len(found) != 1 || found[0].label != "银行卡号" || found[0].box.X < 30 || found[0].box.X+found[0].box.W > 260 {
		t.Fatalf("候选框 %+v", found)
	}
	re.candidates = found
	tt.Frame()
	if !tt.HasText("识别到 1 处敏感文字，点虚线框逐个打码") {
		t.Fatalf("提示条 %v", tt.Texts())
	}
	_ = tt.Click("全部打码")
	tt.Frame()
	if len(re.present) != 1 || len(re.candidates) != 0 || re.present[0].Style.Kind != shot.RedactMosaic {
		t.Fatalf("全部打码 %+v", re.present)
	}
	a.redactInput(re, ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyEscape})
	a.redactInput(re, ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyEscape})
	if !re.closed {
		t.Fatal("Esc 逐层退出到关窗")
	}
}

// 复检：识别框过半落在第 2 个框里 → 不保存、标红第 2 个框、提示「第 2 处」；改动后红框清除，再应用通过。
func TestRedactRecheckFailsAndMarksRegion(t *testing.T) {
	a, re, tt := redactTest(t)
	re.commit([]shot.Region{{PxBox: shot.PxBox{X: 0, Y: 0, W: 40, H: 40}}, {PxBox: shot.PxBox{X: 100, Y: 100, W: 60, H: 30}}})
	recheckOCR = func(*image.RGBA) ([]macos.OCRLine, error) {
		return []macos.OCRLine{{Text: "4111", X: 105, Y: 105, W: 40, H: 20}, {Text: "ok", X: 300, Y: 10, W: 50, H: 20}}, nil
	}
	before := re.note.ImageFile
	a.applyRedaction(re)
	tt.Frame()
	n, _ := a.store.Note(re.note.ID)
	if re.closed || re.busy || n.ImageFile != before || len(re.failed) != 1 || re.failed[0] != 1 {
		t.Fatalf("复检未通过应不保存并标第 2 框：closed=%v busy=%v failed=%v", re.closed, re.busy, re.failed)
	}
	if !strings.Contains(a.hudText, "第 2 处") {
		t.Fatalf("提示 %q", a.hudText)
	}
	re.remove(1)
	if re.failed != nil {
		t.Fatal("改动后应清除红框")
	}
	recheckOCR = func(*image.RGBA) ([]macos.OCRLine, error) { return nil, nil }
	a.applyRedaction(re)
	n, _ = a.store.Note(re.note.ID)
	if !re.closed || n.ImageFile == before {
		t.Fatal("复检通过应写回")
	}
}
