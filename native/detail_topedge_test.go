package main

import (
	"cmp"
	"image"
	"image/color"
	"image/draw"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

const edgeLong = "## 一、结论\n\n详情窗当前的信息层次不足：来源、时间、字数挤在同一行 10pt 灰字里，新用户看不出这扇窗能做什么。本轮先定结构，再定视觉。\n\n## 二、待办\n\n1. 头部拆成「身份」与「元信息」两层，标题缺省时取首行\n2. 底部坞改为主操作全宽，次操作用图标格表达\n3. 划词工具条保留现有能力，补充「加入化名词典」的说明\n4. 短内容时在正文下方露出能力卡，超过一屏自动隐藏\n\n## 三、风险\n\n- 坞变高后长文可读区域减少约 46pt\n- 图标格在英文界面下标签可能过长，需要实测\n- 首次引导只出现一次，需要可在设置里重新打开\n\n以上意见请在周四前回复；确认后进入原生实现与浅深色截图走查。"

// edgeApp：一张三倍长的卡（够滚动），详情窗状态清零。
func edgeApp(t *testing.T) (*app, store.Note) {
	t.Helper()
	a, _ := testApp(t, edgeLong+"\n\n"+edgeLong+"\n\n"+edgeLong)
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	n := a.store.Notes()[0]
	a.detailText = n.Text
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	return a, n
}

// edgeScroll：把正文滚下去 dy，等滚动与过渡落定。
func edgeScroll(dt *ui.Tester, w, h int, dy float32) {
	dt.Frame()
	dt.Frame()
	dt.Frame()
	if dy > 0 {
		dt.Scroll(float32(w)/2, float32(h)/2, 0, dy)
	}
	dt.Advance(400 * time.Millisecond)
	dt.Frame()
	dt.Frame()
}

// zoneDiff：两张图在第 y0…y1 行、第 x0…x1 列之间逐像素（含透明度）最多相差多少。
func zoneDiff(a, b *image.RGBA, x0, x1, y0, y1 int) int {
	d := 0
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			p, q := a.RGBAAt(x, y), b.RGBAAt(x, y)
			for _, v := range [4]int{int(p.R) - int(q.R), int(p.G) - int(q.G), int(p.B) - int(q.B), int(p.A) - int(q.A)} {
				d = max(d, v, -v)
			}
		}
	}
	return d
}

// 正文滚到标题栏 / 标签行底下：那一带和没滚动时一模一样（标题、标签不和正文叠字，顶部晕光也还在）。
// 第 0–2 行是阅读进度线，不比（编辑态没有进度线，从第 0 行那条描边比起）。标题栏收起时垫层跟着收起，正文照常露出来。
func TestDetailTopEdgeCoversScrolledText(t *testing.T) {
	defer func() { curScheme = "default" }()
	tags := func(a *app, n store.Note) {
		_ = a.store.SetTitle(n.ID, "关于 Toskr 1.0.4 详情窗重设计的评审意见与后续排期")
		_ = a.store.SetTags(n.ID, []string{"设计评审", "详情窗", "v1.0.4", "待确认", "原生版", "mygo", "交互", "排期"})
		a.detail.tagsOpen = true
	}
	for _, tc := range []struct {
		name  string
		w     int
		dark  bool
		setup func(a *app, n store.Note)
		x1    int  // 只比到这一列（0 = 整行）
		top   bool // 从第 0 行比起（默认从第 3 行：前三行是阅读进度线）
	}{
		{name: "只有来源与时间", w: 560},
		{name: "深色", w: 560, dark: true},
		{name: "带标题", w: 560, setup: func(a *app, n store.Note) { _ = a.store.SetTitle(n.ID, "周会纪要与对比报告的排期") }},
		{name: "标签行展开", w: 560, setup: tags},
		{name: "标签行折成两行 + 深色", w: 380, dark: true, setup: tags},
		{name: "标签顶到上限折成一摞（比顶部晕光还高）", w: 380, setup: func(a *app, n store.Note) {
			var long []string
			for i := range store.TagMaxCount {
				long = append(long, strings.Repeat("标签很长", 6)[:3*23]+itoa(i))
			}
			_ = a.store.SetTags(n.ID, long)
			a.detail.tagsOpen = true
		}},
		// 「编辑中」那枚呼吸点一直在变，只比它左边；编辑态没有进度线，从最上面那条描边（第 0 行）比起
		{name: "编辑态", w: 560, x1: 200, top: true, setup: func(a *app, n store.Note) { a.enterDetailEdit(n) }},
		{name: "选词态", w: 560, setup: func(a *app, n store.Note) { a.detail.pick = true }},
		{name: "关掉窗内玻璃", w: 560, setup: func(a *app, n store.Note) { a.patchSettings(func(s *store.Settings) { s.Glass = "none" }) }},
		{name: "Platinum", w: 560, setup: func(a *app, n store.Note) {
			tags(a, n)
			a.patchSettings(func(s *store.Settings) { s.ColorScheme = "platinum" })
			curScheme = "platinum"
		}},
	} {
		a, n := edgeApp(t)
		if tc.setup != nil {
			tc.setup(a, n)
		}
		dt := ui.NewTester(a.detailView, tc.w, 540)
		dt.SetDark(tc.dark)
		edgeScroll(dt, tc.w, 540, 0)
		rest, h := dt.Image(), int(a.detail.sel.hdr.H)
		if h < 20 {
			t.Fatalf("%s：量不到标题栏高度 %v", tc.name, a.detail.sel.hdr)
		}
		edgeScroll(dt, tc.w, 540, 160)
		if a.detail.scroll.Y < 100 {
			t.Fatalf("%s：正文没滚动 %v", tc.name, a.detail.scroll.Y)
		}
		scrolled := dt.Image()
		y0 := 3
		if tc.top {
			y0 = 0
		}
		if d := zoneDiff(rest, scrolled, 0, cmp.Or(tc.x1, tc.w), y0, h); d > 3 {
			t.Fatalf("%s：正文滚到标题栏底下后，标题栏那一带（高 %d）应和没滚动时一样，最多差了 %d", tc.name, h, d)
		}
		// 指针离窗，标题栏收起：垫层一起收起，正文露出来（标签折成一摞时正文还没滚到最上面那一行，不验）
		if curScheme == "default" && !a.detail.edit && !a.detail.pick && h < 100 {
			dt.Move(-20, -20)
			edgeScroll(dt, tc.w, 540, 0)
			// 只看标题栏左侧那格空白（红绿灯的占位，x 20…62、第 3…38 行）：垫层还在的话这里和没滚动时一样
			if d := zoneDiff(rest, dt.Image(), 20, 62, 3, 38); d < 60 {
				t.Fatalf("%s：标题栏收起后那一带应露出正文，只差了 %d", tc.name, d)
			}
		}
		curScheme = "default"
	}
}

