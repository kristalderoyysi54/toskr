package main

import (
	"image"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
)

func cell(t string, x, y float64) macos.OCRLine {
	return macos.OCRLine{Text: t, X: x, Y: y, W: float64(len([]rune(t))) * 14, H: 20}
}

func TestTableFromLines(t *testing.T) {
	lines := []macos.OCRLine{ // 故意打乱顺序、同一行略有高低
		cell("¥68", 320, 62), cell("名称", 20, 20), cell("金额", 320, 21), cell("周期", 180, 19),
		cell("视频会员", 20, 60), cell("每月", 180, 61),
		cell("云盘 a|b", 20, 100), cell("每年", 180, 101), cell("¥252", 320, 100),
	}
	md, ok := tableFromLines(lines)
	want := "| 名称 | 周期 | 金额 |\n| --- | --- | --- |\n| 视频会员 | 每月 | ¥68 |\n| 云盘 a\\|b | 每年 | ¥252 |"
	if !ok || md != want {
		t.Fatalf("ok=%v\n%s", ok, md)
	}
	// 缺一格的行补空；多数行齐全仍算表格
	md, ok = tableFromLines(append(slices0(lines), cell("只有一格", 20, 140)))
	if !ok || !strings.HasSuffix(md, "| 只有一格 |  |  |") {
		t.Fatalf("ok=%v\n%s", ok, md)
	}
	// 普通段落（每行一个框）、单行、太少：不是表格
	para := []macos.OCRLine{cell("第一行文字比较长", 20, 20), cell("第二行", 20, 50), cell("第三行也是", 20, 80), cell("第四行", 20, 110)}
	if _, ok := tableFromLines(para); ok {
		t.Fatal("段落不应算表格")
	}
	if _, ok := tableFromLines(lines[:3]); ok {
		t.Fatal("太少不算")
	}
}

func slices0(l []macos.OCRLine) []macos.OCRLine { return append([]macos.OCRLine(nil), l...) }

// 识别后在选区里选行：点一下切换、⇧ 连选、拖框框选、点空白清除；复制只取选中的行；二维码网址可打开；像表格时可复制为 Markdown 表。
func TestShotOCRPickLines(t *testing.T) {
	origOCR, origOpen := ocrImageCodes, openURL
	t.Cleanup(func() { ocrImageCodes, openURL = origOCR, origOpen })
	lines := []macos.OCRLine{ // 选区内图片像素坐标（测试显示器 2 倍）
		{Text: "名称", X: 20, Y: 20, W: 60, H: 24}, {Text: "金额", X: 200, Y: 20, W: 60, H: 24},
		{Text: "视频会员", X: 20, Y: 70, W: 110, H: 24}, {Text: "¥68", X: 200, Y: 70, W: 50, H: 24},
		{Text: "云盘", X: 20, Y: 120, W: 60, H: 24}, {Text: "¥21", X: 200, Y: 120, W: 50, H: 24},
	}
	ocrImageCodes = func(*image.RGBA, bool) ([]macos.OCRLine, []string, error) {
		return lines, []string{"https://example.com/pay?id=1", "WIFI:S:toskr;;"}, nil
	}
	var opened string
	openURL = func(u string) { opened = u }
	a, d, tt := shotTest(t)
	sys := &recSys{}
	a.sys = sys
	shotSelect(t, tt, d)
	a.shotRunOCR(nil, d)
	waitFor(t, func() bool { tt.Frame(); return d.ed.ocr != nil && !d.ed.ocr.busy })
	o, sel := d.ed.ocr, *d.ed.sel
	tt.Frame()
	if len(o.lines) != 6 || len(o.qr) != 2 || !strings.Contains(o.text, "视频会员") || !tt.HasText("在选区里点选或拖框，只取其中几行") {
		t.Fatalf("%+v %v", o, tt.Texts())
	}
	at := func(i int) (float32, float32) { // 第 i 行框中心的窗口坐标
		l := lines[i]
		return float32(sel.X + (l.X+l.W/2)/d.sx), float32(sel.Y + (l.Y+l.H/2)/d.sy)
	}
	// 测试窗只有 400 宽，文字面板会盖进选区里；这里直接把指针事件交给选行处理（真机上面板在选区旁边）
	ev := func(kind ui.InputKind, x, y float32, mods ui.Modifiers) {
		if !a.shotPickInput(d, ui.InputEvent{Kind: kind, X: x, Y: y, Mods: mods}) {
			t.Fatalf("事件应被选行处理 %v", kind)
		}
		tt.Frame()
	}
	click := func(i int) {
		x, y := at(i)
		ev(ui.InputPointerDown, x, y, 0)
		ev(ui.InputPointerUp, x, y, 0)
	}
	click(2)
	if o.text != "视频会员" || !tt.HasText("已选 1 / 6 行") {
		t.Fatalf("点选一行 %q %v", o.text, tt.Texts())
	}
	x5, y5 := at(5) // ⇧ 点最后一行：从上次点的那行连选过来
	ev(ui.InputPointerDown, x5, y5, ui.Shift)
	ev(ui.InputPointerUp, x5, y5, ui.Shift)
	if o.text != "视频会员\n¥68\n云盘\n¥21" {
		t.Fatalf("连选 %q", o.text)
	}
	click(2)
	if o.picked[2] {
		t.Fatal("再点取消这一行")
	}
	// 拖框：框住第一、二行（表头 + 视频会员）
	x0, y0 := float32(sel.X+4), float32(sel.Y+4)
	x1, y1 := float32(sel.X+140), float32(sel.Y+50)
	ev(ui.InputPointerDown, x0, y0, 0)
	ev(ui.InputPointerMove, (x0+x1)/2, (y0+y1)/2, 0)
	ev(ui.InputPointerMove, x1, y1, 0)
	if !o.banding || !o.moved {
		t.Fatal("拖动中应在拉框")
	}
	ev(ui.InputPointerUp, x1, y1, 0)
	if o.text != "名称\n金额\n视频会员\n¥68" || d.ed.sel == nil || *d.ed.sel != sel {
		t.Fatalf("拖框选行，选区本身不动 %q", o.text)
	}
	if md, ok := tableFromLines(o.pickedLines()); !ok || !strings.Contains(md, "| 视频会员 | ¥68 |") {
		t.Fatalf("%v %s", ok, md)
	}
	if !tt.HasText("复制为表格") || !tt.HasText("打开链接") || !tt.HasText("复制内容") || !tt.HasText("已选 4 / 6 行") {
		t.Fatalf("%v", tt.Texts())
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		save(t, filepath.Join(dir, "shot-pick.png"), tt.Image())
	}
	o.picked = nil
	o.syncText()
	if strings.Count(o.text, "\n") != 5 {
		t.Fatal("清除选择回到全部")
	}
	if !isWebURL("https://example.com/pay?id=1") || isWebURL("WIFI:S:toskr;;") || isWebURL("javascript:alert(1)") {
		t.Fatal("只有 http(s) 才给「打开链接」")
	}
	openURL(o.qr[0])
	if opened != "https://example.com/pay?id=1" {
		t.Fatal(opened)
	}
}
