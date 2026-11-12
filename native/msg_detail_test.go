package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/imwatch"
	"github.com/toskr/native/internal/store"
)

// 桥收到的图片存进媒体库，消息投影带上文件名；卡面出缩略图；双击放大阅读（只读详情窗带图）。
func TestMessageImagesAndEnlarge(t *testing.T) {
	a, tt := msgApp(t)
	f, err := a.imSaveImage(whitePNG(t, 60, 30))
	if err != nil {
		t.Fatal(err)
	}
	yes := true
	r := imwatch.Record{ReceivedAtMs: time.Now().UnixMilli(), Message: imwatch.Message{BridgeVersion: imwatch.BridgeVersion,
		ConversationID: "g1", ConversationName: "项目群", MessageID: "9", SenderName: "小赵", MentionedSelf: true, IsGroup: &yes,
		Text: "截图如下", Images: []imwatch.Image{{File: f}}}}
	if a.ingestIM([]imwatch.Record{r}, false) != 1 {
		t.Fatal("应新增一条")
	}
	var m store.Message
	for _, x := range a.store.Messages() {
		if x.MessageID == "9" {
			m = x
		}
	}
	if len(m.Images) != 1 || m.Images[0] != f {
		t.Fatalf("消息应带图片 %+v", m.Images)
	}
	tt.Frame()
	if !tt.HasText("1 张图片") {
		t.Fatalf("卡面应有缩略图 %v", tt.Texts())
	}
	var opened store.Note
	old := openDetailFn
	openDetailFn = func(a *app, n store.Note) { opened = n; a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1} }
	t.Cleanup(func() { openDetailFn = old })
	r2, _ := tt.Find("截图如下")
	tt.ClickAt(r2.X+5, r2.Y+5)
	tt.ClickAt(r2.X+5, r2.Y+5)
	tt.Frame()
	if opened.Text != "截图如下" || len(opened.MediaFiles()) != 1 || a.detail.virt == nil || a.detail.subtitle == "" {
		t.Fatalf("双击应只读放大 %+v sub=%q", opened, a.detail.subtitle)
	}
	_ = ui.Cmd
}

// 消息列表：↑↓ 逐条单选、空格快速查看（再按收起）；消息放大阅读用单独的字号（默认 14，⌘+ 只改它）。
func TestMessageSpaceQuickLookAndFont(t *testing.T) {
	a, tt := msgApp(t)
	var opened store.Note
	old := openDetailFn
	openDetailFn = func(a *app, n store.Note) {
		opened = n
		a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	}
	t.Cleanup(func() { openDetailFn = old })
	tt.Key(0, ui.KeyDown)
	tt.Key(0, ui.KeyDown)
	tt.Frame()
	view := a.visibleMessages()
	if a.msgAnchor != view[1].ID || !a.msgChosen[view[1].ID] || len(a.msgChosen) != 1 {
		t.Fatalf("↓↓ 应单选第 2 条 %q", a.msgAnchor)
	}
	tt.Key(0, ui.KeySpace)
	tt.Frame()
	if opened.Text != view[1].Text || !a.msgView() {
		t.Fatalf("空格应放大阅读 %+v", opened)
	}
	st := a.store.Settings()
	if a.detailFS() != float32(st.MessageFontSize)+1 || st.MessageFontSize != 14 {
		t.Fatalf("消息字号默认 14 %v", a.detailFS())
	}
	dt := ui.NewTester(a.detailView, 560, 540)
	dt.Frame()
	dt.Key(ui.Cmd, ui.KeyEqual)
	dt.Frame()
	if st2 := a.store.Settings(); st2.MessageFontSize != 15 || st2.DetailFontSize != st.DetailFontSize {
		t.Fatalf("⌘+ 只改消息字号 %d / %d", st2.MessageFontSize, st2.DetailFontSize)
	}
}

// 前文里的图片：存成文件名进投影，前文展开处出缩略图，放大阅读时一起带上。
func TestMessageContextImages(t *testing.T) {
	a, tt := msgApp(t)
	f, _ := a.imSaveImage(whitePNG(t, 40, 20))
	yes := true
	a.ingestIM([]imwatch.Record{{ReceivedAtMs: time.Now().UnixMilli(), Message: imwatch.Message{BridgeVersion: imwatch.BridgeVersion,
		ConversationID: "g1", MessageID: "7", SenderName: "小钱", MentionedSelf: true, IsGroup: &yes, Text: "看上面",
		Context: []imwatch.ContextItem{{MessageID: "6", SenderName: "小孙", Images: []imwatch.Image{{File: f}}}}}}}, false)
	var m store.Message
	for _, x := range a.store.Messages() {
		if x.MessageID == "7" {
			m = x
		}
	}
	if len(m.Context) != 1 || len(m.Context[0].Images) != 1 {
		t.Fatalf("前文应带图 %+v", m.Context)
	}
	a.msgOpen["c:"+m.ID] = true
	tt.Frame()
	if !tt.HasText("1 张图片") {
		t.Fatal(tt.Texts())
	}
	old := openDetailFn
	var opened store.Note
	openDetailFn = func(a *app, n store.Note) { opened = n; a.detail = detailState{id: n.ID} }
	t.Cleanup(func() { openDetailFn = old })
	a.openMessageDetail(m)
	if len(opened.MediaFiles()) != 1 {
		t.Fatalf("放大阅读应带上前文图片 %+v", opened)
	}
}
