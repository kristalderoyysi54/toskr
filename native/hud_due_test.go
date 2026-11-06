package main

import (
	"errors"
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
