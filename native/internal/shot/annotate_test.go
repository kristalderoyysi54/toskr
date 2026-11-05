package shot

import (
	"slices"
	"testing"
)

// 对应 annotate.test.ts / callout.test.ts / line.test.ts / shapeEdit.test.ts / crosshair.test.ts。

func rectS(x2 float64) *Shape { return &Shape{Kind: RectK, X2: x2, Y2: 10, Color: "#FF3B30", Size: 1} }
func numS(n int) *Shape       { return &Shape{Kind: Number, N: n, Color: "#FF3B30", Size: 1} }

var empty History

func TestShortShapesNotRecorded(t *testing.T) {
	if IsMeaningful(&Shape{Kind: Arrow, X2: 1, Y2: 1}) || IsMeaningful(&Shape{Kind: Text, Text: "  "}) {
		t.Fatal("误触不入历史")
	}
	if h := PushShape(empty, &Shape{Kind: Pen, Points: []Point{{0, 0}}}); len(h.Undo) != 0 || len(h.Shapes) != 0 {
		t.Fatal("单点画笔")
	}
}

func TestUndoRedo(t *testing.T) {
	h := PushShape(PushShape(empty, rectS(10)), rectS(20))
	h = Undo(h)
	if len(h.Shapes) != 1 || len(h.Redo) != 1 || len(Redo(h).Shapes) != 2 || len(PushShape(h, rectS(30)).Redo) != 0 {
		t.Fatalf("%+v", h)
	}
	if u := Undo(empty); len(u.Shapes) != 0 || len(u.Redo) != 0 {
		t.Fatal("空历史撤销")
	}
}

func TestNextNumber(t *testing.T) {
	if NextNumber(nil) != 1 || NextNumber([]*Shape{numS(1), rectS(10), numS(2)}) != 3 {
		t.Fatal("接续最大值")
	}
	h := Undo(PushShape(PushShape(empty, numS(1)), numS(2)))
	if NextNumber(h.Shapes) != 2 {
		t.Fatal("撤销后回填")
	}
}

func TestCommitTextEdit(t *testing.T) {
	txt := &Shape{Kind: Text, X: 5, Y: 5, Text: "旧", Color: "#FF3B30", Size: 1}
	h := PushShape(PushShape(empty, rectS(10)), txt)
	changed := CommitText(h, TextDraft{5, 5, "新", "#FF3B30", 1, txt})
	if len(changed.Shapes) != 2 || changed.Shapes[1].Text != "新" || Undo(changed).Shapes[1] != txt {
		t.Fatal("原地替换")
	}
	if len(CommitText(h, TextDraft{5, 5, " ", "#FF3B30", 1, txt}).Shapes) != 1 {
		t.Fatal("清空即删除")
	}
	if same := CommitText(h, TextDraft{5, 5, "旧", "#FF3B30", 1, txt}); len(same.Undo) != len(h.Undo) {
		t.Fatal("未改动不记历史")
	}
	got := WithTextDraft(h.Shapes, &TextDraft{5, 5, "新", "#000000", 1, txt})
	if len(got) != 2 || got[0].Kind != RectK || got[1].Kind != Text {
		t.Fatal("编辑中替代原图形")
	}
}

func TestTranslateFitAndContrast(t *testing.T) {
	if FitFontSize(100, 20, func(s float64) float64 { return s * 10 }) != 10 || FitFontSize(1000, 20, func(float64) float64 { return 50 }) != 14.4 {
		t.Fatal("字号")
	}
	if ContrastText(250, 250, 250) != "#111111" || ContrastText(20, 30, 40) != "#FFFFFF" || IsMeaningful(&Shape{Kind: Translate}) {
		t.Fatal("底色 / 空翻译")
	}
}

func calloutS(x float64, note string) *Shape {
	return &Shape{Kind: Callout, X1: x, X2: x + 50, Y2: 40, Note: note, Color: "#FF3B30", Size: 1}
}

func TestCalloutNumbering(t *testing.T) {
	a, b, r := calloutS(0, "改标题"), calloutS(100, "删掉这行"), &Shape{Kind: RectK, X2: 30, Y2: 30, Size: 1}
	n := CalloutNumbers([]*Shape{a, r, b})
	if n[a] != 1 || n[b] != 2 || CalloutNumbers([]*Shape{r, b})[b] != 1 {
		t.Fatal("编号")
	}
}

func TestCalloutPrompt(t *testing.T) {
	got := CalloutPrompt([]*Shape{calloutS(0, ""), calloutS(100, " 删掉这行 ")}, "图上的标注（序号对应图中区域）：")
	if got != "图上的标注（序号对应图中区域）：\n② 删掉这行" || CalloutPrompt([]*Shape{calloutS(0, "")}, "x") != "" {
		t.Fatalf("%q", got)
	}
}

func TestCircledNumber(t *testing.T) {
	if CircledNumber(1) != "①" || CircledNumber(20) != "⑳" || CircledNumber(21) != "(21)" {
		t.Fatal("带圈数字")
	}
}

