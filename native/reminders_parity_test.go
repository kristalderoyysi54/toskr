package main

import (
	"testing"
	"time"

	"github.com/toskr/native/internal/store"
)

// 今天速记原文入库、到期今天默认时间并提示（同 Tauri TodayQuickAdd）。
func TestTodayQuickAddKeepsRawText(t *testing.T) {
	a, _ := testApp(t)
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.Local)
	a.clock = func() time.Time { return now }
	a.taskSub, a.taskDraft = 0, "明天 买菜"
	a.addTaskDraft()
	ts := a.store.Tasks()
	if len(ts) != 1 || ts[0].Text != "明天 买菜" || ts[0].DueAt.Hour() != 20 || a.hudText != "已加到今天 20:00" {
		t.Fatalf("%+v hud=%q", ts, a.hudText)
	}
}

// 重复任务完成后下一期占原位置（同 Tauri withTaskStatus splice(index)）。
func TestRecurringNextKeepsPosition(t *testing.T) {
	a, _ := testApp(t)
	now := time.Now()
	a.store.AddTask(store.Task{Text: "乙"})
	x := a.store.AddTask(store.Task{Text: "甲", DueAt: now.Add(time.Hour), Recurrence: "daily"})
	a.store.AddTask(store.Task{Text: "丙"}) // 顺序：丙 甲 乙
	a.store.CompleteTask(x.ID, true, now)
	ts := a.store.Tasks()
	if ts[1].Text != "甲" || ts[1].Status != "todo" || ts[2].ID != x.ID {
		t.Fatalf("下一期应在原位 %+v", ts)
	}
}

// 订阅页「周 / 月」视图记忆进设置，重开后恢复。
func TestBillViewPersists(t *testing.T) {
	a, _ := testApp(t)
	st := a.store.Settings()
	st.BillView = "month"
	_ = a.store.SetSettings(st)
	b := newApp(nopSys{}, a.store)
	if b.billView != "month" {
		t.Fatalf("应记住月视图，得到 %q", b.billView)
	}
}
