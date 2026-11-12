package main

import (
	"testing"
	"time"
)

// 同位置换内容（这里是消息筛选）：新内容从切换方向 10pt 外淡入、约 180ms 回到原位；往回切从另一侧进。
func TestSwapViewTransition(t *testing.T) {
	a, tt := msgApp(t)
	tt.Advance(time.Second) // 让进入「消息」子页的动画走完
	tt.Frame()
	base, _ := tt.Find("小张")
	a.store.SetMessagesStatus([]string{a.store.Messages()[0].ID}, "waiting") // 小张 → 等待回复
	a.msgFilter = "waiting"                                                  // Tester.Click 自带时钟推进，量中间帧要直接切状态
	tt.Frame()
	start, _ := tt.Find("小张")
	tt.Advance(60 * time.Millisecond)
	tt.Frame()
	mid, _ := tt.Find("小张")
	if start.X != base.X+10 || mid.X <= base.X || mid.X >= start.X {
		t.Fatalf("序号变大应从右侧 10pt 处滑入：base %v start %v mid %v", base, start, mid)
	}
	tt.Advance(time.Second)
	tt.Frame()
	if end, _ := tt.Find("小张"); end.X != base.X {
		t.Fatalf("动画结束回到原位 %v", end)
	}
	a.msgFilter = "new"
	tt.Frame()
	if back, _ := tt.Find("小王"); back.X != base.X-10 {
		t.Fatalf("往回切应从左侧进 %v", back)
	}
}
