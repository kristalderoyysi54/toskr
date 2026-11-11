package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/store"
)

const reviewOrig = "会议纪要：周五前完成 mygo 原生版对比报告，附内存与启动耗时。\n\n1. 主面板、任务、剪贴、订阅、秘文逐屏 1:1 对照\n2. 设置窗外壳与控件\n3. HUD 气泡与详情窗"
const reviewNew = "会议纪要：周五前完成 mygo 原生版对比报告，并附上内存占用与启动耗时两组数据。\n\n1. 主面板、任务、剪贴、订阅、秘文逐页与旧版对照截图\n2. 设置窗外壳与控件\n3. HUD 气泡与详情窗的对照也放进同一份"

func TestReviewSegments(t *testing.T) {
	segs := reviewSegments(reviewOrig, reviewNew)
	changes := 0
	for _, s := range segs {
		if !s.same {
			changes++
		}
	}
	if changes != 3 {
		t.Fatalf("应有 3 个改动块 %+v", segs)
	}
	rv := &aiReview{orig: reviewOrig, act: aiActions[0]}
	rv.finish(reviewNew)
	if rv.replace || rv.result(1) != reviewNew || rv.result(2) != reviewOrig {
		t.Fatalf("全采纳 = 新文，全还原 = 原文 replace=%v\n%q", rv.replace, rv.result(1))
	}
	// 只采纳第一处、还原其余
	first := true
	for i := range rv.segs {
		if !rv.segs[i].same {
			rv.segs[i].state = map[bool]int{true: 1, false: 2}[first]
			first = false
		}
	}
	got := rv.result(1)
	if !strings.Contains(got, "并附上内存占用") || !strings.Contains(got, "逐屏 1:1 对照") || strings.Contains(got, "同一份") {
		t.Fatalf("%q", got)
	}
	// 翻译类 / 几乎没有共同内容：全文替换视图
	tr1 := &aiReview{orig: "你好，世界", act: aiActions[2]}
	tr1.finish("Hello, world")
	other := &aiReview{orig: "第一行\n第二行", act: aiActions[0]}
	other.finish("完全不同的内容\n另一行")
	if !tr1.replace || !other.replace || tr1.result(1) != "Hello, world" {
		t.Fatal("应为全文替换")
	}
}

