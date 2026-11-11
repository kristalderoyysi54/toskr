package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

func fanApps() []macos.AppInfo {
	return []macos.AppInfo{
		{PID: 71, BundleID: "com.openai.chat", Name: "ChatGPT", StartedMs: 1},
		{PID: 72, BundleID: "com.anthropic.claudefordesktop", Name: "Claude", StartedMs: 2},
		{PID: 73, BundleID: "com.todesktop.cursor", Name: "Cursor", StartedMs: 3},
		{PID: 74, BundleID: "com.apple.Notes", Name: "备忘录", StartedMs: 4},
	}
}

// 同时发到多个应用：依次切目标逐个发送，记同一组编号；之后从这些应用捕获的回复自动关联，凑够两家可对比。
func TestFanoutSendAndCompare(t *testing.T) {
	a, _ := testApp(t, "解释一下 Go 的 range-over-func")
	sys := &recSys{}
	a.sys = sys
	orig := runningTargets
	t.Cleanup(func() { runningTargets = orig })
	runningTargets = fanApps
	n := a.store.Notes()[0]
	apps := fanApps()
	a.startFanout([]store.Note{n}, apps[:3])
	waitFor(t, func() bool { // 每个目标各自过一遍预检（有就放行）；投递收尾排在主线程队列里，测试里手动排空
		submitPending(a)
		a.drainUpdates()
		return a.fanout == nil
	})
	ds := a.store.Deliveries()
	if len(ds) != 3 || len(sys.sent()) != 3 {
		t.Fatalf("应发 3 次：%d 条记录，%d 次粘贴", len(ds), len(sys.sent()))
	}
	group := ds[0].Fanout
	names := map[string]bool{}
	for _, d := range ds {
		if d.Fanout != group || group == "" || d.Status != "sent" {
			t.Fatalf("同一组编号 %+v", d)
		}
		names[d.TargetName] = true
	}
	if !names["ChatGPT"] || !names["Claude"] || !names["Cursor"] || a.hudText != "已发到 ChatGPT、Claude、Cursor" {
		t.Fatalf("%v hud=%q", names, a.hudText)
	}
	// 从目标应用捕获的回复：自动关联到那次发送
	r1, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "range-over-func 让函数可以被 range。\n它在 Go 1.23 进入正式版。\n要注意 yield 返回 false 后必须停止。", BundleID: "com.openai.chat", SourceApp: "ChatGPT"})
	if msg := a.autoLinkFanoutReply(r1); msg != "已收为 ChatGPT 的回复" {
		t.Fatalf("%q", msg)
	}
	if len(a.fanoutReplies(group)) != 1 {
		t.Fatal("一家")
	}
	a.openReplyCompare(group)
	if a.detail.compare != "" || a.hudText != "至少收到两家的回复才能对比" {
		t.Fatal("一家不能对比")
	}
	r2, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "它在 Go 1.23 进入正式版。\n迭代器函数的签名是 func(yield func(K, V) bool)。\n要注意 yield 返回 false 后必须停止。", BundleID: "com.anthropic.claudefordesktop", SourceApp: "Claude"})
	if msg := a.autoLinkFanoutReply(r2); !strings.Contains(msg, "已有 2 家") {
		t.Fatalf("%q", msg)
	}
	other, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "无关内容", BundleID: "com.apple.Safari"})
	if a.autoLinkFanoutReply(other) != "" || a.autoLinkFanoutReply(r1) != "" {
		t.Fatal("别的应用 / 已关联过的不再关联")
	}
	cur, _ := a.store.Note(r2.ID)
	if a.fanoutOf(cur) != group {
		t.Fatal("回复卡应能找到所属的组")
	}
	// 对比视图
	origOpen := openDetailFn
	t.Cleanup(func() { openDetailFn = origOpen })
	openDetailFn = func(a *app, n store.Note) {
		a.detailText = n.Text
		a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	}
	a.openReplyCompare(group)
	dt := ui.NewTester(a.detailView, 640, 420)
	dt.Frame()
	for _, s := range []string{"对比回复 · 2 个应用", "ChatGPT", "Claude", "迭代器函数的签名是 func(yield func(K, V) bool)。", "浅底：不是每家都说到的内容；灰字：各家一致"} {
		if !dt.HasText(s) {
			t.Fatalf("缺 %q %v", s, dt.Texts())
		}
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		for _, dark := range []bool{false, true} {
			dt.SetDark(dark)
			dt.Frame()
			save(t, filepath.Join(dir, "compare-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), dt.Image())
		}
	}
	dt.Key(0, ui.KeyEscape)
	dt.Frame()
	if a.detail.compare != "" || a.detail.id == "" {
		t.Fatal("Esc 回到这张卡，不关窗")
	}
}

func TestCompareLines(t *testing.T) {
	got := compareLines([]string{"甲\n\n共同  的一行\n只有一", "共同 的一行\n只有二\n甲", "甲\n共同 的一行"})
	if len(got) != 3 || len(got[0]) != 3 || !got[0][0].common || !got[0][1].common || got[0][2].common || got[1][1].common || !got[1][2].common {
		t.Fatalf("%+v", got)
	}
}

// 选目标浮层：最多 3 个、少于 2 个不能发；取消预检即停止后面的目标。
func TestFanoutPickerAndCancel(t *testing.T) {
	a, _ := testApp(t, "一段问题 demo.user@example.com")
	a.sys = &recSys{}
	orig := runningTargets
	t.Cleanup(func() { runningTargets = orig })
	runningTargets = fanApps
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, pinned: true}
	a.detail.fanOpen = true
	dt := ui.NewTester(a.detailView, 560, 540)
	dt.Frame()
	if !dt.HasText("至少选 2 个应用") || !dt.HasText("已选 0 / 3") {
		t.Fatalf("%v", dt.Texts())
	}
	for _, name := range []string{"ChatGPT", "Claude", "Cursor", "备忘录"} {
		_ = dt.Click(name)
		dt.Frame()
	}
	if len(a.fanPick) != 3 || !dt.HasText("发到 3 个应用") {
		t.Fatalf("最多 3 个 %v", a.fanPick)
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		save(t, filepath.Join(dir, "fanout-picker.png"), dt.Image())
	}
	if err := dt.Click("发到 3 个应用"); err != nil {
		t.Fatal(err)
	}
	if a.fanout == nil || a.detail.fanOpen || len(a.pending) == 0 { // 含邮箱：第一个目标停在预检
		t.Fatalf("应开始并停在预检 fanout=%v pending=%d", a.fanout != nil, len(a.pending))
	}
	a.cancelPending()
	time.Sleep(10 * time.Millisecond)
	if a.fanout != nil || len(a.store.Deliveries()) != 0 {
		t.Fatal("取消预检应停止整组发送")
	}
}

// 上一组停在预检里没处理（确认条没被看到）时再次发起：作废旧的一组并重新开始，不能静默忽略。
func TestFanoutRestartsWhenPreviousStuck(t *testing.T) {
	a, _ := testApp(t, "一段问题 demo.user@example.com")
	a.sys = &recSys{}
	notes := a.store.Notes()[:1]
	a.startFanout(notes, fanApps()[:2])
	first := a.fanout
	if first == nil || len(a.pending) == 0 {
		t.Fatalf("应停在预检 fanout=%v pending=%d", first != nil, len(a.pending))
	}
	a.startFanout(notes, fanApps()[1:3])
	if a.fanout == nil || a.fanout == first || len(a.pending) == 0 {
		t.Fatalf("应作废旧的一组并重新停在预检 same=%v pending=%d", a.fanout == first, len(a.pending))
	}
	if got, want := a.target.Name, fanApps()[1].Name; got != want {
		t.Fatalf("目标应是新一组的第一个 %q != %q", got, want)
	}
}
