package main

import (
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// TestRenderPanelSnapshots 在设置 TOSKR_RENDER_DIR 时把面板渲染成 PNG（报告配图用）。
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
	a.store.Add(store.Note{Section: store.SectionClipboard, Text: "https://github.com/egoist/mygo", SourceApp: "Arc"})
	a.target.Name = "Cursor"
	a.target.PID = 42
	for _, tc := range []struct {
		name            string
		dark, vibrancy  bool
		glass           string
	}{
		{"panel-light-glass", false, true, "glass"},
		{"panel-dark-glass", true, true, "glass"},
		{"panel-light-plain", false, false, "none"},
	} {
		st := a.store.Settings()
		st.Glass = tc.glass
		a.store.SetSettings(st)
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
