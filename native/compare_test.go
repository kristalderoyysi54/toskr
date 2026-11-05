package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// TestCompareWithTauri 在设置 TOSKR_COMPARE_DIR 时，用与 Tauri 参照截图相同的数据渲染主面板，
// 与 ref-main-{light,dark}.png 逐像素比较，输出原生渲染图、差异热图与并排图，并打印差异比例。
func TestCompareWithTauri(t *testing.T) {
	dir := os.Getenv("TOSKR_COMPARE_DIR")
	if dir == "" {
		t.Skip("set TOSKR_COMPARE_DIR")
	}
	st, err := store.OpenDir(t.TempDir(), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	ago := time.Now().Add(-61 * time.Second)
	sec := st.AddSection("提示词库")
	_ = sec
	add := func(text string, done bool) {
		n, _, _ := st.Add(store.Note{Section: store.SectionInbox, Text: text, SourceApp: "Safari"})
		_ = st.SetCreatedAt(n.ID, ago)
		if done {
			_ = st.SetDone(n.ID, true)
		}
	}
	// 与参照一致：列表自上而下 n1 n2 n3（Add 插到顶部，所以倒序加）
	add("记得复核截图遮罩回收后的 Networking 进程占用", true)
	add("SELECT id, title FROM notes WHERE section = 'inbox' ORDER BY created_at DESC LIMIT 50;", false)
	add("会议纪要：周五前完成 mygo 原生版对比报告，附内存与启动耗时。", false)
	add("把这段接口说明发给 Claude：分页参数 page_size 默认 20，最大 200；超过返回 400。", false)
	a := newApp(nopSys{}, st)
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	a.reload()
	compareView(t, dir, "main", a)

	// 任务页：与 setup-tasks.js 同一组 6 条任务，时钟冻结在参照截图时刻（stub 里 Date 固定为 2026-11-05 19:36）
	now := time.Date(2026, 11, 5, 19, 36, 0, 0, time.Local)
	today := time.Date(2026, 11, 5, 0, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	for _, t0 := range []store.Task{ // AddTask 插到顶部，倒序加以保持 t1..t6 的数组顺序
		{Text: "更新 lessons", Status: "done", CompletedAt: now.Add(-time.Hour)},
		{Text: "给面板加液态玻璃", Spark: true},
		{Text: "整理截图标注需求", Checklist: []store.ChecklistItem{{ID: "c1", Text: "箭头", Done: true}, {ID: "c2", Text: "马赛克"}}},
		{Text: "周会", DueAt: today.Add(21*time.Hour + 30*time.Minute), Recurrence: "weekly"},
		{Text: "复核账单提醒逻辑", DueAt: today.Add(-9 * time.Hour), Priority: "high"},
		{Text: "交 mygo 对比报告", DueAt: today.Add(15 * time.Hour), Priority: "mid"},
	} {
		created := st.AddTask(t0)
		created.CreatedAt, created.CompletedAt = now.Add(-time.Hour), t0.CompletedAt
		_ = st.UpdateTask(created)
	}
	a.switchPage(pageTasks)
	a.reload()
	a.taskSub = 0
	compareView(t, dir, "tasks", a)
	a.taskSub = 1
	compareView(t, dir, "tasklist", a)

	// 剪贴页：与 setup-clip.js 同一组 4 条记录（倒序加，Add 插到顶部）；参照截图时没有任务，先清掉免得页签多出逾期徽标
	for _, t0 := range st.Tasks() {
		st.DeleteTask(t0.ID)
	}
	for _, c0 := range []struct {
		n   store.Note
		at  time.Time
		pin bool
	}{
		{store.Note{Text: "brew install --cask toskr", SourceApp: "Terminal"}, today.Add(-5 * time.Hour), false},
		{store.Note{Text: "周五前把 mygo 原生版对比报告发给团队，附内存与启动耗时。", SourceApp: "Safari"}, now.Add(-3 * time.Hour), true},
		{store.Note{Text: "SELECT id, title FROM notes WHERE section = 'clipboard' ORDER BY created_at DESC;", SourceApp: "Cursor"}, now.Add(-25 * time.Minute), false},
		{store.Note{Text: "https://github.com/egoist/mygo", Kind: "link", LinkTitle: "egoist/mygo: Native UI for Go", SourceApp: "Arc"}, now.Add(-2 * time.Minute), false},
	} {
		c0.n.Section = store.SectionClipboard
		n, _, _ := st.Add(c0.n)
		_ = st.SetCreatedAt(n.ID, c0.at)
		_ = st.SetKept(n.ID, c0.pin)
	}
	a.switchPage(pageClip)
	a.reload()
	compareView(t, dir, "clip", a)

	// 订阅子视图：与 setup-bills.js 同一组 4 笔账单（视频会员月付、云盘年付、信用卡今天还款、健身房周付）
	for _, n := range st.Section(store.SectionClipboard) {
		st.Delete(n.ID)
	}
	day := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.Local) }
	pays := func(amount float64, at ...time.Time) (out []store.Payment) {
		for _, t := range at {
			out = append(out, store.Payment{At: t, Amount: amount, Period: t})
		}
		return
	}
	for _, b := range []store.Bill{
		{Kind: "subscription", Name: "视频会员", Amount: 68, Cycle: "monthly", NextDueAt: day(2026, 11, 7), Status: "active",
			History: pays(68, day(2026, 6, 7), day(2026, 7, 7), day(2026, 8, 7), day(2026, 9, 7), day(2026, 10, 7))},
		{Kind: "subscription", Name: "云盘 2TB", Amount: 298, Cycle: "yearly", NextDueAt: day(2027, 3, 1), Status: "active", History: pays(298, day(2026, 3, 1))},
		{Kind: "creditCard", Name: "招行信用卡", Cycle: "monthly", NextDueAt: today, Status: "active", PayMethod: "尾号 1234"},
		{Kind: "subscription", Name: "健身房", Amount: 45, Cycle: "weekly", NextDueAt: day(2026, 11, 9), Status: "active",
			History: pays(45, day(2026, 10, 12), day(2026, 10, 19), day(2026, 10, 26))},
	} {
		created := st.AddBill(b)
		created.History = b.History
		_ = st.UpdateBill(created)
	}
	cfg := st.Settings()
	cfg.SubscriptionsEnabled = true
	_ = st.SetSettings(cfg)
	a.switchPage(pageTasks)
	a.taskSub = 2
	a.reload()
	compareView(t, dir, "bills", a)
	cfg.SubscriptionsEnabled = false
	_ = st.SetSettings(cfg)

	// 内容 → 秘文：与 setup-secret.js 同两把密钥、三张卡；密文随机，逐配色读参照当次生成的密文
	cfg.SecretEnabled = true
	cfg.SecretKeys = []store.SecretKey{{ID: "k1", Label: "小王", Passphrase: "月亮湾"}, {ID: "k2", Label: "项目组", Passphrase: "蓝鲸-2026"}}
	cfg.SecretDefaultKeyID, cfg.SecretCipherStyle = "k1", "classic"
	_ = st.SetSettings(cfg)
	a.switchPage(pageNotes)
	a.noteSub = 1
	for _, scheme := range []string{"light", "dark"} {
		raw, err := os.ReadFile(filepath.Join(dir, "ref-secret-ciphers-"+scheme+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var ciphers []string
		_ = json.Unmarshal(raw, &ciphers)
		for _, x := range st.Secrets() {
			st.DeleteSecret(x.ID)
		}
		st.AddSecret(store.Secret{Text: ciphers[2], Direction: "in", CreatedAt: now.Add(-3 * time.Hour)})
		st.AddSecret(store.Secret{Text: ciphers[1], KeyID: "k2", KeyLabel: "项目组", Direction: "in", CreatedAt: now.Add(-42 * time.Minute)})
		st.AddSecret(store.Secret{Text: ciphers[0], KeyID: "k1", KeyLabel: "小王", Direction: "out", CreatedAt: now.Add(-3 * time.Minute)})
		a.reload()
		compareOne(t, dir, "secret", a.panelView, 380, 760, scheme)
	}
	cfg.SecretEnabled = false
	_ = st.SetSettings(cfg)
	a.noteSub = 0

	// 详情窗（560×540）：与 setup-detail.js 同一条笔记（Safari，61 秒前）
	dn, _, _ := st.Add(store.Note{Section: store.SectionInbox, SourceApp: "Safari",
		Text: "会议纪要：周五前完成 mygo 原生版对比报告，附内存与启动耗时。\n\n1. 主面板、任务、剪贴、订阅、秘文逐屏 1:1 对照\n2. 设置窗外壳与控件\n3. HUD 气泡与详情窗"})
	_ = st.SetCreatedAt(dn.ID, now.Add(-61*time.Second))
	a.detail = detailState{id: dn.ID, pickAnchor: -1, pickEnd: -1}
	compareSized(t, dir, "detail", a.detailView, 560, 540)

	// HUD（264×100）：可撤销的捕获气泡，未悬停
	a.hudKind, a.hudText, a.hudUndo, a.hudHover = "added", "会议纪要：周五前完成 mygo 原生版对比报告", func() {}, false
	compareSized(t, dir, "hud", a.hudView, 264, 100)

	// 设置窗（1040×720，首屏「窗口与外观 · 通用」）
	a.openSettingsState()
	compareSized(t, dir, "settings", a.settingsView, 1040, 720)
}

func compareView(t *testing.T, dir, name string, a *app) {
	compareSized(t, dir, name, a.panelView, 380, 760)
}

func compareSized(t *testing.T, dir, name string, view func(*ui.Context), w, h int) {
	for _, scheme := range []string{"light", "dark"} {
		compareOne(t, dir, name, view, w, h, scheme)
	}
}

func compareOne(t *testing.T, dir, name string, view func(*ui.Context), w, h int, scheme string) {
	{
		tt := ui.NewTester(view, w, h)
		tt.SetDark(scheme == "dark")
		tt.SetVibrancy(false)
		tt.Move(float32(w-1), 2)
		tt.Frame()
		tt.Advance(time.Second) // 让颜色过渡 / 弹簧走完（切暗色后颜色从浅色值过渡过来）
		tt.Frame()
		got := onWhite(tt.Image())
		save(t, filepath.Join(dir, "mygo-"+name+"-"+scheme+".png"), got)
		ref := load(t, filepath.Join(dir, "ref-"+name+"-"+scheme+".png"))
		ratio, heat := diff(ref, got)
		save(t, filepath.Join(dir, "diff-"+name+"-"+scheme+".png"), heat)
		save(t, filepath.Join(dir, "side-"+name+"-"+scheme+".png"), sideBySide(ref, got, heat))
		fmt.Printf("%s %s: 差异像素 %.2f%%（通道差 > 24，1px 容差）\n", name, scheme, ratio*100)
	}
}

// compareBackdrop 是参照截图里面板背后的页面底色：通常为白；方案自带 color-scheme: dark 时（雾蓝深色）
// 浏览器画布变为 #121212。实机里背后是系统模糊材质，与此无关，只为对照口径一致。
var compareBackdrop = image.Image(image.White)

func onWhite(src *image.RGBA) *image.RGBA {
	out := image.NewRGBA(src.Bounds())
	draw.Draw(out, out.Bounds(), compareBackdrop, image.Point{}, draw.Src)
	draw.Draw(out, out.Bounds(), src, src.Bounds().Min, draw.Over)
	return out
}

func diff(a, b image.Image) (float64, *image.RGBA) {
	r := a.Bounds().Intersect(b.Bounds())
	heat := image.NewRGBA(r)
	bad := 0
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			c1 := color.RGBAModel.Convert(a.At(x, y)).(color.RGBA)
			g := uint8(255 - (int(c1.R)+int(c1.G)+int(c1.B))/3/4) // 参照图淡化作底
			// 容差 1px：邻域内有一处颜色相近就算一致（抵消文字抗锯齿的亚像素差）
			d := 999
			for dy := -1; dy <= 1 && d > 24; dy++ {
				for dx := -1; dx <= 1 && d > 24; dx++ {
					c2 := color.RGBAModel.Convert(b.At(x+dx, y+dy)).(color.RGBA)
					d = min(d, max(absd(c1.R, c2.R), absd(c1.G, c2.G), absd(c1.B, c2.B)))
				}
			}
			if d > 24 {
				bad++
				heat.Set(x, y, color.RGBA{255, 0, 60, 255})
			} else {
				heat.Set(x, y, color.RGBA{g, g, g, 255})
			}
		}
	}
	return float64(bad) / float64(r.Dx()*r.Dy()), heat
}

