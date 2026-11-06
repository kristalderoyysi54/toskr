package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// TestRenderPanelSnapshots 在设置 TOSKR_RENDER_DIR 时把面板各页渲染成 PNG（报告配图用）。
func TestRenderPanelSnapshots(t *testing.T) {
	dir := os.Getenv("TOSKR_RENDER_DIR")
	if dir == "" {
		t.Skip("set TOSKR_RENDER_DIR")
	}
	a, _ := testApp(t,
		"把这段接口说明发给 Claude：分页参数 page_size 默认 20，最大 200；超过返回 400。",
		"会议纪要：周五前完成 mygo 原生版对比报告，附内存与启动耗时。",
		"SELECT id, title FROM notes WHERE section = 'inbox' ORDER BY created_at DESC LIMIT 50;",
		"记得复核截图遮罩回收后的 Networking 进程占用",
	)
	notes := a.store.Notes()
	_ = a.store.MarkSent([]string{notes[3].ID}, time.Now())
	a.store.AddSection("提示词库")
	a.store.Add(store.Note{Section: store.SectionClipboard, Text: "https://github.com/egoist/mygo", SourceApp: "Arc"})
	// 一张合成「截图」：渐变 + 色块
	img := image.NewRGBA(image.Rect(0, 0, 640, 280))
	for y := range 280 {
		for x := range 640 {
			img.Set(x, y, color.RGBA{uint8(40 + x/5), uint8(90 + y/3), 200, 255})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	name, _ := a.store.SaveImage(buf.Bytes())
	a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", ImageFile: name, ImageW: 640, ImageH: 280, Text: "识别结果：分页参数 page_size", SourceApp: "截图"})

	now := time.Now()
	a.store.AddTask(store.Task{Text: "交 mygo 对比报告", DueAt: time.Date(now.Year(), now.Month(), now.Day()+1, 15, 0, 0, 0, now.Location()), Priority: "mid"})
	a.store.AddTask(store.Task{Text: "复核账单提醒逻辑", DueAt: now.Add(-26 * time.Hour), Priority: "high"})
	a.store.AddTask(store.Task{Text: "周会", DueAt: now.Add(4 * time.Hour), Recurrence: "weekly"})
	a.store.AddBill(store.Bill{Kind: "subscription", Name: "iCloud+ 200GB", Amount: 21, Cycle: "monthly", NextDueAt: now.AddDate(0, 0, 2)})
	a.store.AddBill(store.Bill{Kind: "subscription", Name: "域名续费", Amount: 89, Cycle: "yearly", NextDueAt: now.AddDate(0, 3, 0)})
	a.store.AddBill(store.Bill{Kind: "creditCard", Name: "招行信用卡", Amount: 3260, NextDueAt: now.AddDate(0, 0, 9)})
	a.target.Name = "Cursor"
	a.target.PID = 42
	a.reload()
	for _, tc := range []struct {
		name           string
		page           int
		dark, vibrancy bool
		glass          string
	}{
		{"panel-light-glass", pageNotes, false, true, "glass"},
		{"panel-dark-glass", pageNotes, true, true, "glass"},
		{"tasks-light", pageTasks, false, true, "glass"},
	} {
		st := a.store.Settings()
		st.Glass = tc.glass
		a.store.SetSettings(st)
		a.page = tc.page
		a.reload()
		tt := ui.NewTester(a.panelView, 360, 720)
		tt.SetDark(tc.dark)
		tt.SetVibrancy(tc.vibrancy)
		tt.Frame()
		f, err := os.Create(filepath.Join(dir, tc.name+".png"))
		if err != nil {
			t.Fatal(err)
		}
		if err := png.Encode(f, tt.Image()); err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
}

// 阅读态划词 → 编辑器选区：段落 / 列表项按原文定位，跨段取首段起点到末段终点。
func TestMapReadSelection(t *testing.T) {
	src := "标题行\n\n- 第一项内容\n- 第二项\n\n最后一段 hello"
	cases := []struct {
		parts []ui.SelectedText
		want  [2]int
	}{
		{nil, [2]int{-1, -1}},
		{[]ui.SelectedText{{Text: "第一项内容", Start: 1, End: 3}}, [2]int{8, 10}},
		{[]ui.SelectedText{{Text: "第二项", Start: 1, End: 3}, {Text: "最后一段 hello", Start: 0, End: 4}}, [2]int{16, 24}},
		{[]ui.SelectedText{{Text: "不存在", Start: 0, End: 1}}, [2]int{-1, -1}},
	}
	for _, c := range cases {
		if got := mapReadSelection(src, c.parts); got != c.want {
			t.Fatalf("%+v → %v，应为 %v", c.parts, got, c.want)
		}
	}
}

// 详情窗划词工具条：编辑态选中 → 已选 N 字 · 发送选中 · 复制 · 粗体 / 斜体 · 处理（转大写替换选区并保持选中）。
func TestDetailSelectionToolbar(t *testing.T) {
	a, _ := testApp(t, "hello world 你好")
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	a.enterDetailEdit(n)
	a.detail.editSel = [2]int{6, 11} // world
	tt := ui.NewTester(a.detailView, 560, 540)
	tt.Frame()
	tt.Frame()
	for _, s := range []string{"已选 5 字", "发送选中"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q %v", s, tt.Texts())
		}
	}
	if err := tt.Click("处理选中内容"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("转大写"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	tt.Frame()
	tt.Frame()
	if a.detailText != "hello WORLD 你好" || a.detail.editRange != [2]int{6, 11} {
		t.Fatalf("%q %v", a.detailText, a.detail.editRange)
	}
	tt.Click("粗体（⌘B）")
	tt.Frame()
	if a.detailText != "hello **WORLD** 你好" {
		t.Fatalf("%q", a.detailText)
	}
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = byte(i * 7)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// 图片详情：多图上一张 / 下一张（按钮与 ←→）、i / N · 尺寸、文字备注（截图默认标题视为无备注，⌘⏎ 保存）。
func TestDetailImageNavAndNote(t *testing.T) {
	a, _ := testApp(t)
	f1, _ := a.store.SaveImage(pngBytes(t, 400, 300))
	f2, _ := a.store.SaveImage(pngBytes(t, 500, 200))
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", ImageFile: f1, ImageW: 400, ImageH: 300, Text: "图片 400×300", Attachments: []string{f2}})
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	a.detailImageAt(n, 0)
	tt := ui.NewTester(a.detailView, 560, 540)
	tt.Frame()
	for _, s := range []string{"1 / 2 · 400 × 300", "添加文字备注…"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q %v", s, tt.Texts())
		}
	}
	if err := tt.Click("下一张"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !tt.HasText("2 / 2 · 500 × 200") {
		t.Fatal(tt.Texts())
	}
	tt.Key(0, ui.KeyLeft)
	tt.Frame()
	if a.detail.img != 0 {
		t.Fatal("← 回上一张")
	}
	tt.Click("添加文字备注")
	tt.Frame()
	tt.Type("会议白板")
	tt.Key(ui.Cmd, ui.KeyEnter)
	tt.Frame()
	if got, _ := a.store.Note(n.ID); got.Text != "会议白板" || a.detail.imgNote {
		t.Fatalf("⌘⏎ 保存备注：%q", got.Text)
	}
	if !tt.HasText("会议白板") {
		t.Fatal(tt.Texts())
	}
}

// 文本详情：编辑态可改标题，元信息带标题与「改于」。
func TestDetailTitleEdit(t *testing.T) {
	a, _ := testApp(t, "正文内容")
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	a.enterDetailEdit(n)
	tt := ui.NewTester(a.detailView, 560, 540)
	tt.Frame()
	if !tt.HasText("笔记标题") {
		t.Fatal(tt.Texts())
	}
	a.detail.title = "周报草稿"
	a.saveDetail()
	if got, _ := a.store.Note(n.ID); got.Title != "周报草稿" {
		t.Fatal(got.Title)
	}
	a.detail.edit = false
	tt.Frame()
	found := false
	for _, s := range tt.Texts() {
		if strings.HasPrefix(s, "周报草稿 · ") {
			found = true
		}
	}
	if !found {
		t.Fatal(tt.Texts())
	}
}

// 选词粒度「段」、链接卡「打开链接」、处理 ▾ 的本地文本处理（可撤销）。
func TestDetailPickParaAndTextOps(t *testing.T) {
	a, _ := testApp(t, "第一段 hello\n\n第二段 world")
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}, pick: true}
	tt := ui.NewTester(a.detailView, 560, 540)
	tt.Frame()
	if !tt.HasText("词") || !tt.HasText("段") {
		t.Fatal("选词时出现 词 / 段 粒度切换", tt.Texts())
	}
	a.detail.pickPara = true // 正文里也有「段」字，按文字点击会点到正文
	tt.Frame()
	if err := tt.Click("第二段 world"); err != nil {
		t.Fatalf("段粒度应整段可点：%v %v", err, tt.Texts())
	}
	tt.Frame()
	if got := a.pickedText(n.Text); got != "第二段 world" {
		t.Fatal(got)
	}
	a.detail.pick = false
	tt.Frame()
	if err := tt.Click("处理"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("转大写"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	if got, _ := a.store.Note(n.ID); !strings.Contains(got.Text, "HELLO") || a.hudUndo == nil {
		t.Fatal(got.Text)
	}
	a.hudUndo()
	if got, _ := a.store.Note(n.ID); got.Text != n.Text {
		t.Fatal("撤销恢复原文")
	}
	if noteURL(store.Note{Kind: "link", URL: "https://x.com"}) == "" || noteURL(store.Note{Kind: "link", Text: "javascript:alert(1)"}) != "" {
		t.Fatal("打开链接只放行 http/https")
	}
}
