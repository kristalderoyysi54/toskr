package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
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
		a.refreshCalendar()
		lastHouse := time.Now()
		nextBackup := time.Now().Add(2 * time.Minute) // 同 Tauri：启动 2 分钟后首检，之后每 30 分钟看是否到期
		if a.dataDirMissing != "" && a.panel != nil {
			a.panel.Update(func() {
				a.showHUDForce("warn", tr("自定义数据目录不可用，本次使用默认目录（设置 → 数据与备份）"))
			})
		}
		for now := range time.Tick(reminderTick) {
			if !now.Before(nextBackup) {
				nextBackup = now.Add(30 * time.Minute)
				a.runAutoBackup(false, now)
			}
			a.remind(now)
			a.refreshCalendar() // 日程每 30 秒重拉一次（含跨零点换天）
			if a.panel != nil {
				a.panel.Update(a.refreshTray) // 暂停到点后托盘回到「暂停」子菜单、剩余分钟更新
			}
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
	if refs, notes, missing := a.store.MediaStats(); missing > 0 || gc > 0 {
		diag.Push("媒体: 引用 %d（带图笔记 %d）缺文件 %d", refs, notes, missing)
	}
}

func (a *app) remind(now time.Time) {
	if !a.store.Settings().DueReminders {
		return
	}
	if due := a.store.DueForReminder(now); len(due) > 0 {
		a.remindTasks(due, now)
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
	if err := sysNotify(a, id, title, body); err != nil {
		diag.Push("通知失败(%v)，改用气泡", err)
		a.panel.Update(func() { a.showHUDForce("warn", title+"："+body) })
	}
}

var sysNotify = func(a *app, id, title, body string) error { // 测试替换
	n := mygo.NewNotification(mygo.NotificationOptions{ID: id, Title: title, Body: body, Group: "toskr-reminders"})
	n.OnClick(func() { a.panel.Update(a.showPanel) })
	return n.Show()
}

// remindTasks：任务到期（同 Tauri App.tsx 到期检查）。按「提醒方式」出气泡（可直接完成 / 稍后）、系统通知或两者；
// 只选系统通知而通知被拒时退回气泡。
func (a *app) remindTasks(due []store.Task, now time.Time) {
	ids := make([]string, len(due))
	var names []string
	for i, t := range due {
		ids[i] = t.ID
		if i < 4 {
			names = append(names, preview(t.Text, 24))
		}
	}
	text := reminderHitLabel(due[0], now, preview(due[0].Text, 40))
	body := text
	if len(due) > 1 {
		text = fmt.Sprintf(tr("%d 个任务提醒"), len(due))
		body = strings.Join(names, tr("、"))
	}
	via := a.store.Settings().ReminderVia
	if via != "system" {
		a.panelUpdate(func() { a.showDueHUD(text, ids) })
	}
	if via == "system" || via == "both" {
		id := fmt.Sprintf("task:%s:%d", ids[0], now.UnixMilli())
		if len(due) > 1 {
			id = fmt.Sprintf("task-batch:%d", now.UnixMilli())
		}
		if err := sysNotify(a, id, tr("Toskr 任务提醒"), body); err != nil {
			diag.Push("通知失败(%v)", err)
			if via == "system" {
				a.panelUpdate(func() { a.showDueHUD(text, ids) })
			}
		}
	}
}

// reminderHitLabel 同 Tauri：到期档用标题本身，提前档（任务还没到期）补「还有多久」。
func reminderHitLabel(t store.Task, now time.Time, p string) string {
	if !t.DueAt.After(now) {
		return p
	}
	mins := max(1, int(t.DueAt.Sub(now).Minutes()+0.5))
	switch {
	case mins < 60:
		return fmt.Sprintf(tr("%s · %d 分钟后到期"), p, mins)
	case mins < 1440:
		return fmt.Sprintf(tr("%s · %d 小时后到期"), p, (mins+30)/60)
	}
	return fmt.Sprintf(tr("%s · %d 天后到期"), p, (mins+720)/1440)
}
