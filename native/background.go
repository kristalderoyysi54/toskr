package main

import (
	"fmt"
	"time"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/diag"
)

const reminderTick = 30 * time.Second

// startBackground：启动恢复点（后台写，不阻塞启动）、到期提醒、订阅续期、剪贴板按天清理、媒体回收。
func (a *app) startBackground() {
	go func() {
		if p, err := a.store.WriteRecoveryPoint("launch", time.Now()); err != nil {
			diag.Push("启动恢复点写入失败: %v", err)
		} else if p != "" {
			diag.Push("启动恢复点已写入")
		}
		a.housekeeping()
		lastHouse := time.Now()
		for now := range time.Tick(reminderTick) {
			a.remind(now)
			if now.Sub(lastHouse) > time.Hour {
				a.housekeeping()
				lastHouse = now
			}
		}
	}()
}

func (a *app) housekeeping() {
	st := a.store.Settings()
	pruned := a.store.PruneClipboard(st.ClipRetainDays, func() int64 { return time.Now().Unix() })
	rolled := a.store.RollForward(time.Now())
	gc := a.store.GCMedia()
	if pruned+rolled+gc > 0 {
		diag.Push("整理: 剪贴板清理 %d 订阅续期 %d 媒体回收 %d", pruned, rolled, gc)
	}
}

func (a *app) remind(now time.Time) {
	if !a.store.Settings().DueReminders {
		return
	}
	for _, t := range a.store.DueForReminder(now) {
		a.notify("task-"+t.ID, tr("任务到期"), t.Text)
	}
	for _, r := range a.store.BillsToRemind(now) {
		body := fmt.Sprintf(tr("%s %s · %d 天后到期"), r.Bill.Name, money(a.store.Settings().Currency, r.Bill.Amount), r.Days)
		if r.Days == 0 {
			body = fmt.Sprintf(tr("%s %s · 今天到期"), r.Bill.Name, money(a.store.Settings().Currency, r.Bill.Amount))
		}
		a.notify("bill-"+r.Bill.ID, tr("账单提醒"), body)
	}
}

// notify 发系统通知；通知被拒绝时退回 HUD 气泡（隐身模式下也会显示，因为是用户设的提醒）。
func (a *app) notify(id, title, body string) {
	n := mygo.NewNotification(mygo.NotificationOptions{ID: id, Title: title, Body: body, Group: "toskr-reminders"})
	n.OnClick(func() { a.panel.Update(a.showPanel) })
	if err := n.Show(); err != nil {
		diag.Push("通知失败(%v)，改用气泡", err)
		a.panel.Update(func() { a.showHUDForce("warn", title+"："+body) })
	}
}
