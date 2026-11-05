package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
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
	a.store.AddTask(store.ParseQuickTask("明天下午3点 交 mygo 对比报告 !!", now))
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
