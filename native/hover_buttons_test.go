package main

import (
	"image"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 悬停到卡片浮钮 / 任务行删除钮上，按钮像素必须变化（描边加深、图标转前景 / 红）。
func hoverChanges(t *testing.T, tt *ui.Tester, rowText, label string) {
	t.Helper()
	row, ok := tt.Find(rowText)
	if !ok {
		t.Fatalf("找不到 %q：%v", rowText, tt.Texts())
	}
	tt.Move(row.X+row.W/2, row.Y+row.H/2) // 行悬停，露出操作钮
	tt.Advance(300 * time.Millisecond)
	tt.Frame()
	r, ok := tt.Find(label)
	if !ok {
		t.Fatalf("悬停行后找不到 %q：%v", label, tt.Texts())
	}
	crop := func() []byte {
		img := tt.Image()
		s := tt.Image().Bounds().Dx() / 360 // 缩放倍数
		if s < 1 {
			s = 1
		}
		rect := image.Rect(int(r.X)*s, int(r.Y)*s, int(r.X+r.W)*s, int(r.Y+r.H)*s)
		return append([]byte(nil), img.SubImage(rect).(*image.RGBA).Pix...)
	}
	before := crop()
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Advance(300 * time.Millisecond)
	tt.Frame()
	if string(before) == string(crop()) {
		t.Fatalf("悬停 %q 没有任何视觉变化", label)
	}
}

func TestListIconButtonsHover(t *testing.T) {
	_, tt := testApp(t, "悬停测试笔记")
	hoverChanges(t, tt, "悬停测试笔记", "删除")
	hoverChanges(t, tt, "悬停测试笔记", "发送到对话（双击卡片同效）")

	a, tt := testApp(t)
	a.store.AddTask(store.Task{Text: "悬停任务"})
	a.switchPage(pageTasks)
	a.taskSub = 1
	tt.Frame()
	hoverChanges(t, tt, "悬停任务", "删除任务")
}
