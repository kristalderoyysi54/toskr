package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/imwatch"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

func msgApp(t *testing.T) (*app, *ui.Tester) {
	t.Helper()
	a, tt := testApp(t, "一条笔记")
	st := a.store.Settings()
	st.MessagesEnabled = true
	st.MessageRules = []store.MessageRule{{ID: "r1", Name: "发布规则", Enabled: true, Keywords: []string{"发布"}}}
	_ = a.store.SetSettings(st)
	now := time.Now().UnixMilli()
	a.store.IngestMessages([]store.Message{
		{ConversationID: "g1", ConversationName: "项目群", MessageID: "1", SenderName: "小王", Text: "@你 明天发布吗", MentionedSelf: true, OccurredAtMs: now - 2000,
			Context: []store.MessageContext{{MessageID: "0", SenderName: "小李", Text: "版本已经打好"}}},
		{ConversationID: "g1", ConversationName: "项目群", MessageID: "2", SenderName: "小张", Text: "发布窗口改到周五", MatchedRuleIDs: []string{"r1"}, OccurredAtMs: now - 1000},
	}, false)
	a.switchPage(pageNotes)
	a.noteSub = subMessages
	tt.Frame()
	return a, tt
}

// 内容 → 消息：子页签带未处理数；卡片显示发送者 / 命中原因 / 群名 / 正文；筛选栏计数。
func TestMessagesPageRenders(t *testing.T) {
	_, tt := msgApp(t)
	for _, s := range []string{"笔记", "消息", "小王", "@我", "项目群", "@你 明天发布吗", "小张", "发布规则", "待处理", "等待回复", "已处理", "前文 · 1"} {
		if !tt.HasText(s) {
			t.Fatalf("缺少 %q：%v", s, tt.Texts())
		}
	}
	if !tt.HasText("内容") {
		t.Fatal("消息开启后笔记页签应升格为「内容」")
	}
}

