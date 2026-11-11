package main

import (
	"testing"
	"time"

	"github.com/toskr/native/internal/store"
)

// 同 Tauri 案 6：底缘状态带 sending → sent 回执（粘贴 / 回车）+ 撤销完成；失败转「发送未完成」。
func TestDeliveryBandLifecycle(t *testing.T) {
	a, tt := testApp(t, "第一条笔记", "第二条笔记")
	n := a.store.Notes()[0]
	a.beginBand([]string{n.ID})
	tt.Frame()
	if !tt.HasText("发送中…") {
		t.Fatalf("派发开始应显示「发送中…」%v", tt.Texts())
	}
	_ = a.store.MarkSent([]string{n.ID}, time.Now())
	a.doneOpen[store.SectionInbox] = true // 已发送的卡落进「已完成」折叠组：展开才看得到回执
	a.settleBand(false, true, true, []string{n.ID})
	tt.Frame()
	if !tt.HasText("✓ 已粘贴 · 已按回车") {
		t.Fatalf("回执应显示粘贴与回车 %v", tt.Texts())
	}
	tt.Advance(300 * time.Millisecond) // 等胶囊进场完成再点
	if err := tt.Click("撤销"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if got, _ := a.store.Note(n.ID); got.Done || a.band != nil {
		t.Fatalf("撤销应恢复未完成并收起 done=%v band=%v", got.Done, a.band)
	}
	if a.hudText != "已恢复 1 张卡为未完成" {
		t.Fatalf("HUD %q", a.hudText)
	}
	a.beginBand([]string{n.ID})
	a.settleBand(true, false, false, nil)
	tt.Frame()
	if !tt.HasText("发送未完成") || tt.HasText("撤销") {
		t.Fatalf("失败带 %v", tt.Texts())
	}
}

// 卡面正文是拖出源（DragData），单击仍然选中卡片。
func TestCardTextDragOutKeepsClick(t *testing.T) {
	a, tt := testApp(t, "第一条笔记", "第二条笔记")
	if err := tt.Click("第二条笔记"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	n := a.store.Notes()[1]
	if !a.chosen.Has(n.ID) {
		t.Fatalf("点正文应选中卡片 chosen=%v", a.chosen.Len())
	}
}
