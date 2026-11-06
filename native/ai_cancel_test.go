package main

import (
	"context"
	"testing"

	"github.com/toskr/native/internal/ai"
)

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
	a, tt := testApp(t, "原文")
	n := a.store.Notes()[0]
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
	if len(a.store.Notes()) != 1 {
		t.Fatalf("取消后的结果应丢弃：%d 条", len(a.store.Notes()))
	}
	// 取消后可立即发起新请求
	aiRewrite = func(context.Context, ai.Config, string, string) (string, error) { return "新结果", nil }
	a.runAI(n, aiActions[0])
	waitFor(t, func() bool { return len(a.store.Notes()) == 2 })
}
