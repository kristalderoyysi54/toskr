package main

import (
	"bytes"
	"fmt"
	"image"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// TestComparePlatinum 对照 Platinum 方案下主面板各页与交互态：与 TestCompareSchemes 同一组笔记，
// 参照 ref-pt-<名称>-light.png（浏览器开 Tauri 前端、根属性 data-theme="platinum"、380×760 截取）。
func TestComparePlatinum(t *testing.T) {
	dir := os.Getenv("TOSKR_COMPARE_DIR")
	if dir == "" {
		t.Skip("set TOSKR_COMPARE_DIR")
	}
	defer func() { curScheme = "default" }()
	mk := func() *app {
		st, err := store.OpenDir(t.TempDir(), bytes.Repeat([]byte{1}, 32))
		if err != nil {
			t.Fatal(err)
		}
		ago := time.Now().Add(-61 * time.Second)
		st.AddSection("提示词库")
		for _, n := range []struct {
			text string
			done bool
		}{
			{"记得复核截图遮罩回收后的 Networking 进程占用", true},
			{"SELECT id, title FROM notes WHERE section = 'inbox' ORDER BY created_at DESC LIMIT 50;", false},
			{"会议纪要：周五前完成 mygo 原生版对比报告，附内存与启动耗时。", false},
			{"把这段接口说明发给 Claude：分页参数 page_size 默认 20，最大 200；超过返回 400。", false},
		} {
			x, _, _ := st.Add(store.Note{Section: store.SectionInbox, Text: n.text, SourceApp: "Safari"})
			_ = st.SetCreatedAt(x.ID, ago)
			if n.done {
				_ = st.SetDone(x.ID, true)
			}
		}
		s := st.Settings()
		s.ColorScheme = "platinum"
		_ = st.SetSettings(s)
		curScheme = "platinum"
		a := newApp(nopSys{}, st)
		a.permAX = true // 对照截图不含权限横幅
		a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
		a.reload()
		return a
	}
	// 参照图在 testdata/platinum（script/platinum-ref/capture.sh 抓取）；并排图与差异汇总 summary.txt 写到 dir。
	var summary strings.Builder
	defer func() { _ = os.WriteFile(filepath.Join(dir, "summary.txt"), []byte(summary.String()), 0o644) }()
	against := func(name string, got *image.RGBA) {
		refPath := filepath.Join("testdata", "platinum", "ref-"+name+"-light.png")
		if _, err := os.Stat(refPath); err != nil { // 没有参照图：只导出原生渲染图
			fmt.Fprintf(&summary, "%-22s 无参照\n", name)
			return
		}
		ref := load(t, refPath)
		ratio, heat := diff(ref, got)
		save(t, filepath.Join(dir, "side-"+name+"-light.png"), sideBySide(ref, got, heat))
		fmt.Fprintf(&summary, "%-22s %6.2f%%\n", name, ratio*100)
	}
	for _, c := range []struct {
		name   string
		mx, my float32
		prep   func(a *app)
		rest   time.Duration // 指针停留时长：550ms 不到提示气泡出现的 600ms
	}{
		{"main-platinum", 379, 2, func(a *app) {}, 550 * time.Millisecond},
		{"pt-clip", 379, 2, func(a *app) { a.switchPage(pageClip); a.reload() }, 550 * time.Millisecond},
		{"pt-tasks", 379, 2, func(a *app) { a.switchPage(pageTasks); a.reload() }, 550 * time.Millisecond},
		{"pt-hover", 190, 180, func(a *app) {}, 550 * time.Millisecond},
		{"pt-checked", 379, 2, func(a *app) { a.chosen.Add(a.notes[0].ID); a.chosen.Add(a.notes[1].ID) }, 550 * time.Millisecond},
		{"pt-search", 379, 2, func(a *app) { a.searchOpen = true }, 550 * time.Millisecond},
		{"pt-menu", 379, 2, func(a *app) { a.menuOpen = true }, 550 * time.Millisecond},
		{"pt-lens", 379, 2, func(a *app) { a.lensOpen = true }, 550 * time.Millisecond},
		{"pt-palette", 379, 2, func(a *app) { a.cmdOpen = true }, 550 * time.Millisecond},
		{"pt-clip2", 379, 2, func(a *app) {
			for _, n := range []store.Note{
				{Text: "brew install --cask toskr", SourceApp: "Terminal"},
				{Text: "周五前把 mygo 原生版对比报告发给团队，附内存与启动耗时。", SourceApp: "Safari"},
				{Text: "https://github.com/egoist/mygo", Kind: "link", SourceApp: "Arc"},
			} {
				n.Section = store.SectionClipboard
				_, _, _ = a.store.Add(n)
			}
			a.switchPage(pageClip)
			a.reload()
		}, 550 * time.Millisecond},
		{"pt-tasks2", 379, 2, func(a *app) {
			for _, s := range []string{"更新 lessons", "整理截图标注需求", "交 mygo 对比报告"} {
				a.store.AddTask(store.Task{Text: s})
			}
			a.switchPage(pageTasks)
			a.taskSub = 1
			a.reload()
		}, 550 * time.Millisecond},
		{"pt-due", 379, 2, func(a *app) {
			for _, s := range []string{"更新 lessons", "整理截图标注需求", "交 mygo 对比报告"} {
				a.store.AddTask(store.Task{Text: s})
			}
			a.switchPage(pageTasks)
			a.taskSub = 1
			a.reload()
			a.openDuePopover(a.tasks[0], time.Date(2026, 11, 11, 12, 0, 0, 0, time.Local))
		}, 550 * time.Millisecond},
		{"pt-preflight", 379, 2, func(a *app) {
			a.checkSend(a.notes[:1])
			a.pfScan()
			a.pf.final = a.pfAssembled()
		}, 550 * time.Millisecond},
		{"pt-tooltip", 338, 33, func(a *app) {}, 1200 * time.Millisecond}, // 停在 ☰ 工具钮上等提示气泡
	} {
		a := mk()
		c.prep(a)
		tt := ui.NewTester(a.panelView, 380, 760)
		tt.SetVibrancy(false)
		tt.Move(c.mx, c.my)
		tt.Frame()
		tt.Advance(300 * time.Millisecond)
		tt.Frame()
		tt.Advance(c.rest - 300*time.Millisecond)
		tt.Frame()
		got := onWhite(tt.Image())
		save(t, filepath.Join(dir, "mygo-"+c.name+"-light.png"), got)
		against(c.name, got)
	}

	// 详情窗与 HUD：没有浏览器参照（要真实窗口事件才能驱动），只导出原生渲染图，对着 index.css 的 Platinum 规则目检。
	a := mk()
	dn, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, SourceApp: "Safari",
		Text: "会议纪要：周五前完成 mygo 原生版对比报告，附内存与启动耗时。\n\n1. 主面板、任务、剪贴逐屏 1:1 对照\n2. 设置窗外壳与控件\n3. HUD 气泡与详情窗"})
	a.detail = detailState{id: dn.ID, pickAnchor: -1, pickEnd: -1}
	a.hudKind, a.hudText, a.hudUndo, a.hudHover = "added", "会议纪要：周五前完成 mygo 原生版对比报告", func() {}, false
	for _, v := range []struct {
		name string
		view func(*ui.Context)
		w, h int
	}{{"pt-detail", a.detailView, 560, 540}, {"pt-hud", a.hudView, 264, 100}} {
		tt := ui.NewTester(v.view, v.w, v.h)
		tt.SetVibrancy(false)
		tt.Move(float32(v.w-1), 2)
		tt.Frame()
		tt.Advance(time.Second)
		tt.Frame()
		save(t, filepath.Join(dir, "mygo-"+v.name+"-light.png"), onWhite(tt.Image()))
	}

	// 最近发送抽屉、横栏布局、任务到期弹层
	a.drawerOpen = true
	dr := ui.NewTester(a.panelView, 380, 760)
	dr.SetVibrancy(false)
	dr.Frame()
	dr.Advance(time.Second)
	dr.Frame()
	save(t, filepath.Join(dir, "mygo-pt-drawer-light.png"), onWhite(dr.Image()))
	a.drawerOpen = false
	a.patchSettings(func(x *store.Settings) { x.SidebarEdge = "bottom" })
	hb := ui.NewTester(a.panelView, 1200, 260)
	hb.SetVibrancy(false)
	hb.Frame()
	hb.Advance(time.Second)
	hb.Frame()
	save(t, filepath.Join(dir, "mygo-pt-hbar-light.png"), onWhite(hb.Image()))
	a.patchSettings(func(x *store.Settings) { x.SidebarEdge = "" })

	// 新手导览
	a.patchSettings(func(x *store.Settings) { x.WelcomeTourSeen = false })
	a.tourOpen = true
	wt := ui.NewTester(a.panelView, 380, 760)
	wt.SetVibrancy(false)
	wt.Frame()
	wt.Advance(time.Second)
	wt.Frame()
	save(t, filepath.Join(dir, "mygo-pt-tour-light.png"), onWhite(wt.Image()))
	a.tourOpen = false
	a.patchSettings(func(x *store.Settings) { x.WelcomeTourSeen = true })

	// 设置窗各页各选项卡（1040×1100，够看到首屏以下的控件）
	a.patchSettings(func(x *store.Settings) { x.MessagesEnabled, x.SecretEnabled, x.SubscriptionsEnabled = true, true, true })
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 1100)
	set.SetVibrancy(false)
	schemeMenuOpen = true // 首页顺带看配色方案下拉弹层
	defer func() { schemeMenuOpen = false }()
	for page := 0; page < 8; page++ {
		for sub := 0; sub < 6; sub++ {
			a.setPage, a.setSub = page, sub
			set.Frame()
			if a.setSub != sub { // 该页没有这么多选项卡
				break
			}
			set.Advance(time.Second)
			set.Frame()
			save(t, filepath.Join(dir, fmt.Sprintf("mygo-pt-set-%d-%d-light.png", page, sub)), onWhite(set.Image()))
		}
	}
}
