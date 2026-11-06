package main

import (
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

func outcomeTypes(evs []store.OutcomeEvent) []string {
	var out []string
	for _, e := range evs {
		out = append(out, e.Type)
	}
	return out
}

// 发送链路埋点：准备 → 开始 → 发出（与「最近发送」同一个 ID）→ 剪贴板还原；回复关联、回复检查各记一条；没有目标记受阻。
func TestOutcomeEventsAlongSendPath(t *testing.T) {
	a, _ := testApp(t, "写个周报")
	a.target = macos.FrontApp{PID: 42, Name: "ChatGPT", BundleID: "com.openai.chat"}
	src := a.store.Notes()[0]
	a.outcomeDraftCreated(2)
	out := a.outcomeStarted()
	a.out = out // 同 deliver 的收尾闭包
	a.finishDeliver(a.target, []string{src.ID}, []string{src.Text}, nil, 1, sendRedaction{}, "稳妥发送", core.CheckVerified, nil)
	a.out = outcomeDraft{}
	a.outcomeClipboard(out, "restored")
	d := a.store.Deliveries()[0]
	if d.ID != out.id {
		t.Fatalf("发送记录应沿用统计 ID %s vs %s", d.ID, out.id)
	}
	evs := a.store.Outcomes()
	want := []string{store.OutDraft, store.OutStarted, store.OutSent, store.OutClipOK}
	if got := outcomeTypes(evs); len(got) != 4 || got[0] != want[0] || got[2] != want[2] || got[3] != want[3] {
		t.Fatalf("事件序列 %v", got)
	}
	if evs[2].Findings != 2 || evs[2].Redactions != 1 || evs[2].Profile == "" {
		t.Fatalf("结果事件应带命中 / 替换 / 方案 %+v", evs[2])
	}
	reply, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "周报如下", BundleID: "com.openai.chat"})
	a.linkReply(d, reply)
	reply, _ = a.store.Note(reply.ID)
	a.openVerify(reply)
	a.runVerify()
	got := outcomeTypes(a.store.Outcomes())
	if got[len(got)-2] != store.OutResult || got[len(got)-1] != store.OutVerified {
		t.Fatalf("应记回复关联与检查 %v", got)
	}

	a.target = macos.FrontApp{}
	a.send([]store.Note{src})
	last := a.store.Outcomes()
	if e := last[len(last)-1]; e.Type != store.OutBlocked || e.Reason != "target-not-ready" {
		t.Fatalf("没有目标应记受阻 %+v", e)
	}
	m := a.outcomeMetrics(a.store.Settings(), a.store.Outcomes())
	if m.Attempts != 2 || m.Sent != 1 || m.Verify["pass"]+m.Verify["needsReview"]+m.Verify["blocked"] != 1 || m.Clipboard["restored"] != 1 {
		t.Fatalf("聚合 %+v", m)
	}
}

func TestOutcomeReasonMapping(t *testing.T) {
	for err, want := range map[error]string{core.ErrTargetFocus: "target-not-ready", core.ErrTargetChanged: "draft-target-changed", core.ErrEmpty: "paste_failed"} {
		if _, r := outcomeReason(err); r != want {
			t.Fatalf("%v → %s，应为 %s", err, r, want)
		}
	}
}

// 设置 → 帮助与更新：空态 → 有数据后「这段时间」三项 + 展开详情 → 清除统计。
func TestOutcomeSettingsSection(t *testing.T) {
	a, _ := testApp(t, "写个周报")
	set := ui.NewTester(a.settingsView, 1040, 4000)
	a.setJump = "帮助与更新"
	set.Frame()
	set.Frame()
	for _, s := range []string{"发送统计", "还没有可统计的发送", "数据与隐私", "本机使用统计", "统计保留时间", "清除使用统计"} {
		if !set.HasText(s) {
			t.Fatalf("缺少 %q：%v", s, set.Texts())
		}
	}
	a.target = macos.FrontApp{PID: 42, Name: "ChatGPT", BundleID: "com.openai.chat"}
	src := a.store.Notes()[0]
	for i := 0; i < 2; i++ {
		a.outcomeDraftCreated(1)
		a.out = a.outcomeStarted()
		a.finishDeliver(a.target, []string{src.ID}, []string{src.Text}, nil, 1, sendRedaction{}, "稳妥发送", core.CheckVerified, nil)
		a.out = outcomeDraft{}
	}
	set.Frame()
	for _, s := range []string{"这段时间", "共 2 次尝试", "按键执行完成", "100%", "共发现 2 项", "继续完成几次发送，累计 5 次后会开始显示趋势。"} {
		if !set.HasText(s) {
			t.Fatalf("缺少 %q：%v", s, set.Texts())
		}
	}
	a.outUI.detail = true // 标题文字与展开钮同名，Tester 点到的是标题文字
	set.Frame()
	for _, s := range []string{"发送过程", "用时", "隐私与结果", "每日发送", "样本少于 5 次，不给出趋势结论。", "全部发送方案"} {
		if !set.HasText(s) {
			t.Fatalf("展开后缺少 %q：%v", s, set.Texts())
		}
	}
	a.clearOutcomes()
	set.Frame()
	if !set.HasText("还没有可统计的发送") || a.hudText != "使用统计已清除；最近发送记录仍保留" || len(a.store.Deliveries()) != 2 {
		t.Fatalf("清除后应回空态且保留最近发送 %q %v", a.hudText, set.Texts())
	}
}