func absd(a, b uint8) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}

func sideBySide(imgs ...image.Image) *image.RGBA {
	w, h := 0, 0
	for _, im := range imgs {
		w += im.Bounds().Dx() + 8
		h = max(h, im.Bounds().Dy())
	}
	out := image.NewRGBA(image.Rect(0, 0, w-8, h))
	draw.Draw(out, out.Bounds(), image.White, image.Point{}, draw.Src)
	x := 0
	for _, im := range imgs {
		draw.Draw(out, image.Rect(x, 0, x+im.Bounds().Dx(), im.Bounds().Dy()), im, im.Bounds().Min, draw.Src)
		x += im.Bounds().Dx() + 8
	}
	return out
}

func save(t *testing.T, path string, img image.Image) {
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}

func load(t *testing.T, path string) image.Image {
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	return img
}

// TestCompareSchemes 对照配色方案与卡片密度：与 setup-main-*.js 同一组笔记，参照 ref-main-<变体>-<明暗>.png。
func TestCompareSchemes(t *testing.T) {
	dir := os.Getenv("TOSKR_COMPARE_DIR")
	if dir == "" {
		t.Skip("set TOSKR_COMPARE_DIR")
	}
	st, err := store.OpenDir(t.TempDir(), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	ago := time.Now().Add(-61 * time.Second)
	st.AddSection("提示词库")
	for _, x := range []struct {
		text string
		done bool
	}{
		{"记得复核截图遮罩回收后的 Networking 进程占用", true},
		{"SELECT id, title FROM notes WHERE section = 'inbox' ORDER BY created_at DESC LIMIT 50;", false},
		{"会议纪要：周五前完成 mygo 原生版对比报告，附内存与启动耗时。", false},
		{"把这段接口说明发给 Claude：分页参数 page_size 默认 20，最大 200；超过返回 400。", false},
	} {
		n, _, _ := st.Add(store.Note{Section: store.SectionInbox, Text: x.text, SourceApp: "Safari"})
		_ = st.SetCreatedAt(n.ID, ago)
		if x.done {
			_ = st.SetDone(n.ID, true)
		}
	}
	a := newApp(nopSys{}, st)
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	a.reload()
	defer func() { curScheme = "default" }()
	for _, v := range []struct {
		name, scheme, density string
		modes                 []string
	}{
		{"paper", "paper", "", []string{"light"}},
		{"matcha", "matcha", "", []string{"light"}},
		{"sakura", "sakura", "", []string{"light"}},
		{"fog", "fog", "", []string{"light", "dark"}},
		{"platinum", "platinum", "", []string{"light"}},
		{"compact", "default", "compact", []string{"light", "dark"}},
	} {
		s := a.store.Settings()
		s.ColorScheme, s.CardDensity = v.scheme, v.density
		_ = a.store.SetSettings(s)
		curScheme = v.scheme
		for _, m := range v.modes {
			if v.scheme == "fog" && m == "dark" {
				compareBackdrop = image.NewUniform(color.RGBA{18, 18, 18, 255})
			}
			compareOne(t, dir, "main-"+v.name, a.panelView, 380, 760, m)
			compareBackdrop = image.White
		}
	}
	// 设置窗（首屏「窗口与外观 · 通用」）在三种方案下
	for _, v := range []struct{ scheme, mode string }{{"paper", "light"}, {"platinum", "light"}, {"fog", "dark"}} {
		s := a.store.Settings()
		s.ColorScheme, s.CardDensity = v.scheme, ""
		_ = a.store.SetSettings(s)
		curScheme = v.scheme
		a.openSettingsState()
		compareOne(t, dir, "settings-"+v.scheme, a.settingsView, 1040, 720, v.mode)
	}
}
