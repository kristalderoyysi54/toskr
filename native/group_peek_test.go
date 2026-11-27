package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func peekApp(t *testing.T) (*app, *ui.Tester, string) {
	a, tt := testApp(t)
	sec := a.store.AddSection("提示词")
	for _, x := range a.store.Sections() {
		if x.ID == sec {
			x.KeepAfterSend = true // 发送后留在原位：用例里能给出发送次数
			_ = a.store.UpdateSection(x)
		}
	}
	for i, s := range []string{"代码审查清单", "压缩成三句话", "翻译成英文，语气自然", "改写得更口语", "生成 SQL 并解释"} {
		n, _, _ := a.store.Add(store.Note{Section: sec, Text: s, SourceApp: "Arc"})
		for range i {
			_ = a.store.MarkSent([]string{n.ID}, time.Now())
		}
	}
	a.store.AddSection("空组")
	a.switchPage(pageNotes)
	a.foldAllSections(true)
	tt.Frame()
	tt.Frame()
	return a, tt, sec
}

// 合上的分组：悬停出选中浅底，停留 0.4 秒弹速览；展开的分组、空分组、指针没动时不弹。
func TestGroupPeekHoverDelay(t *testing.T) {
	a, tt, sec := peekApp(t)
	r, ok := tt.Find("提示词")
	if !ok {
		t.Fatal(tt.Texts())
	}
	hover := func(r ui.Rect) {
		tt.Move(r.X+r.W/2, r.Y+r.H/2)
		tt.Frame()
	}
	hover(r)
	if a.gp.sec != "" || a.gp.arm != sec {
		t.Fatalf("刚悬停只计时，不弹：sec=%q arm=%q", a.gp.sec, a.gp.arm)
	}
	tt.Advance(gpDelay + 10*time.Millisecond)
	tt.Frame()
	if a.gp.sec != sec {
		t.Fatal("停留 0.4 秒应弹出")
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		for _, dark := range []bool{false, true} {
			tt.SetDark(dark)
			a.invalidateAll()
			tt.Frame()
			tt.Advance(200 * time.Millisecond)
			tt.Frame()
			save(t, filepath.Join(dir, "group-peek-head-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), tt.Image())
		}
		tt.SetDark(false)
		tt.Frame()
	}
	if _, items := a.gpNotes(); len(items) != 5 {
		t.Fatalf("应列出 5 条，实际 %d", len(items))
	}
	a.closeGroupPeek("测试", true)
	tt.Advance(2 * time.Second)
	tt.Frame()
	tt.Advance(time.Second)
	tt.Frame() // 指针一直没动：不算悬停，不重新计时
	if a.gp.sec != "" || a.gp.arm != "" {
		t.Fatalf("指针没动不应再弹：sec=%q arm=%q", a.gp.sec, a.gp.arm)
	}
	e, _ := tt.Find("空组")
	hover(e)
	tt.Advance(time.Second)
	tt.Frame()
	if a.gp.sec != "" {
		t.Fatal("空分组不弹")
	}
	tt.Advance(2 * time.Second)
	a.foldAllSections(false)
	tt.Frame()
	r, _ = tt.Find("提示词")
	hover(r)
	tt.Advance(time.Second)
	tt.Frame()
	if a.gp.sec != "" {
		t.Fatal("展开的分组不弹")
	}
}

// 弹框内容：单行列表 + 只搜这一组 + 点一条发送并收起（紧跟的第二下不再发）。
func TestGroupPeekViewSearchAndSend(t *testing.T) {
	a, _, sec := peekApp(t)
	g := a.noteGroups[0]
	for _, x := range a.noteGroups {
		if x.sec.ID == sec {
			g = x
		}
	}
	a.openGroupPeek(g, ui.Rect{Y: 120, W: 300, H: 20})
	pv := ui.NewTester(a.groupPeekView, gpW+2*gpPad, gpHeight(len(g.open)))
	pv.Frame()
	for _, s := range []string{"代码审查清单", "生成 SQL 并解释", "↵ 发送"} {
		if !pv.HasText(s) {
			t.Fatalf("缺少 %q：%v", s, pv.Texts())
		}
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		for _, dark := range []bool{false, true} {
			pv.SetDark(dark)
			a.invalidateAll()
			pv.Frame()
			pv.Advance(time.Second)
			pv.Frame()
			save(t, filepath.Join(dir, "group-peek-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), pv.Image())
		}
		pv.SetDark(false)
		pv.Frame()
	}
	pv.Key(0, ui.KeyDown)
	pv.Key(0, ui.KeyDown)
	pv.Key(0, ui.KeyUp)
	pv.Frame()
	if a.gp.cursor != 1 {
		t.Fatalf("↑↓ 移动选中项，实际 %d", a.gp.cursor)
	}
	pv.Type("sql")
	pv.Frame()
	if _, items := a.gpNotes(); len(items) != 1 || items[0].Text != "生成 SQL 并解释" {
		t.Fatalf("搜索应只剩 1 条：%v", pv.Texts())
	}
	if pv.HasText("代码审查清单") {
		t.Fatal("不匹配的应滤掉")
	}
	for range 3 {
		pv.Key(0, ui.KeyBackspace)
	}
	pv.Frame()
	if _, items := a.gpNotes(); len(items) != 5 || !pv.HasText("代码审查清单") {
		t.Fatalf("清空搜索应恢复全部：%d %v", len(items), pv.Texts())
	}
	pv.Type("sql")
	pv.Frame()
	if err := pv.Click("生成 SQL 并解释"); err != nil {
		t.Fatal(err)
	}
	if a.gp.sec != "" || a.quickSentID == "" {
		t.Fatalf("点一条应发送并收起：sec=%q sent=%q", a.gp.sec, a.quickSentID)
	}
	pv.Frame() // 收起后再出一帧：不画内容、不取焦点
	if a.gp.focused || pv.HasText("↵ 发送") {
		t.Fatal("收起后的弹框不应再画内容或取焦点")
	}
}

func TestGroupPeekFrame(t *testing.T) {
	wa := mygo.Rectangle{X: 0, Y: 25, Width: 1440, Height: 875}
	h := gpHeight(5)
	if f := gpFrame(mygo.Rectangle{X: 1060, Y: 100, Width: 380, Height: 720}, wa, 200, h); f.X+f.Width > 1060+gpPad || f.Y != 100+200-gpPad-4 {
		t.Fatalf("右侧停靠：弹框在面板左边、顶边对齐分组头：%+v", f)
	}
	if f := gpFrame(mygo.Rectangle{X: 0, Y: 100, Width: 380, Height: 720}, wa, 200, h); f.X < 380-gpPad {
		t.Fatalf("面板贴屏幕左边：改到右侧：%+v", f)
	}
	if f := gpFrame(mygo.Rectangle{X: 1060, Y: 300, Width: 380, Height: 600}, wa, 590, h); f.Y+f.Height > wa.Y+wa.Height {
		t.Fatalf("靠底的分组：收进工作区：%+v", f)
	}
}

// 弹框行：右键是卡片菜单（删除生效）；带图的行悬停认领原图窥视，弹框收起时一并放开。
func TestGroupPeekRowMenuAndImageHover(t *testing.T) {
	a, _, sec := peekApp(t)
	f, _ := a.store.SaveImage(whitePNG(t, 400, 300))
	img, _, _ := a.store.Add(store.Note{Section: sec, Kind: "image", Title: "登录页截图", Text: "图片 400×300", ImageFile: f, ImageW: 400, ImageH: 300})
	a.reload()
	var g noteGroup
	for _, x := range a.noteGroups {
		if x.sec.ID == sec {
			g = x
		}
	}
	a.openGroupPeek(g, ui.Rect{Y: 120, W: 300, H: 20})
	pv := ui.NewTester(a.groupPeekView, gpW+2*gpPad, gpHeight(len(g.open)))
	pv.Frame()
	if err := pv.RightClick("代码审查清单"); err != nil {
		t.Fatal(err)
	}
	menu := pv.Menu()
	if len(menu) < 3 {
		t.Fatalf("右键应出卡片菜单：%v", menu)
	}
	if err := pv.ChooseMenuItem("删除"); err != nil {
		t.Fatalf("%v %v", err, menu)
	}
	pv.Frame()
	pv.Frame()
	if _, items := a.gpNotes(); len(items) != 5 || a.gp.sec != sec {
		t.Fatalf("删除后剩 5 条且弹框还在：%d sec=%q", len(items), a.gp.sec)
	}
	r, ok := pv.Find("登录页截图")
	if !ok {
		t.Fatal(pv.Texts())
	}
	pv.Move(r.X+r.W/2, r.Y+r.H/2)
	pv.Frame()
	if a.rowHov.id != gpHoverPrefix+img.ID {
		t.Fatalf("带图的行悬停应认领窥视：%q", a.rowHov.id)
	}
	a.closeGroupPeek("测试", true)
	if a.rowHov.id != "" {
		t.Fatal("弹框收起应放开窥视")
	}
}

// 弹框已经开着：移到另一个合上的分组头立即换过去，不等 0.4 秒（用户 2026-11-25）。
func TestGroupPeekSwitchIsInstant(t *testing.T) {
	a, tt, sec := peekApp(t)
	other := a.store.AddSection("另一个组")
	a.store.Add(store.Note{Section: other, Text: "另一组里的卡"})
	a.foldAllSections(true)
	a.reload()
	tt.Frame()
	tt.Frame()
	hover := func(name string) {
		r, ok := tt.Find(name)
		if !ok {
			t.Fatalf("没有 %s %v", name, tt.Texts())
		}
		tt.Move(r.X+r.W/2, r.Y+r.H/2)
		tt.Frame()
	}
	hover("提示词")
	tt.Advance(gpDelay + 10*time.Millisecond)
	tt.Frame()
	if a.gp.sec != sec {
		t.Fatal("前置：应先弹出第一个分组")
	}
	hover("另一个组")
	tt.Frame()
	if a.gp.sec != other {
		t.Fatalf("应立即换到另一个组，实为 %q（arm=%q）", a.gp.sec, a.gp.arm)
	}
}
