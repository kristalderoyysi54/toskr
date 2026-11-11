package main

import (
	"context"
	"testing"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/store"
)

// 图文混排卡不走核对流程：仍按旧方式把结果落成新卡；进行中可在卡片上取消，取消后的结果丢弃。
func TestCancelAIRewriteDropsResult(t *testing.T) {
	orig := aiRewrite
	t.Cleanup(func() { aiRewrite = orig })
	started, release := make(chan struct{}), make(chan struct{})
	done := make(chan struct{})
	aiRewrite = func(ctx context.Context, _ ai.Config, _, _ string) (string, error) {
		close(started)
		<-release
		defer close(done)
		return "改写结果", ctx.Err()
	}
	a, tt := testApp(t)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "图文原文", Blocks: []store.ContentBlock{
		{Type: "text", Text: "图文原文"}, {Type: "image", File: "a.png"}, {Type: "text", Text: "后半"}}})
	if aiReviewable(n) {
		t.Fatal("图文混排卡不应进核对流程")
	}
	a.reload()
	base := len(a.store.Notes())
	a.runAI(n, aiActions[0])
	<-started
	tt.Frame()
	if err := tt.Click("取消 AI 请求"); err != nil {
		t.Fatalf("进行中应有取消按钮 %v", tt.Texts())
	}
	if a.aiBusy != "" || a.aiCancel != nil {
		t.Fatal("取消后应立即解除忙碌")
	}
	close(release)
	<-done
	tt.Frame()
	if len(a.store.Notes()) != base {
		t.Fatalf("取消后的结果应丢弃：%d 条", len(a.store.Notes()))
	}
	// 取消后可立即发起新请求
	aiRewrite = func(context.Context, ai.Config, string, string) (string, error) { return "新结果", nil }
	a.runAI(n, aiActions[0])
	waitFor(t, func() bool { return len(a.store.Notes()) == base+1 })
}