// 流式核对：增量边到边显示；完成后逐块采纳 / 还原，⌘⏎ 写回原卡并可撤销；生成中可停止，结果丢弃。
func TestAIReviewFlow(t *testing.T) {
	origStream, origOpen := aiRewriteStream, openDetailFn
	t.Cleanup(func() { aiRewriteStream, openDetailFn = origStream, origOpen })
	openDetailFn = func(a *app, n store.Note) {
		a.detailText = n.Text
		a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	}
	step, release := make(chan struct{}), make(chan struct{})
	aiRewriteStream = func(ctx context.Context, _ ai.Config, _, _ string, onDelta func(string)) (string, error) {
		onDelta(reviewNew[:30])
		step <- struct{}{}
		<-release
		onDelta(reviewNew[30:])
		return reviewNew, ctx.Err()
	}
	a, _ := testApp(t, reviewOrig)
	n := a.store.Notes()[0]
	a.runAI(n, aiActions[0])
	<-step
	dt := ui.NewTester(a.detailView, 560, 540)
	dt.Frame()
	rv := a.detail.review
	if rv == nil || rv.done || rv.buf != reviewNew[:30] || a.aiBusy != n.ID || !dt.HasText("生成中") || !dt.HasText("停止") {
		t.Fatalf("应在流式显示中 %+v %v", rv, dt.Texts())
	}
	close(release)
	waitFor(t, func() bool { return rv.done })
	dt.Frame()
	if a.aiBusy != "" || !dt.HasText("3 处改动") || !dt.HasText("全部采纳 ⌘⏎") || !dt.HasText("另存为新卡") {
		t.Fatalf("完成后应出核对视图 %v", dt.Texts())
	}
	shot := func(name string) {
		if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
			for _, dark := range []bool{false, true} {
				dt.SetDark(dark)
				dt.Frame()
				save(t, filepath.Join(dir, name+"-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), dt.Image())
			}
			dt.SetDark(false)
			dt.Frame()
		}
	}
	shot("ai-review")
	if err := dt.Click("还原"); err != nil { // 第一处还原
		t.Fatal(err)
	}
	dt.Frame()
	if !dt.HasText("3 处改动，已处理 1 处") || !dt.HasText("已还原") || !dt.HasText("应用 ⌘⏎") {
		t.Fatalf("%v", dt.Texts())
	}
	shot("ai-review-decided")
	dt.Key(ui.Cmd, ui.KeyEnter)
	dt.Frame()
	got, _ := a.store.Note(n.ID)
	if a.detail.review != nil || strings.Contains(got.Text, "并附上内存占用") || !strings.Contains(got.Text, "逐页与旧版对照截图") || !strings.Contains(got.Text, "同一份") {
		t.Fatalf("应写回：第一处保留原文，其余采纳 %q", got.Text)
	}
	if len(a.store.Notes()) != 1 || a.hudUndo == nil {
		t.Fatal("写回原卡，不新建；可撤销")
	}
	a.hudUndo()
	if back, _ := a.store.Note(n.ID); back.Text != reviewOrig {
		t.Fatalf("撤销应还原 %q", back.Text)
	}

	// 生成中停止：结果丢弃，可立即再发起
	started, hold := make(chan struct{}), make(chan struct{})
	aiRewriteStream = func(ctx context.Context, _ ai.Config, _, _ string, onDelta func(string)) (string, error) {
		close(started)
		<-hold
		return reviewNew, ctx.Err()
	}
	n, _ = a.store.Note(n.ID)
	a.runAI(n, aiActions[0])
	<-started
	dt.Frame()
	if err := dt.Click("停止"); err != nil {
		t.Fatalf("%v %v", err, dt.Texts())
	}
	dt.Frame()
	if a.aiBusy != "" || a.detail.review != nil || a.aiReviewing != nil {
		t.Fatal("停止后应解除忙碌并关闭核对")
	}
	close(hold)
	time.Sleep(20 * time.Millisecond)
	dt.Frame()
	if back, _ := a.store.Note(n.ID); back.Text != reviewOrig || a.detail.review != nil {
		t.Fatal("停止后的结果应丢弃")
	}

	// 翻译：并排显示，另存为新卡保留原卡
	aiRewriteStream = func(_ context.Context, _ ai.Config, _, _ string, onDelta func(string)) (string, error) {
		onDelta("Meeting notes")
		return "Meeting notes", nil
	}
	a.runAI(n, aiActions[2])
	waitFor(t, func() bool { return a.detail.review != nil && a.detail.review.done })
	dt.Frame()
	if !dt.HasText("全文结果，不逐段比对") || !dt.HasText("替换原文 ⌘⏎") || !dt.HasText("Meeting notes") {
		t.Fatalf("%v", dt.Texts())
	}
	if err := dt.Click("另存为新卡"); err != nil {
		t.Fatal(err)
	}
	if ns := a.store.Notes(); len(ns) != 2 || ns[0].Text != "Meeting notes" || ns[0].SourceApp != "AI · 翻译为英文" {
		t.Fatalf("%+v", ns)
	}
}

// 自定义动作：校验、去重、上限；出现在动作列表里；删除可撤销。
func TestCustomAIActions(t *testing.T) {
	a, _ := testApp(t)
	if a.addAIAction("", "x") == "" || a.addAIAction("润色", "重复内置名") == "" || a.addAIAction(strings.Repeat("长", 13), "x") == "" {
		t.Fatal("空 / 重名 / 超长应拒绝")
	}
	if issue := a.addAIAction(" 改成邮件 ", "把下面的文字改写成礼貌的工作邮件"); issue != "" {
		t.Fatal(issue)
	}
	acts := a.allAIActions()
	last := acts[len(acts)-1]
	if len(acts) != len(aiActions)+1 || last.label != "改成邮件" || !last.custom || last.replace {
		t.Fatalf("%+v", last)
	}
	if a.addAIAction("改成邮件", "再来一次") == "" {
		t.Fatal("自定义重名应拒绝")
	}
	a.removeAIAction(a.store.Settings().AIActions[0].ID)
	if len(a.allAIActions()) != len(aiActions) || a.hudUndo == nil {
		t.Fatal("应删除并可撤销")
	}
	a.hudUndo()
	if len(a.allAIActions()) != len(aiActions)+1 {
		t.Fatal("撤销应恢复")
	}
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 1400)
	a.setJump = "AI 智能"
	set.Frame()
	set.Frame()
	if !set.HasText("自定义动作") || !set.HasText("改成邮件") || !set.HasText("把下面的文字改写成礼貌的工作邮件") {
		t.Fatalf("%v", set.Texts())
	}
}

// 划词工具条的 AI 动作：只改写选中的一段并就地替换；期间内容变了就不替换。
func TestAIOnSelection(t *testing.T) {
	orig := aiRewrite
	t.Cleanup(func() { aiRewrite = orig })
	var got string
	hold := make(chan struct{})
	aiRewrite = func(_ context.Context, _ ai.Config, _, text string) (string, error) {
		got = text
		<-hold
		return "WORLD", nil
	}
	a, _ := testApp(t, "hello world 你好")
	n := a.store.Notes()[0]
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, editSel: [2]int{-1, -1}}
	a.runAIOnSelection(n, 6, 11, "world", aiActions[0])
	if a.aiBusy != n.ID {
		t.Fatal("应标记忙碌")
	}
	hold <- struct{}{}
	waitFor(t, func() bool { return a.aiBusy == "" && strings.HasPrefix(a.hudText, "已处理选中内容") })
	if cur, _ := a.store.Note(n.ID); got != "world" || a.detailSource(cur) != "hello WORLD 你好" {
		cur, _ := a.store.Note(n.ID)
		t.Fatalf("sent=%q now=%q", got, a.detailSource(cur))
	}
	// 期间内容变了：不替换
	n, _ = a.store.Note(n.ID)
	a.runAIOnSelection(n, 0, 5, "hello", aiActions[0])
	_ = a.store.Update(n.ID, "完全改掉了")
	a.detailText = "完全改掉了"
	hold <- struct{}{}
	waitFor(t, func() bool { return a.aiBusy == "" && a.hudText != "AI 处理选中内容…" }) // 回调在请求 goroutine 上跑：等它整段走完
	if cur, _ := a.store.Note(n.ID); cur.Text != "完全改掉了" || a.hudText != "选中的内容已变化，没有替换" {
		t.Fatalf("%q %q", cur.Text, a.hudText)
	}
}
