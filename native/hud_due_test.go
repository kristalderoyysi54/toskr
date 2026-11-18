package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 任务到期：默认出气泡（带 完成 · 10 分钟后 · 1 小时后），不发系统通知；只选系统通知而被拒时退回气泡。
func TestDueReminderHUD(t *testing.T) {
	a, _ := testApp(t)
	old := sysNotify
	t.Cleanup(func() { sysNotify = old })
	sent := 0
	sysNotify = func(*app, string, string, string) error { sent++; return errors.New("denied") }
	now := time.Now()
	t1 := a.store.AddTask(store.Task{Text: "交周报", DueAt: now.Add(-time.Minute)})
	a.remind(now)
	a.drainUpdates()
	if a.hudKind != "due" || len(a.hudDue) != 1 || a.hudDue[0] != t1.ID || sent != 0 {
		t.Fatalf("%q %v sent=%d", a.hudKind, a.hudDue, sent)
	}
	hud := ui.NewTester(a.hudView, hudW, hudH+28)
	hud.Frame()
	for _, s := range []string{"交周报", "完成", "10 分钟后", "1 小时后"} {
		if !hud.HasText(s) {
			t.Fatalf("缺 %q：%v", s, hud.Texts())
		}
	}
	if err := hud.Click("10 分钟后"); err != nil {
		t.Fatal(err)
	}
	got := a.store.Tasks()[0]
	if !got.RemindedAt.IsZero() || got.DueAt.Sub(now) < 9*time.Minute || a.hudText != "已推迟到 "+got.DueAt.Format("15:04") {
		t.Fatalf("%+v %q", got, a.hudText)
	}

	// 两条同时到期：批量文案，只有「全部…」，没有完成
	st := a.store.Settings()
	st.ReminderVia = "system"
	_ = a.store.SetSettings(st)
	a.store.AddTask(store.Task{Text: "A", DueAt: now.Add(-time.Minute)})
	a.store.AddTask(store.Task{Text: "B", DueAt: now.Add(-time.Minute)})
	a.remind(now)
	a.drainUpdates()
	if sent != 1 || a.hudKind != "due" || len(a.hudDue) != 2 || a.hudText != "2 个任务提醒" {
		t.Fatalf("系统通知被拒应退回气泡 sent=%d %q %v", sent, a.hudText, a.hudDue)
	}
	hud.Frame()
	if hud.HasText("完成") || !hud.HasText("全部10 分钟后") {
		t.Fatalf("%v", hud.Texts())
	}
	hud.Click("全部1 小时后")
	if a.hudText == "" || a.store.Tasks()[0].DueAt.Sub(now) < 59*time.Minute {
		t.Fatal("批量稍后")
	}
}

func TestDueHUDCompleteAndOpen(t *testing.T) {
	a, _ := testApp(t, "一张卡")
	tk := a.store.AddTask(store.Task{Text: "回电话", DueAt: time.Now().Add(-time.Minute)})
	a.showDueHUD("回电话", []string{tk.ID})
	a.hudOpen()
	if a.page != pageTasks || a.taskOpen != tk.ID {
		t.Fatalf("点气泡应去提醒页并打开任务 page=%d open=%q", a.page, a.taskOpen)
	}
	a.hudDueAction([]string{tk.ID}, "complete", 0)
	if a.store.Tasks()[0].Status != "done" || a.hudText != "已完成" {
		t.Fatal("气泡里完成")
	}
	a.hudDueAction([]string{tk.ID}, "complete", 0)
	if a.hudText != "任务已处理或已删除" {
		t.Fatal(a.hudText)
	}
	// 捕获类气泡：点击定位到那张卡
	n := a.store.Section(store.SectionInbox)[0]
	a.switchPage(pageTasks)
	a.showHUD("added", "一张卡")
	a.hudTarget = n.ID
	a.hudOpen()
	if cur, ok := a.current(); a.page != pageNotes || !ok || cur.ID != n.ID {
		t.Fatalf("应定位到捕获的卡 page=%d", a.page)
	}
}

