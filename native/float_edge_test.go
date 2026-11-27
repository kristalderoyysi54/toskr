package main

import (
	"image"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 主题（Platinum）生效时 floatEdge 不接管，调用方走原画法；默认外观下接管。
func TestFloatEdgeDefersToTheme(t *testing.T) {
	defer func() { curScheme = "default" }()
	for _, v := range []struct {
		scheme string
		want   bool
	}{{"default", true}, {"platinum", false}} {
		curScheme = v.scheme
		var got bool
		tt := ui.NewTester(func(c *ui.Context) { got = floatEdge(ui.Box(c).Size(40, 20), tok(c)) }, 60, 40)
		tt.Frame()
		if got != v.want {
			t.Errorf("%s: floatEdge = %v，应为 %v", v.scheme, got, v.want)
		}
	}
}

// 图片窥视窗：图外那圈留白必须是透明的（窗口根默认铺不透明的主题底色，会成一个直角色框），
// 且投影到窗口下缘时已基本衰减完（留白不够会被窗口切出一条线）。
func TestPeekMarginIsClearAndFitsShadow(t *testing.T) {
	a, _ := testApp(t)
	a.peekImg = ui.NewBitmap(image.NewRGBA(image.Rect(0, 0, 160, 100)))
	for _, dark := range []bool{false, true} {
		pk := ui.NewTester(a.peekView, 160+2*peekPad, 100+2*peekPad)
		pk.SetDark(dark)
		pk.Frame()
		pk.Frame()
		img := pk.Image()
		w, h := img.Bounds().Dx(), img.Bounds().Dy()
		if c := img.RGBAAt(0, 0); c.A != 0 {
			t.Errorf("dark=%v 留白角应透明，得到 %v", dark, c)
		}
		if c := img.RGBAAt(w/2, h-1); c.A > 8 {
			t.Errorf("dark=%v 窗口下缘还剩投影 alpha=%d（>8 会看出一条被切的线）", dark, c.A)
		}
	}
}

// 浅 / 深色截图目检（TOSKR_SHOT_DIR 落盘，2×）：用双线边的各处浮层 + 列表卡抬起态。
func TestFloatEdgeShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	a, g := floatShotApp(t)
	for _, dark := range []bool{false, true} {
		floatShots(t, a, g, dir, "default", dark, true)
	}
}

// 各配色方案 × 浅 / 深色下的浮层填充色与两条线（TOSKR_SHOT_DIR 落盘，2×）。
func TestFloatEdgeSchemeShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	a, g := floatShotApp(t)
	defer func() { curScheme = "default" }()
	for _, scheme := range []string{"paper", "matcha", "sakura", "fog"} {
		st := a.store.Settings()
		st.ColorScheme = scheme
		_ = a.store.SetSettings(st)
		curScheme = scheme
		for _, dark := range []bool{false, true} {
			floatShots(t, a, g, dir, scheme, dark, false)
		}
	}
}

func floatShotApp(t *testing.T) (*app, noteGroup) {
	t.Helper()
	a, _, sec := peekApp(t)
	for _, s := range []string{"把这段改写得更简洁，保留原意", "代码评审：按严重程度列出问题", "翻译成英文，术语不翻", "整理会议纪要并列出待办"} {
		if _, err := a.addClip(core.ClipEvent{Text: s, Source: macos.FrontApp{Name: "Safari"}}); err != nil {
			t.Fatal(err)
		}
	}
	a.reload()
	g := a.noteGroups[0]
	for _, x := range a.noteGroups {
		if x.sec.ID == sec {
			g = x
		}
	}
	return a, g
}