func TestCommitNote(t *testing.T) {
	h1 := CommitNote(empty, NoteDraft{Shape: calloutS(0, ""), Text: "改颜色"})
	if len(h1.Undo) != 1 || h1.Shapes[0].Note != "改颜色" {
		t.Fatal("新框连同说明入历史")
	}
	orig := h1.Shapes[0]
	h2 := CommitNote(PushShape(h1, &Shape{Kind: RectK, X2: 30, Y2: 30, Size: 1}), NoteDraft{Shape: orig, Text: "改字号", Orig: orig})
	if h2.Shapes[0].Note != "改字号" || len(h2.Shapes) != 2 {
		t.Fatal("原地替换说明")
	}
}

func TestLineSnap(t *testing.T) {
	x, y := DragEnd(Line, 0, 0, 100, 8, true)
	x2, y2 := DragEnd(Line, 0, 0, 5, -100, true)
	x3, y3 := DragEnd(Line, 0, 0, 70, 72, true)
	x4, y4 := DragEnd(Line, 0, 0, 100, 8, false)
	x5, y5 := DragEnd(RectK, 0, 0, 100, 8, true)
	if x != 100 || y != 0 || x2 != 0 || y2 != -100 || x3 != y3 || x4 != 100 || y4 != 8 || x5 != 100 || y5 != 8 {
		t.Fatal("⇧ 吸附")
	}
}

func TestLineHit(t *testing.T) {
	l := &Shape{Kind: Line, X2: 100, Color: "#FF3B30", Size: 1}
	if ShapeAt([]*Shape{l}, 50, 2, 4, nil) != 0 || ShapeAt([]*Shape{l}, 50, 30, 4, nil) != -1 {
		t.Fatal("沿线命中")
	}
	var ids []EditHandle
	for _, h := range EditHandles(l) {
		ids = append(ids, h.ID)
	}
	if !slices.Equal(ids, []EditHandle{"start", "end"}) {
		t.Fatal(ids)
	}
}

var (
	eRect   = &Shape{Kind: RectK, X2: 200, Y2: 100, Color: "#FF3B30", Size: 1}
	eArrow  = &Shape{Kind: Arrow, X1: 50, Y1: 50, X2: 150, Y2: 50, Color: "#FF3B30", Size: 1}
	eText   = &Shape{Kind: Text, X: 300, Y: 300, Text: "Hi 你好", Color: "#FF3B30", Size: 1}
	eMosaic = &Shape{Kind: Mosaic, X1: 60, Y1: 40, X2: 20, Y2: 10, Color: "#000000", Size: 1}
)

func TestStrokeFirstHit(t *testing.T) {
	s := []*Shape{eArrow, eRect}
	if ShapeAt(s, 100, 51, 4, nil) != 0 || ShapeAt(s, 100, 80, 4, nil) != 1 || ShapeAt(s, 400, 400, 4, nil) != -1 {
		t.Fatal("描边优先")
	}
	if ShapeAt(s, 100, 51, 4, func(x *Shape) bool { return x.Kind == RectK }) != 1 || ShapeAt([]*Shape{eText}, 310, 305, 4, nil) != 0 {
		t.Fatal("限定种类 / 文字")
	}
}

func TestBoxResizeAndMove(t *testing.T) {
	if HandleAt(eMosaic, 60, 40, 4) != "se" {
		t.Fatal("手柄")
	}
	if b, _ := ShapeBounds(EditShape(eMosaic, "se", 20, 10, 500, 500)); b != (Rect{20, 10, 60, 40}) {
		t.Fatal(b)
	}
	if b, _ := ShapeBounds(EditShape(eMosaic, "", -100, 0, 500, 500)); b != (Rect{0, 10, 40, 30}) {
		t.Fatal(b)
	}
}

func TestArrowEndAndTextMove(t *testing.T) {
	if HandleAt(eArrow, 150, 50, 4) != "end" {
		t.Fatal("箭头端点")
	}
	if a := EditShape(eArrow, "end", 10, 20, 500, 500); a.X1 != 50 || a.Y1 != 50 || a.X2 != 160 || a.Y2 != 70 {
		t.Fatalf("%+v", a)
	}
	if tx := EditShape(eText, "", -10, 5, 500, 500); tx.X != 290 || tx.Y != 305 {
		t.Fatal("文字移动")
	}
}

func TestEditIsOneStep(t *testing.T) {
	h := PushShape(empty, eRect)
	moved := EditShape(eRect, "", 10, 10, 500, 500)
	edited := CommitShapes(h, []*Shape{moved})
	if Undo(edited).Shapes[0] != eRect || Redo(Undo(edited)).Shapes[0] != moved {
		t.Fatal("一步历史")
	}
}

func TestCrosshair(t *testing.T) {
	if LoadCrosshair("") != DefaultCrosshair || DefaultCrosshair.CSS() != "rgba(125, 211, 252, 0.7)" {
		t.Fatal(DefaultCrosshair.CSS())
	}
	if c := LoadCrosshair(`{"preset":"nope","alpha":5}`); c != (Crosshair{"sky", 30}) {
		t.Fatal(c)
	}
	if LoadCrosshair(`{"preset":"magenta","alpha":100}`).CSS() != "rgba(236, 72, 153, 1)" {
		t.Fatal("magenta")
	}
}