// 捕获气泡：预览前带内容类型小标（纯文本不标），状态圆叠来源应用图标；换成别的气泡后清掉。
func TestCaptureHUDSourceAndTag(t *testing.T) {
	a, _ := testApp(t)
	if got := captureTag(store.Note{Text: "纯文本"}); got != "" {
		t.Fatalf("纯文本不标 %q", got)
	}
	if got := captureTag(store.Note{Kind: "link", Text: "https://a.com"}); got != "链接" {
		t.Fatalf("链接 %q", got)
	}
	if got := captureTag(store.Note{Text: "图文", Attachments: []string{"a.png", "b.png"}}); got != "图文 ×3" {
		t.Fatalf("图文 %q", got)
	}
	a.showHUDUndo("added", "SELECT 1;", func() {})
	a.hudTarget, a.hudSrc, a.hudTag = "n1", "com.apple.Safari", "sql"
	hud := ui.NewTester(a.hudView, hudW, hudH)
	for _, dark := range []bool{false, true} {
		hud.SetDark(dark)
		hud.Frame()
		if !hud.HasText("sql") || !hud.HasText("SELECT 1;") || !hud.HasText("已捕获") {
			t.Fatalf("应有类型小标与预览 %v", hud.Texts())
		}
		if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
			save(t, filepath.Join(dir, "hud-tag-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), hud.Image())
		}
	}
	a.showHUD("ok", "完成")
	if a.hudSrc != "" || a.hudTag != "" {
		t.Fatal("换气泡后应清来源与小标")
	}
}

// 捕获气泡上的去向：建议分组排第一、最多 3 个；点一下把刚捕获的那条归过去，气泡换成可撤销的「已归到」。
func TestCaptureHUDFileChoices(t *testing.T) {
	a, _ := testApp(t)
	var secs []string
	for _, name := range []string{"提示词", "Bug", "可借鉴", "杂项"} {
		secs = append(secs, a.store.AddSection(name))
	}
	for range 2 { // Arc 的文字大多归在「可借鉴」
		a.store.Add(store.Note{Section: secs[2], Text: "旧 " + itoa(len(a.store.Notes())), BundleID: "arc"})
	}
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "刚捕获的", BundleID: "arc", SourceApp: "Arc"})
	a.reload()
	ch := a.newFileIndex(a.store.Notes()).choices(n, 3)
	if len(ch) != 3 || ch[0].section != secs[2] || ch[0].why == "" || ch[1].section != secs[0] || ch[1].why != "" {
		t.Fatalf("建议分组排第一，其余按分组顺序补齐 %+v", ch)
	}
	a.showHUDUndo("added", "刚捕获的", func() {})
	a.hudTarget = n.ID
	a.hudOfferFile(n)
	if len(a.hudFile) != 3 || a.hudBubbleH() != 88 {
		t.Fatalf("气泡应带 3 个去向 %+v", a.hudFile)
	}
	hud := ui.NewTester(a.hudView, hudW, hudH+28)
	for _, dark := range []bool{false, true} {
		hud.SetDark(dark)
		hud.Frame()
		if !hud.HasText("可借鉴") || !hud.HasText("提示词") || !hud.HasText("Bug") || hud.HasText("杂项") {
			t.Fatalf("去向钮 %v", hud.Texts())
		}
		if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
			save(t, filepath.Join(dir, "hud-file-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), hud.Image())
		}
	}
	if err := hud.Click("Bug"); err != nil {
		t.Fatal(err)
	}
	if got, _ := a.store.Note(n.ID); got.Section != secs[1] {
		t.Fatalf("点去向应归过去 %q", got.Section)
	}
	if a.hudGhost != nil || a.hudAt.IsZero() {
		t.Fatal("点去向是原地换内容：不留残影、不重播进场")
	}
	if a.hudKind != "ok" || a.hudUndo == nil || len(a.hudFile) != 0 {
		t.Fatalf("气泡应换成可撤销的「已归到」 kind=%s", a.hudKind)
	}
	a.hudUndo()
	if got, _ := a.store.Note(n.ID); got.Section != store.SectionInbox {
		t.Fatal("撤销应回收件箱")
	}
	// 捕获直接进了分组：不给去向
	m, _, _ := a.store.Add(store.Note{Section: secs[0], Text: "直接进组", BundleID: "arc"})
	a.showHUDUndo("added", "直接进组", func() {})
	a.hudTarget = m.ID
	a.hudOfferFile(m)
	if len(a.hudFile) != 0 {
		t.Fatal("不在收件箱的不给去向")
	}
}
