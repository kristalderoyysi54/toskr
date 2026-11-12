package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// TestSettingsFeatureShots：渲染「更多功能」「权限」浅深两色截图供目检（TOSKR_SHOT_DIR 未设时跳过）。
func TestSettingsFeatureShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	for _, dark := range []bool{false, true} {
		a, _ := testApp(t)
		a.patchSettings(func(x *store.Settings) { x.MessagesEnabled = true })
		a.openSettingsState()
		set := ui.NewTester(a.settingsView, 1040, 1400)
		set.SetDark(dark)
		mode := "light"
		if dark {
			mode = "dark"
		}
		for _, page := range []string{"粘贴规则", "隐私保护"} {
			a.setJump = page
			set.Frame()
			set.Advance(time.Second)
			set.Frame()
			save(t, filepath.Join(dir, "set-"+page+"-"+mode+".png"), set.Image())
		}
	}
}

// TestSectionDragShots：分组拖动中途（拿起 → 其余让位）浅深两色截图（TOSKR_SHOT_DIR 未设时跳过）。
func TestSectionDragShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	for _, dark := range []bool{false, true} {
		a, tt := testApp(t, "收件箱里的卡")
		tt.SetDark(dark)
		for _, name := range []string{"工作", "资料"} {
			id := a.store.AddSection(name)
			a.store.Add(store.Note{Section: id, Text: name + "里的卡"})
		}
		tt.Frame()
		tt.Frame()
		f, _ := tt.Find("资料")
		g, _ := tt.Find("收件箱里的卡")
		fx, fy := f.X+f.W/2, f.Y+f.H/2
		tt.Move(fx, fy)
		tt.Press(fx, fy)
		for i := 1; i <= 8; i++ {
			tt.Move(fx, fy+(g.Y-fy)*float32(i)/8)
			tt.Frame()
		}
		tt.Advance(time.Second)
		tt.Frame()
		mode := map[bool]string{false: "light", true: "dark"}[dark]
		save(t, filepath.Join(dir, "secdrag-"+mode+".png"), tt.Image())
		t.Logf("active=%q over=%q", a.secSort.active, a.secSort.over)
		tt.Release(fx, g.Y)
		tt.Frame()
	}
}

// TestTaskSectionDragShot：任务分组拖动中途截图（TOSKR_SHOT_DIR 未设时跳过）。
func TestTaskSectionDragShot(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	for _, dark := range []bool{false, true} {
		a, tt := testApp(t)
		tt.SetDark(dark)
		work := a.store.AddTaskSection("工作")
		a.store.AddTask(store.Task{Text: "任务一"})
		a.store.AddTask(store.Task{Text: "任务二", Section: work})
		a.switchPage(pageTasks)
		a.taskSub = 1
		tt.Frame()
		tt.Frame()
		f, _ := tt.Find("工作")
		g, _ := tt.Find("任务一")
		fx, fy := f.X+f.W/2, f.Y+f.H/2
		tt.Move(fx, fy)
		tt.Press(fx, fy)
		for i := 1; i <= 6; i++ {
			tt.Move(fx, fy+(g.Y-fy)*float32(i)/6)
			tt.Frame()
		}
		tt.Advance(time.Second)
		tt.Frame()
		save(t, filepath.Join(dir, "tsecdrag-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), tt.Image())
		tt.Release(fx, g.Y)
		tt.Frame()
	}
}
