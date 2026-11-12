package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// README 配图的素材：剪贴 / 笔记（多选待发）/ 今天 三屏各一张（3x，浅深两色），
// 由 script/readme-showcase/build.sh 合成为介绍图（同时把用到的应用图标存到 <目录>/icons）。只在设了 TOSKR_SHOT_DIR 时渲染。
func TestReadmeShowcase(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("未设 TOSKR_SHOT_DIR")
	}
	oldAsync, oldPNG := appIconAsync, appIconPNG
	appIconAsync, appIconPNG = func(f func()) { f() }, bundleIconPNG(filepath.Join(dir, "icons")) // 本机装着的应用取真实图标；没装的不画
	t.Cleanup(func() { appIconAsync, appIconPNG = oldAsync, oldPNG })
	real := time.Now()
	now := time.Date(real.Year(), real.Month(), real.Day(), 14, 30, 0, 0, time.Local) // 今天页的时钟固定在 14:30；卡片时间相对真实时刻
	day := dayStart(now)
	build := func() *app {
		a, _ := testApp(t)
		a.clock = func() time.Time { return now }
		ago := func(m int) time.Time { return real.Add(-time.Duration(m) * time.Minute) }    // 笔记页按真实时刻算「多久前」
		clipAgo := func(m int) time.Time { return now.Add(-time.Duration(m) * time.Minute) } // 剪贴页按 a.clock 算
		for _, n := range []store.Note{
			{Section: store.SectionClipboard, Text: "panic: runtime error: index out of range [3] with length 3\ngoroutine 1 [running]:\nmain.pick(...)\n\t/app/queue.go:42", SourceApp: "iTerm2", BundleID: "com.googlecode.iterm2", Kind: "code", CreatedAt: clipAgo(2)},
			{Section: store.SectionClipboard, Text: "https://go.dev/blog/range-functions", LinkTitle: "Range Over Function Types - The Go Programming Language", Kind: "link", SourceApp: "Safari", BundleID: "com.apple.Safari", CreatedAt: clipAgo(9)},
			{Section: store.SectionClipboard, Text: "#2563EB", SourceApp: "Figma", BundleID: "com.figma.Desktop", CreatedAt: clipAgo(21)},
			{Section: store.SectionClipboard, Text: "日志发到 ops@example.com，机器 10.2.3.18，下午三点前回滚到上一个版本。", SourceApp: "飞书", BundleID: "com.electron.lark", CreatedAt: clipAgo(34)},
			{Section: store.SectionClipboard, Text: "{\"id\": 1042, \"status\": \"queued\", \"retry\": 2}", SourceApp: "Postman", BundleID: "com.postmanlabs.mac", Kind: "code", CreatedAt: clipAgo(58)},
			{Section: store.SectionClipboard, Text: "把这三段合并成一条，按时间顺序排，保留原话。", SourceApp: "备忘录", BundleID: "com.apple.Notes", CreatedAt: clipAgo(95)},
			{Section: store.SectionInbox, Text: "复现步骤：1. 打开设置 → 账单；2. 切到年付；3. 返回后合计仍是月付金额。", SourceApp: "Linear", BundleID: "com.linear", Tags: []string{"bug"}, CreatedAt: ago(6)},
			{Section: store.SectionInbox, Text: "func (q *Queue) pick(i int) Card {\n\tif i >= len(q.cards) {\n\t\treturn Card{}\n\t}\n\treturn q.cards[i]\n}", SourceApp: "Cursor", BundleID: "com.todesktop.230313mzl4w4u92", Kind: "code", CreatedAt: ago(12)},
			{Section: store.SectionInbox, Text: "请先指出这段代码里会越界的地方，再给出最小改动的修复，不要重写整个函数。", SourceApp: "Safari", BundleID: "com.apple.Safari", Title: "代码审查提示词", Tags: []string{"prompt"}, CreatedAt: ago(40)},
			{Section: store.SectionInbox, Text: "设计评审结论：批量条独占一行；筛选在选择态隐藏；两位数计数不换行。", SourceApp: "Slack", BundleID: "com.tinyspeck.slackmacgap", CreatedAt: ago(75)},
		} {
			a.store.Add(n)
		}
		a.patchSettings(func(x *store.Settings) { x.CalendarOn = true })
		a.calEvents = []macos.CalendarEvent{{ID: "e1", Title: "周会", StartMs: day.Add(15 * time.Hour).UnixMilli(), EndMs: day.Add(16 * time.Hour).UnixMilli(), CalendarColor: "#2a78d6", CalendarTitle: "工作"}}
		a.store.AddTask(store.Task{Text: "写 1.0 更新说明", DueAt: day.Add(16 * time.Hour), DurationMin: 60})
		a.store.AddTask(store.Task{Text: "回复设计评审", DueAt: day.Add(17*time.Hour + 30*time.Minute)})
		a.store.AddTask(store.Task{Text: "复核账单提醒逻辑", DueAt: now.Add(-26 * time.Hour), Priority: "high"})
		a.store.AddTask(store.Task{Text: "整理截图标注需求"})
		a.target = macos.FrontApp{PID: 42, BundleID: "com.anthropic.claudefordesktop", Name: "Claude"}
		a.reload()
		return a
	}
	const w, h, scale = 380, 760, 3
	for _, dark := range []bool{false, true} {
		for name, page := range map[string]int{"clip": pageClip, "notes": pageNotes, "today": pageTasks} {
			a := build()
			a.switchPage(page)
			switch page {
			case pageTasks:
				a.taskSub = 0
			case pageNotes:
				for _, n := range a.notes[:min(len(a.notes), 3)] {
					a.chosen.Add(n.ID)
				}
			}
			v := ui.NewTester(a.panelView, w, h)
			v.SetScale(scale)
			v.SetDark(dark)
			for range 6 { // 页签等有过渡动画：推进时钟让它们走完再拍
				a.drainUpdates()
				v.Frame()
				v.Advance(400 * time.Millisecond)
			}
			v.Frame()
			save(t, filepath.Join(dir, name+"-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), v.Image())
		}
	}
}

// bundleIconPNG：无窗口测试里取不到 AppKit 的图标，改为直接把应用包里的 .icns 转成 PNG（mdfind 定位 + sips 转换）。
func bundleIconPNG(tmp string) func(string) []byte {
	return func(bundle string) []byte {
		out, _ := exec.Command("mdfind", "kMDItemCFBundleIdentifier == '"+bundle+"'").Output()
		app, _, _ := strings.Cut(string(out), "\n")
		if app == "" {
			return nil
		}
		name, _ := exec.Command("/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIconFile", filepath.Join(app, "Contents/Info.plist")).Output()
		icns := filepath.Join(app, "Contents/Resources", strings.TrimSuffix(strings.TrimSpace(string(name)), ".icns")+".icns")
		if _, err := os.Stat(icns); err != nil {
			all, _ := filepath.Glob(filepath.Join(app, "Contents/Resources/*.icns"))
			if len(all) == 0 {
				return nil
			}
			icns = all[0]
		}
		_ = os.MkdirAll(tmp, 0o755)
		dst := filepath.Join(tmp, bundle+".png")
		if exec.Command("sips", "-s", "format", "png", "-Z", "256", icns, "--out", dst).Run() != nil {
			return nil
		}
		raw, _ := os.ReadFile(dst)
		return raw
	}
}
