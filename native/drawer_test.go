package main

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 最近发送：发送即记一轮 → 抽屉「等待回复」→ 手动选择回复 →「已完成 / 回复已入库」→ 卡片右键取消关联可撤销 → Esc 关抽屉。
func TestRecentDeliveryDrawer(t *testing.T) {
	a, tt := testApp(t, "怎么写周报")
	a.sys = &recSys{}
	a.target = macos.FrontApp{PID: 42, Name: "ChatGPT", BundleID: "com.openai.chat"}
	if err := tt.Click("最近发送"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !tt.HasText("暂无发送记录") {
		t.Fatalf("空态 %v", tt.Texts())
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.drawerOpen {
		t.Fatal("Esc 应先关抽屉")
	}
	// 投递本体走 Window.Update（测试里没有主循环），这里直接跑收尾
	src := a.store.Notes()[0]
	a.finishDeliver(a.target, []string{src.ID}, []string{src.Text}, nil, 0, "稳妥发送", core.CheckVerified, nil)
	a.finishDeliver(a.target, []string{src.ID}, []string{src.Text}, nil, 0, "稳妥发送", "", errors.New("目标窗口已关闭"))
	tt.Frame()
	if len(a.store.Deliveries()) != 2 || a.hudKind != "warn" {
		t.Fatalf("成功与失败各记一轮 %+v hud=%s", a.store.Deliveries(), a.hudKind)
	}
	d := a.store.Deliveries()[1]
	if d.Status != "sent" || d.TargetBundle != "com.openai.chat" || d.TextChars != 5 || len(d.SourceIDs) != 1 {
		t.Fatalf("发送记录 %+v", d)
	}
	a.drawerOpen = true
	tt.Frame()
	for _, s := range []string{"最近发送", "ChatGPT", "“怎么写周报”", "等待回复", "手动选择回复", "需处理", "发送失败", "重新准备"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q：%v", s, tt.Texts())
		}
	}
	reply, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "先列三件事", BundleID: "com.openai.chat", SourceApp: "ChatGPT", CreatedAt: d.At.Add(time.Minute)})
	tt.Frame()
	if err := tt.Click("手动选择回复"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem(reply.CreatedAt.Format("15:04") + " · 先列三件事"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	for _, s := range []string{"已完成", "已收到回复", "回复已入库", "更换回复"} {
		if !tt.HasText(s) {
			t.Fatalf("关联后缺 %q：%v", s, tt.Texts())
		}
	}
	if err := tt.Click("更多信息"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !tt.HasText("1 张卡片 · 5 字文字") || !tt.HasText("发送前未替换敏感内容") {
		t.Fatalf("更多明细 %v", tt.Texts())
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if err := tt.RightClick("先列三件事"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("回复关联", "这不是对应回复…"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	if a.store.Deliveries()[1].ResultNoteID != "" {
		t.Fatal("应取消关联")
	}
	tt.Key(ui.Cmd, ui.KeyZ)
	tt.Frame()
	if n, _ := a.store.Note(reply.ID); n.Provenance == nil || a.store.Deliveries()[1].ResultNoteID != reply.ID {
		t.Fatal("撤销应恢复关联")
	}
	a.store.Add(store.Note{Section: store.SectionInbox, Text: "无关的一条"}) // 已发送的卡已折进「已完成」
	tt.Frame()
	_ = tt.RightClick("无关的一条")
	if m := fmt.Sprint(tt.Menu()); !strings.Contains(m, "保存为某次回复…") || strings.Contains(m, "回复关联") {
		t.Fatalf("无溯源的卡只有「保存为某次回复…」%s", m)
	}
}