// 毛玻璃窗（默认）：窗口底色是半透明的，垫层照样盖得住——标题栏左侧那格空白里没有透出正文的字。
func TestDetailTopEdgeOnVibrantWindow(t *testing.T) {
	for _, dark := range []bool{false, true} {
		a, _ := edgeApp(t)
		dt := ui.NewTester(a.detailView, 560, 540)
		dt.SetDark(dark)
		dt.SetVibrancy(true)
		edgeScroll(dt, 560, 540, 160)
		img, h := dt.Image(), int(a.detail.sel.hdr.H)
		if img.RGBAAt(8, 300).A == 255 {
			t.Fatal("应是半透明底色的窗（SetVibrancy）")
		}
		// 标题栏左侧那格是红绿灯的占位，没有别的东西；正文从 x=20 起。这一格里每一行都该是一个颜色
		row := image.NewRGBA(img.Rect)
		for y := 3; y < h; y++ {
			for x := 20; x < 62; x++ {
				row.SetRGBA(x, y, img.RGBAAt(20, y))
			}
		}
		if d := zoneDiff(img, row, 20, 62, 3, h); d > 1 {
			t.Fatalf("dark=%v：标题栏底下透出了正文，同一行里最多差了 %d", dark, d)
		}
	}
}

// 垫层只是一层底色：不挡点击、不挡划选。选词态下滚到渐隐区里的键帽照样点得中。
func TestDetailTopEdgePassesClicks(t *testing.T) {
	a, n := edgeApp(t)
	a.detail.pick = true
	dt := ui.NewTester(a.detailView, 560, 540)
	edgeScroll(dt, 560, 540, 0)
	h := a.detail.sel.hdr.H
	segs := a.segments(n.Text)
	for range 30 { // 每次往下滚 5，直到有一枚键帽的中心落进渐隐区
		edgeScroll(dt, 560, 540, 5)
		for i, sg := range segs {
			r, ok := dt.Find(sg.text)
			if !sg.word || !ok || r.Y+r.H/2 < h+3 || r.Y+r.H/2 > h+topEdgeFade-3 {
				continue
			}
			dt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
			dt.Frame()
			if got := a.pickedText(n.Text); got != sg.text {
				t.Fatalf("渐隐区里的键帽「%s」（第 %d 块，%v）应点得中，选中的是 %q", sg.text, i, r, got)
			}
			return
		}
	}
	t.Fatalf("没有键帽滚进渐隐区（标题栏高 %v，滚动 %v）", h, a.detail.scroll.Y)
}

