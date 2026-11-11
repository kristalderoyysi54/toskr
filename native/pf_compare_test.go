package main

import (
	"fmt"
	"image"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 对比窗：左原文（删除标红）右将发送（新增标绿），替换后实时反映；取消预检后显示已结束。
func TestPFCompareView(t *testing.T) {
	a, _ := openCheck(t, "联系 "+"alice"+"@example.com 或 13800138000")
	a.pfReplace(func(pfItem) bool { return true })
	ct := ui.NewTester(a.pfCompareView, 900, 600)
	ct.Frame()
	if !ct.HasText("2 处改动") || !ct.HasText("原文") || !ct.HasText("将发送") {
		t.Fatalf("对比窗应列出改动 %v", ct.Texts())
	}
	if all := strings.Join(ct.Texts(), "|"); !strings.Contains(all, "alice@example.com") || !strings.Contains(all, "[EMAIL_01]") {
		t.Fatalf("左栏原文、右栏占位符 %v", ct.Texts())
	}
	a.cancelPending()
	ct.Frame()
	if !ct.HasText("本次发送已结束") {
		t.Fatal(ct.Texts())
	}
}

// 按行对齐：改动行左右同排；改动之间的长段未改动内容折叠，展开后全部出现。
func TestCmpRowsAlignAndFold(t *testing.T) {
	var lines []string
	for i := range 20 {
		lines = append(lines, fmt.Sprintf("第 %d 行", i))
	}
	from := strings.Join(lines, "\n")
	lines[3], lines[16] = "第 3 行 [EMAIL_01]", "第 16 行 [PHONE_01]"
	to := strings.Join(lines, "\n")
	rows, n := cmpRows(from, to, nil)
	if n != 2 {
		t.Fatalf("2 处改动，得到 %d", n)
	}
	var folds, changed int
	for _, r := range rows {
		if r.fold > 0 {
			folds++
		}
		if r.changed {
			changed++
			if r.ln != r.rn || r.left == nil || r.right == nil {
				t.Fatalf("改动行应左右同排 %+v", r)
			}
		}
	}
	if folds != 1 || changed != 2 {
		t.Fatalf("两处改动之间的 12 行未改动内容折叠（首尾各 3 行不够折） folds=%d changed=%d", folds, changed)
	}
	open := map[int]bool{}
	for _, r := range rows {
		if r.fold > 0 {
			open[r.foldAt] = true
		}
	}
	if rows, _ = cmpRows(from, to, open); len(rows) != 20 {
		t.Fatalf("展开后应有 20 行，得到 %d", len(rows))
	}
	if rows, n = cmpRows("a\nb", "a\nb", nil); n != 0 || len(rows) != 2 {
		t.Fatal("没有改动不折叠")
	}
}

// 对比窗里直接处理：还原占位符为原文（并确认保留）、替换还没处理的命中。
func TestCmpRowActions(t *testing.T) {
	mail, mail2 := "alice"+"@example.com", "bob"+"@corp.io"
	a, _ := openCheck(t, "联系 "+mail+"\n抄送 "+mail2)
	a.pfReplace(func(it pfItem) bool { return a.pfText(it.note)[it.f.Start:it.f.End] == mail })
	rows, _ := cmpRows(a.pfOriginalText(), a.pf.final, nil)
	var labels []string
	for _, r := range rows {
		for _, x := range a.cmpRowActions(r) {
			labels = append(labels, x.label)
		}
	}
	all := strings.Join(labels, "|")
	if !strings.Contains(all, "还原「"+mail+"」为原文") || !strings.Contains(all, "替换「"+mail2+"」") || !strings.Contains(all, "保留「"+mail2+"」原文") {
		t.Fatalf("操作 %v", labels)
	}
	for _, r := range rows {
		for _, x := range a.cmpRowActions(r) {
			if strings.HasPrefix(x.label, "还原") {
				x.run()
			}
		}
	}
	if !strings.Contains(a.pf.final, mail) {
		t.Fatalf("应还原为原文 %q", a.pf.final)
	}
	for _, it := range a.pf.items {
		if a.pfText(it.note)[it.f.Start:it.f.End] == mail && !a.pf.kept[it.id] {
			t.Fatal("还原后应确认保留原文，不再算待处理")
		}
	}
}

// 图片：点左栏命中框在遮挡 / 保留之间切换；发送后「最近发送」能打开快照对比。
func TestCmpImageToggleAndSnapshot(t *testing.T) {
	orig, origGo := pfOCR, pfGo
	t.Cleanup(func() { pfOCR, pfGo = orig, origGo })
	pfGo = func(f func()) { f() }
	pfOCR = func(img *image.RGBA) ([]macos.OCRLine, error) {
		return []macos.OCRLine{{Text: "mail " + "carol" + "@corp.io", X: 0, Y: 10, W: 200, H: 20}}, nil
	}
	a, tt := testApp(t)
	a.sys = &pngSys{}
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	n := imageNote(t, a)
	a.send([]store.Note{n})
	tt.Frame()
	if len(a.pf.images) != 1 || len(a.pf.images[0].regions) != 1 {
		t.Fatalf("应识别出 1 处 %+v", a.pf.images)
	}
	ct := ui.NewTester(a.pfCompareView, 900, 600)
	ct.Frame()
	r := a.pf.images[0].regions[0]
	if err := ct.Click(r.kind + " · 待处理 · 点击遮挡"); err != nil {
		t.Fatal(err, ct.Texts())
	}
	ct.Frame()
	if !a.pf.images[0].masked[r.id] {
		t.Fatal("点框应遮挡")
	}
	_ = ct.Click(r.kind + " · 已遮挡 · 点击改为保留原文")
	ct.Frame()
	if a.pf.images[0].masked[r.id] || !a.pf.images[0].kept[r.id] {
		t.Fatal("再点改为保留原文")
	}
	a.pfMaskImages(func(*pfImage, pfRegion) bool { return true }, true)
	id := a.out.id
	a.pfSend(pfEval{canSend: true})
	if a.cmpSnaps[id] == nil {
		t.Fatalf("发送后应留下对比快照 id=%q", id)
	}
	a.cmpView = id // openDeliveryCompare 会开真窗口，测试里直接切视图
	ct.Frame()
	if !ct.HasText("发送记录对比") || !ct.HasText("快照只保存在内存，退出 Toskr 后清除") {
		t.Fatalf("快照视图 %v", ct.Texts())
	}
}

// 只看改动：未改动行全部折叠；N / P 在各处改动间跳转（循环），标题栏「i / N」。
func TestCmpOnlyChangesAndJump(t *testing.T) {
	body := "第一行\n联系 " + "alice" + "@example.com\n第三行\n第四行\n第五行\n第六行\n第七行\n抄送 " + "bob" + "@corp.io\n末行"
	a, _ := openCheck(t, body)
	a.pfReplace(func(pfItem) bool { return true })
	ct := ui.NewTester(a.pfCompareView, 1000, 600)
	ct.Frame()
	if !ct.HasText("1 / 2") {
		t.Fatalf("两处改动 %v", ct.Texts())
	}
	ct.Key(0, ui.KeyN)
	ct.Frame()
	if a.cmpCur != 1 || !ct.HasText("2 / 2") {
		t.Fatalf("N 跳到第 2 处 %d", a.cmpCur)
	}
	ct.Key(0, ui.KeyN)
	ct.Frame()
	if a.cmpCur != 0 {
		t.Fatal("循环回第 1 处")
	}
	if ct.HasText("第一行") == false {
		t.Fatal("默认保留上下文")
	}
	_ = ct.Click("只看改动")
	ct.Frame()
	if !a.cmpOnly || ct.HasText("第一行") || ct.HasText("第五行") {
		t.Fatalf("只看改动应隐藏未改动行 %v", ct.Texts())
	}
}
