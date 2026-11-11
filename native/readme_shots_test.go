package main

import (
	"image"
	"image/color"
	"image/draw"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// README 配图：剪贴 / 笔记 / 今天 三屏并排（2x）。只在设了 TOSKR_SHOT_DIR 时渲染：
//
//	TOSKR_SHOT_DIR=<目录> go test -run TestReadmeShowcase .
func TestReadmeShowcase(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("未设 TOSKR_SHOT_DIR")
	}
	now := time.Date(2026, 11, 11, 14, 30, 0, 0, time.Local)
	day := dayStart(now)
	build := func() *app {
		a, _ := testApp(t)
		a.clock = func() time.Time { return now }
		ago := func(m int) time.Time { return now.Add(-time.Duration(m) * time.Minute) }
		for _, n := range []store.Note{
			{Section: store.SectionClipboard, Text: "panic: runtime error: index out of range [3] with length 3\ngoroutine 1 [running]:\nmain.pick(...)\n\t/app/queue.go:42", SourceApp: "iTerm2", BundleID: "com.googlecode.iterm2", Kind: "code", CreatedAt: ago(2)},
			{Section: store.SectionClipboard, Text: "https://go.dev/blog/range-functions", LinkTitle: "Range Over Function Types - The Go Programming Language", Kind: "link", SourceApp: "Safari", BundleID: "com.apple.Safari", CreatedAt: ago(9)},
			{Section: store.SectionClipboard, Text: "#2563EB", SourceApp: "Figma", CreatedAt: ago(21)},
			{Section: store.SectionClipboard, Text: "日志发到 ops@example.com，机器 10.2.3.18，下午三点前回滚到上一个版本。", SourceApp: "飞书", CreatedAt: ago(34)},
			{Section: store.SectionClipboard, Text: "{\"id\": 1042, \"status\": \"queued\", \"retry\": 2}", SourceApp: "Postman", Kind: "code", CreatedAt: ago(58)},
			{Section: store.SectionClipboard, Text: "把这三段合并成一条，按时间顺序排，保留原话。", SourceApp: "备忘录", CreatedAt: ago(95)},
			{Section: store.SectionInbox, Text: "复现步骤：1. 打开设置 → 账单；2. 切到年付；3. 返回后合计仍是月付金额。", SourceApp: "Linear", Tags: []string{"bug"}, CreatedAt: ago(6)},
			{Section: store.SectionInbox, Text: "func (q *Queue) pick(i int) Card {\n\tif i >= len(q.cards) {\n\t\treturn Card{}\n\t}\n\treturn q.cards[i]\n}", SourceApp: "Cursor", Kind: "code", CreatedAt: ago(12)},
			{Section: store.SectionInbox, Text: "请先指出这段代码里会越界的地方，再给出最小改动的修复，不要重写整个函数。", SourceApp: "备忘录", Title: "代码审查提示词", Tags: []string{"prompt"}, CreatedAt: ago(40)},
			{Section: store.SectionInbox, Text: "设计评审结论：批量条独占一行；筛选在选择态隐藏；两位数计数不换行。", SourceApp: "Slack", CreatedAt: ago(75)},
		} {
			a.store.Add(n)
		}
		a.patchSettings(func(x *store.Settings) { x.CalendarOn = true })
		a.calEvents = []macos.CalendarEvent{{ID: "e1", Title: "周会", StartMs: day.Add(15 * time.Hour).UnixMilli(), EndMs: day.Add(16 * time.Hour).UnixMilli(), CalendarColor: "#2a78d6", CalendarTitle: "工作"}}
		a.store.AddTask(store.Task{Text: "写 1.0 更新说明", DueAt: day.Add(16 * time.Hour), DurationMin: 60})
		a.store.AddTask(store.Task{Text: "回复设计评审", DueAt: day.Add(17*time.Hour + 30*time.Minute)})
		a.store.AddTask(store.Task{Text: "复核账单提醒逻辑", DueAt: now.Add(-26 * time.Hour), Priority: "high"})
		a.store.AddTask(store.Task{Text: "整理截图标注需求"})
		a.reload()
		return a
	}
	const w, h, scale, gap, pad = 380, 760, 2, 28, 44
	for _, dark := range []bool{false, true} {
		bg := color.RGBA{0xe9, 0xeb, 0xef, 0xff}
		if dark {
			bg = color.RGBA{0x12, 0x13, 0x16, 0xff}
		}
		out := image.NewRGBA(image.Rect(0, 0, (w*3+gap*2+pad*2)*scale, (h+pad*2)*scale))
		draw.Draw(out, out.Bounds(), &image.Uniform{bg}, image.Point{}, draw.Src)
		for i, page := range []int{pageClip, pageNotes, pageTasks} {
			a := build()
			a.switchPage(page)
			if page == pageTasks {
				a.taskSub = 0
			}
			v := ui.NewTester(a.panelView, w, h)
			v.SetScale(scale)
			v.SetDark(dark)
			v.Frame()
			v.Frame()
			img := v.Image()
			at := image.Pt((pad+i*(w+gap))*scale, pad*scale)
			draw.Draw(out, img.Bounds().Add(at), img, image.Point{}, draw.Src)
		}
		save(t, filepath.Join(dir, "toskr-showcase-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), out)
	}
}