// 浅 / 深色截图目检（TOSKR_SHOT_DIR 落盘）：正文滚到标题栏 / 标签行下面时的顶部渐隐底。
func TestDetailTopEdgeShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("设 TOSKR_SHOT_DIR 才出图")
	}
	defer func() { curScheme = "default" }()
	tags := func(a *app, n store.Note) {
		_ = a.store.SetTitle(n.ID, "关于 Toskr 1.0.4 详情窗重设计的评审意见与后续排期（含设计、研发、测试三方结论）")
		_ = a.store.SetTags(n.ID, []string{"设计评审", "详情窗", "v1.0.4", "待确认", "原生版", "mygo", "交互", "排期"})
		a.detail.tagsOpen = true
	}
	type scene struct {
		name     string
		w        int
		scroll   float32
		setup    func(a *app, n store.Note)
		light    bool    // 只出浅色
		vibrancy float32 // 毛玻璃窗：底色半透明，出图时垫一张花底当桌面；值是花底的鲜艳程度（1 = 最坏情况，系统材质实际会把它压淡）
	}
	scenes := []scene{
		{name: "edge-rest", w: 560, scroll: 0},
		{name: "edge-plain", w: 560, scroll: 160},
		{name: "edge-ramp", w: 560, scroll: 4},
		{name: "edge-titled", w: 560, scroll: 160, setup: func(a *app, n store.Note) { _ = a.store.SetTitle(n.ID, "周会纪要与对比报告的排期") }},
		{name: "edge-tags", w: 560, scroll: 160, setup: tags},
		{name: "edge-tags-380", w: 380, scroll: 160, setup: tags},
		{name: "edge-edit", w: 560, scroll: 160, setup: func(a *app, n store.Note) { a.enterDetailEdit(n) }},
		{name: "edge-pick", w: 560, scroll: 160, setup: func(a *app, n store.Note) { a.detail.pick = true }},
		{name: "edge-find", w: 560, scroll: 160, setup: func(a *app, n store.Note) {
			a.openDetailFind()
			a.detail.findQuery = "坞"
		}},
		{name: "edge-noglass", w: 560, scroll: 160, setup: func(a *app, n store.Note) {
			tags(a, n)
			a.patchSettings(func(s *store.Settings) { s.Glass = "none" })
		}},
		{name: "edge-vibrancy-rest", w: 560, scroll: 0, vibrancy: 0.4, setup: tags},
		{name: "edge-vibrancy", w: 560, scroll: 160, vibrancy: 0.4, setup: tags},
		{name: "edge-vibrancy-vivid-rest", w: 560, scroll: 0, vibrancy: 1, setup: tags},
		{name: "edge-vibrancy-vivid", w: 560, scroll: 160, vibrancy: 1, setup: tags},
		{name: "edge-platinum", w: 560, scroll: 160, light: true, setup: func(a *app, n store.Note) {
			tags(a, n)
			a.patchSettings(func(s *store.Settings) { s.ColorScheme = "platinum" })
			curScheme = "platinum"
		}},
	}
	for _, sc := range scenes {
		for _, dark := range []bool{false, true} {
			if dark && sc.light {
				continue
			}
			a, n := edgeApp(t) // 每张图一扇新窗：滚动量不带到下一张
			if sc.setup != nil {
				sc.setup(a, n)
			}
			dt := ui.NewTester(a.detailView, sc.w, 540)
			dt.SetDark(dark)
			if sc.vibrancy > 0 {
				dt.SetVibrancy(true)
			}
			edgeScroll(dt, sc.w, 540, sc.scroll)
			var img image.Image = dt.Image()
			if sc.vibrancy > 0 {
				img = overDesktop(dt.Image(), sc.vibrancy, dark)
			}
			save(t, filepath.Join(dir, sc.name+"-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), img)
		}
		curScheme = "default"
	}
}

// overDesktop：把半透明的窗口画面垫到一张花底上（模拟毛玻璃窗后面被系统模糊过的桌面）。
// vivid = 花底的鲜艳程度：1 是原色，小于 1 时按系统材质的做法往浅 / 深色的中性灰压。
func overDesktop(win *image.RGBA, vivid float32, dark bool) image.Image {
	b := win.Bounds()
	out := image.NewRGBA(b)
	base := float32(236)
	if dark {
		base = 34
	}
	tone := func(v float64) uint8 { return uint8(base + (float32(v)-base)*vivid) }
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			fx, fy := float64(x-b.Min.X)/float64(b.Dx()), float64(y-b.Min.Y)/float64(b.Dy())
			out.Set(x, y, color.RGBA{tone(70 + 150*fx), tone(120 + 80*fy), tone(210 - 120*fx*fy), 255})
		}
	}
	draw.Draw(out, b, win, b.Min, draw.Over)
	return out
}