func TestMessageCardActions(t *testing.T) {
	a, tt := msgApp(t)
	if err := tt.Click("前文 · 1"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !tt.HasText("版本已经打好") || !tt.HasText("仅来自捕获时客户端内存，不会补拉历史或改变已读。") {
		t.Fatalf("前文应展开 %v", tt.Texts())
	}
	r, _ := tt.Find("小王")
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	if err := tt.Click("标记已处理"); err != nil {
		t.Fatalf("悬停应出浮钮：%v %v", err, tt.Texts())
	}
	tt.Frame()
	if tt.HasText("@你 明天发布吗") || a.store.Messages()[1].Status != "done" {
		t.Fatalf("标记处理后离开待处理栏 %+v", a.store.Messages())
	}
	a.hudUndo()
	tt.Frame()
	if !tt.HasText("@你 明天发布吗") {
		t.Fatal("撤销应回到待处理")
	}
	// 更多 → 等待回复：建「进行中」任务、消息转等待回复
	r, _ = tt.Find("小张")
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	if err := tt.Click("更多消息操作"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("等待回复"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	tasks := a.store.Tasks()
	if len(tasks) != 1 || tasks[0].Status != "doing" || tasks[0].Text != "[项目群] 发布窗口改到周五" {
		t.Fatalf("%+v", tasks)
	}
	tt.Click("等待回复")
	tt.Frame()
	if !tt.HasText("发布窗口改到周五") || !tt.HasText("已转任务") {
		t.Fatalf("等待回复栏应有这条 %v", tt.Texts())
	}
}

func TestMessageSelectionBulk(t *testing.T) {
	a, tt := msgApp(t)
	r, _ := tt.Find("小王")
	tt.Move(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	tt.Click("小王")
	tt.ClickWith(ui.Shift, "小张")
	tt.Frame()
	if !tt.HasText("已选 2") || tt.HasText("等待回复") {
		t.Fatalf("⇧ 范围选，批量条整行接管筛选栏 %v", tt.Texts())
	}
	if err := tt.Click("已处理"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	for _, m := range a.store.Messages() {
		if m.Status != "done" {
			t.Fatal("批量处理")
		}
	}
	tt.Click("已处理") // 筛选栏
	tt.Frame()
	tt.Key(ui.Cmd, ui.KeyA)
	tt.Frame()
	if !tt.HasText("已选 2") {
		t.Fatalf("⌘A 全选当前栏 %v", tt.Texts())
	}
	tt.Click("删除所选消息")
	tt.Frame()
	if len(a.store.Messages()) != 0 {
		t.Fatal("批量删除")
	}
	a.hudUndo()
	if len(a.store.Messages()) != 2 {
		t.Fatal("撤销删除")
	}
}

func TestMessageDraftReply(t *testing.T) {
	a, tt := msgApp(t)
	var gotSys, gotIn string
	old := msgAIRewrite
	msgAIRewrite = func(_ context.Context, _ ai.Config, sys, in string) (string, error) {
		gotSys, gotIn = sys, in
		return "好的，周五见", nil
	}
	t.Cleanup(func() { msgAIRewrite = old })
	a.draftReply(a.store.Messages()[1]) // 小王那条（带前文）
	for i := 0; i < 50 && a.msgDraftBusy != ""; i++ {
		time.Sleep(10 * time.Millisecond)
		a.drainUpdates()
	}
	tt.Frame()
	if !strings.Contains(gotSys, "回复助手") || !strings.Contains(gotIn, "捕获时已加载的前文：\n小李：版本已经打好") || !tt.HasText("好的，周五见") {
		t.Fatalf("%q %v", gotIn, tt.Texts())
	}
	tt.Click("存为笔记")
	if a.store.Section(store.SectionInbox)[0].Text != "好的，周五见" {
		t.Fatal("存为笔记")
	}
}

// 手动桥端到端：开启接收端 → 桥脚本 POST → 进账本 → 进「消息」页；重放账本不重复、删掉的不复活。
func TestManualBridgeEndToEnd(t *testing.T) {
	a, tt := msgApp(t)
	a.setIMManual(true)
	t.Cleanup(func() { a.im.bridge.Stop() })
	st := a.im.bridge.Status()
	if !st.Enabled || !strings.HasPrefix(st.Endpoint, "http://127.0.0.1:") {
		t.Fatal(st)
	}
	group := true
	body, _ := json.Marshal(imwatch.Message{BridgeVersion: 1, ConversationID: "g9", MessageID: "m9", ConversationName: "运维群", SenderUID: "u9",
		SenderName: "老周", MentionedSelf: true, IsGroup: &group, Text: "服务器重启了", CapturedAtMs: time.Now().UnixMilli()})
	resp, err := http.Post(st.Endpoint, "application/json", bytes.NewReader(body))
	if err != nil || resp.StatusCode != 200 {
		t.Fatal(err, resp)
	}
	resp.Body.Close()
	a.drainUpdates()
	tt.Frame()
	if !tt.HasText("服务器重启了") || a.hudText != tr("已捕获IM关注消息") {
		t.Fatalf("%v %q", tt.Texts(), a.hudText)
	}
	if !a.im.bridge.Status().Connected(time.Now().UnixMilli()) {
		t.Fatal("投递即视为桥已连接")
	}
	rs, _ := a.im.bridge.Recent(10)
	if len(rs) != 1 || rs[0].Message.Text != "服务器重启了" {
		t.Fatal("应进加密账本", rs)
	}
	if n := a.ingestIM(rs, true); n != 0 {
		t.Fatal("重放不重复", n)
	}
	a.store.RemoveMessages([]string{store.MessageKey("g9", "m9")})
	if n := a.ingestIM(rs, true); n != 0 {
		t.Fatal("删掉的不随重放复活")
	}
	script := imwatch.Script(st.Endpoint, "http", st.StartedAtMs, imRules(a.store.Settings().MessageRules))
	if !strings.Contains(script, st.Endpoint) || !strings.Contains(script, `"发布"`) {
		t.Fatal("脚本带接收端地址与规则")
	}
}

func TestMessageWatchSettings(t *testing.T) {
	a, _ := msgApp(t)
	old := imRegularApps
	t.Cleanup(func() { imRegularApps = old })
	imRegularApps = func() []macos.AppInfo {
		return []macos.AppInfo{{Name: "某 IM", BundleID: "com.example.im", BinPath: "/Applications/IM.app/Contents/MacOS/IM"}}
	}
	set := ui.NewTester(a.settingsView, 1040, 4000)
	a.setJump = "消息监听"
	set.Frame()
	set.Frame()
	if !set.HasText("先选择要监听的 IM") {
		t.Fatalf("%v", set.Texts())
	}
	set.Click("探测正在运行的应用")
	for i := 0; i < 50 && a.im.detecting; i++ {
		time.Sleep(5 * time.Millisecond)
		a.drainUpdates()
	}
	set.Frame()
	if err := set.Click("某 IM"); err != nil {
		t.Fatalf("%v %v", err, set.Texts())
	}
	set.Frame()
	if p := a.store.Settings().IMProfile; p == nil || p.BundleID != "com.example.im" || !set.HasText("当前目标：某 IM") || !set.HasText("自动接入（实验功能）") {
		t.Fatalf("%+v %v", p, set.Texts())
	}
	if !set.HasText("发布规则") || !set.HasText("收下 内容含「发布」 的消息") {
		t.Fatalf("规则列表 %v", set.Texts())
	}
	if err := set.Click("添加规则"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	a.im.form[1] = "运维群，值班群" // 占位文字不在可查文本里，直接填草稿
	set.Frame()
	if !set.HasText("将收下 群名/群号含「运维群」或「值班群」 的消息") {
		t.Fatalf("预览 %v", set.Texts())
	}
	set.Click("保存规则")
	set.Frame()
	if rs := a.store.Settings().MessageRules; len(rs) != 2 || rs[1].Name != "关注规则 2" || len(rs[1].GroupTerms) != 2 {
		t.Fatalf("%+v", rs)
	}
}

// 自动接入：需先有监听目标；开 → 以调试模式重启并注入（带规则），关 → 结束调试进程并按正常方式重开 IM。
func TestIMAutoToggle(t *testing.T) {
	a, _ := msgApp(t)
	oldStart, oldStop, oldApps := imStartAuto, imStopAuto, imRegularApps
	t.Cleanup(func() { imStartAuto, imStopAuto, imRegularApps = oldStart, oldStop, oldApps })
	imRegularApps = func() []macos.AppInfo { return nil }
	a.setIMAuto(true)
	for i := 0; i < 50 && a.im.detecting; i++ {
		time.Sleep(5 * time.Millisecond)
		a.drainUpdates()
	}
	if a.im.mode != "" || a.hudText != tr("未检测到正在运行的应用；请先打开要监听的 IM 再试") {
		t.Fatalf("没有目标时先探测 %q", a.hudText)
	}
	a.setIMProfile(&store.IMProfile{AppName: "某 IM", BundleID: "com.example.im", BinPath: "/Applications/IM.app/Contents/MacOS/IM"})
	var gotRules []imwatch.Rule
	imStartAuto = func(_ *imwatch.Bridge, p store.IMProfile, rules []imwatch.Rule, _ func(error)) (context.CancelFunc, *exec.Cmd, error) {
		gotRules = rules
		return func() {}, nil, nil
	}
	stopped := ""
	imStopAuto = func(_ context.CancelFunc, _ *exec.Cmd, bundle string) { stopped = bundle }
	a.setIMAuto(true)
	for i := 0; i < 50 && a.im.busy; i++ {
		time.Sleep(5 * time.Millisecond)
		a.drainUpdates()
	}
	if a.im.mode != "cdp" || len(gotRules) != 1 || gotRules[0].Keywords[0] != "发布" {
		t.Fatalf("%q %+v", a.im.mode, gotRules)
	}
	a.setIMAuto(false)
	for i := 0; i < 50 && a.im.busy; i++ {
		time.Sleep(5 * time.Millisecond)
		a.drainUpdates()
	}
	if a.im.mode != "" || stopped != "com.example.im" {
		t.Fatalf("%q %q", a.im.mode, stopped)
	}
}

// 卡片右键：与悬停浮钮同一组操作，「提醒我」是子菜单（快捷档）。
func TestMessageContextMenu(t *testing.T) {
	a, tt := msgApp(t)
	if err := tt.RightClick("小张"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("提醒我", "1 小时后"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	if ts := a.store.Tasks(); len(ts) != 1 || ts[0].DueAt.IsZero() {
		t.Fatalf("%+v", ts)
	}
	tt.RightClick("小王")
	if err := tt.ChooseMenuItem("删除消息"); err == nil {
		t.Fatal("同 Tauri：未处理的消息不能删")
	}
	tt.Key(0, ui.KeyEscape)
	var ids []string
	for _, m := range a.store.Messages() {
		ids = append(ids, m.ID)
	}
	a.store.SetMessagesStatus(ids, "done")
	a.reload()
	a.msgFilter = "done"
	tt.Frame()
	tt.RightClick("小王")
	if err := tt.ChooseMenuItem("删除消息"); err != nil {
		t.Fatal(err, tt.Texts())
	}
	if len(a.store.Messages()) != 1 {
		t.Fatal("删除")
	}
}
