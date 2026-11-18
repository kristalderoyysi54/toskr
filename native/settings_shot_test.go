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

// TestListMenuShots：标题栏 ☰ 菜单（列表操作 + 面板设置）浅深两色截图（TOSKR_SHOT_DIR 未设时跳过）。
func TestListMenuShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	for _, dark := range []bool{false, true} {
		a, tt := testApp(t, "收件箱里的卡", "另一张卡", "做完的卡")
		tt.SetDark(dark)
		id := a.store.AddSection("工作")
		a.store.Add(store.Note{Section: id, Text: "工作里的卡"})
		for _, n := range a.store.Section(store.SectionInbox) {
			if n.Text == "做完的卡" {
				_ = a.store.SetDone(n.ID, true)
			}
		}
		for _, s := range a.store.Sections() {
			if s.ID == id {
				s.Collapsed = true
				_ = a.store.UpdateSection(s)
			}
		}
		a.reload()
		a.menuOpen = true
		tt.Frame()
		tt.Advance(time.Second)
		tt.Frame()
		mode := "light"
		if dark {
			mode = "dark"
		}
		save(t, filepath.Join(dir, "menu-"+mode+".png"), tt.Image())
	}
}

// TestQuickGridShots：内容页「常用」区（4 个 / 11 个带滚动）浅深两色截图（TOSKR_SHOT_DIR 未设时跳过）。
func TestQuickGridShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	titles := []string{"不限制你的创意和想象力，自由发挥", "请使用 Three.js 写一个可交互的示例", "claude --dangerously-skip-permissions", "代码审查", "翻译成英文",
		"周报模板：本周完成 / 下周计划 / 风险", "解释报错", "总结要点", "改写得更口语", "生成测试用例", "提交说明"}
	for _, dark := range []bool{false, true} {
		for _, n := range []int{4, 11} {
			a, tt := testApp(t, "收件箱里的卡")
			tt.SetDark(dark)
			sec := a.store.AddSection("提示词")
			for i := range n {
				x, _, _ := a.store.Add(store.Note{Section: sec, Text: titles[i]})
				_ = a.store.SetKept(x.ID, true)
				_, _ = a.store.SetSendCount(x.ID, (i*7)%13+1)
			}
			a.reload()
			tt.Frame()
			tt.Frame()
			if n > 9 {
				a.quickScroll.Y = 30
			}
			tt.Advance(time.Second)
			tt.Frame()
			save(t, filepath.Join(dir, "quick-"+itoa(n)+"-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), tt.Image())
		}
	}
}

// TestFoldFolderShots：分组头小文件夹（合上 / 打开 / 带分组色）与展开中途一帧，浅深两色截图（TOSKR_SHOT_DIR 未设时跳过）。
func TestFoldFolderShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	for _, dark := range []bool{false, true} {
		a, tt := testApp(t, "收件箱里的卡")
		tt.SetDark(dark)
		var last store.Section
		for i, name := range []string{"Ai Basics", "News", "可借鉴"} {
			id := a.store.AddSection(name)
			a.store.Add(store.Note{Section: id, Text: name + " 里的卡"})
			a.store.Add(store.Note{Section: id, Text: name + " 里的第二张卡"})
			for _, s := range a.store.Sections() {
				if s.ID == id {
					s.Collapsed = i != 1
					if i < 2 {
						s.Color = sectionColors[(i*3+5)%len(sectionColors)]
					}
					_ = a.store.UpdateSection(s)
					last = s
				}
			}
		}
		a.reload()
		tt.Frame()
		tt.Advance(time.Second)
		tt.Frame()
		mode := map[bool]string{false: "light", true: "dark"}[dark]
		save(t, filepath.Join(dir, "fold-"+mode+".png"), tt.Image())
		last.Collapsed = false
		_ = a.store.UpdateSection(last)
		tt.Frame()
		tt.Advance(90 * time.Millisecond)
		tt.Frame()
		save(t, filepath.Join(dir, "fold-mid-"+mode+".png"), tt.Image())
		work := a.store.AddTaskSection("工作")
		a.store.AddTaskSection("生活")
		a.store.AddTask(store.Task{Text: "任务一", Section: work})
		a.store.AddTask(store.Task{Text: "任务二"})
		a.switchPage(pageTasks) // 任务页分组头同款文件夹
		a.taskSub = 1
		tt.Frame()
		tt.Advance(time.Second)
		tt.Frame()
		save(t, filepath.Join(dir, "fold-tasks-"+mode+".png"), tt.Image())
		a.openSettingsState() // 设置 → 通用：「减弱动态效果」行
		st := ui.NewTester(a.settingsView, 1040, 960)
		st.SetDark(dark)
		st.Frame()
		st.Advance(time.Second)
		st.Frame()
		save(t, filepath.Join(dir, "reduce-motion-"+mode+".png"), st.Image())
	}
}