// floatShots 落盘一种配色 × 一种深浅下的各处浮层；all=false 只出随方案变色的三处（剪贴卡悬停、标题栏菜单、分组速览）。
func floatShots(t *testing.T, a *app, g noteGroup, dir, scheme string, dark, all bool) {
	t.Helper()
	tag := scheme + "-" + map[bool]string{false: "light", true: "dark"}[dark]
	panel := func(h int) *ui.Tester {
		v := ui.NewTester(a.panelView, 360, h)
		v.SetScale(2)
		v.SetDark(dark)
		v.Frame()
		return v
	}
	settle := func(v *ui.Tester) {
		v.Frame()
		v.Advance(600 * time.Millisecond)
		v.Frame()
	}
	hover := func(v *ui.Tester, s string) {
		r, ok := v.Find(s)
		if !ok {
			t.Fatalf("%s: 找不到 %q：%v", tag, s, v.Texts())
		}
		v.Move(r.X+r.W/2, r.Y+r.H/2)
		v.Frame()
		v.Advance(350 * time.Millisecond) // 够浮条淡入，又不到提示气泡弹出
		v.Frame()
	}
	shot := func(name string, v *ui.Tester) { save(t, filepath.Join(dir, "fe-"+name+"-"+tag+".png"), v.Image()) }

	a.switchPage(pageClip)
	a.reload()
	v := panel(420)
	hover(v, "翻译成英文，术语不翻") // 第二张：整卡在视口内
	shot("clip", v)

	a.switchPage(pageNotes)
	a.foldAllSections(true)
	a.reload()
	a.menuOpen = true
	v = panel(420)
	settle(v)
	shot("menu", v)
	a.menuOpen = false

	a.openGroupPeek(g, ui.Rect{Y: 120, W: 300, H: 20})
	pv := ui.NewTester(a.groupPeekView, gpW+2*gpPad, gpHeight(len(g.open)))
	pv.SetScale(2)
	pv.SetDark(dark)
	settle(pv)
	shot("gp", pv)
	a.closeGroupPeek("截图", false)
	if !all {
		return
	}

	a.foldAllSections(false)
	a.reload()
	v = panel(520)
	hover(v, "生成 SQL 并解释")
	shot("rowtools", v)

	for _, n := range a.notes {
		if strings.Contains(n.Text, "压缩成三句话") || strings.Contains(n.Text, "改写得更口语") {
			a.chosen.Add(n.ID)
		}
	}
	v = panel(520)
	settle(v)
	shot("selbar", v)
	a.chosen.Clear()

	src := image.NewRGBA(image.Rect(0, 0, 240, 150))
	for i := 0; i < len(src.Pix); i += 4 {
		src.Pix[i], src.Pix[i+1], src.Pix[i+2], src.Pix[i+3] = uint8(90+i/4%240/3), 120, 190, 255
	}
	a.peekImg = ui.NewBitmap(src)
	pk := ui.NewTester(a.peekView, 240+2*peekPad, 150+2*peekPad)
	pk.SetScale(2)
	pk.SetDark(dark)
	settle(pk)
	shot("peek", pk)

	for _, h := range []struct {
		name string
		undo func()
	}{{"hud-balloon", func() {}}, {"hud-pill", nil}} {
		a.hudKind, a.hudText, a.hudUndo, a.hudHover, a.hudAt = "added", "会议纪要：周五前完成对比报告", h.undo, false, time.Time{}
		hv := ui.NewTester(a.hudView, hudW, hudH)
		hv.SetScale(2)
		hv.SetDark(dark)
		settle(hv)
		shot(h.name, hv)
	}
	a.hudKind, a.hudUndo = "", nil

	var lines []string
	for i := range 12 {
		lines = append(lines, "第"+itoa(i)+"行内容，供划词工具条定位")
	}
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: strings.Join(lines, "\n"), SourceApp: "Safari"})
	dt := detailTester(t, a, n)
	dt.SetScale(2)
	dt.SetDark(dark)
	a.enterDetailEdit(n)
	dt.Frame()
	a.detail.editSel = [2]int{64, 70}
	for range 6 {
		dt.Frame()
	}
	dt.Advance(400 * time.Millisecond)
	dt.Frame()
	if !dt.HasText("已选 6 字") {
		t.Fatalf("%s: 划词工具条没出现：%v", tag, dt.Texts())
	}
	shot("detail-selbar", dt)
	a.detail = detailState{}
	a.store.Delete(n.ID)

	save(t, filepath.Join(dir, "fe-drag-"+tag+".png"), renderDragPreview("代码评审：按严重程度列出问题", 3, dark))
}
