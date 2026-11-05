package main

import (
	"context"
	"errors"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

const aiKeyName = "ai-api-key"

type aiAction struct{ label, instruction string }

var aiActions = []aiAction{
	{"润色", "把下面的文字润色得更清晰通顺，保持原意和语言。"},
	{"精简", "把下面的文字压缩到一半长度以内，保留关键信息。"},
	{"翻译为英文", "把下面的文字翻译成自然的英文。"},
	{"翻译为中文", "把下面的文字翻译成自然的简体中文。"},
	{"写成提示词", "把下面的需求改写成给 AI 编码助手的清晰指令：目标、约束、验收标准。"},
}

func aiKey() string {
	k, err := mygo.Secrets.Get(aiKeyName)
	if err != nil {
		return ""
	}
	return string(k)
}

// runAI 改写笔记：结果作为新笔记插在原笔记上方（原文保留，便于对照与撤销）。
func (a *app) runAI(n store.Note, act aiAction) {
	if a.aiBusy != "" {
		return
	}
	st := a.store.Settings()
	cfg := ai.Config{Endpoint: st.AIEndpoint, Key: aiKey(), Model: st.AIModel}
	a.aiBusy = n.ID
	go func() {
		out, err := ai.Rewrite(context.Background(), cfg, act.instruction, n.Text)
		diag.Push("AI: %s %d→%d 字 err=%v", act.label, len([]rune(n.Text)), len([]rune(out)), err != nil)
		a.panel.Update(func() {
			a.aiBusy = ""
			if err != nil {
				if errors.Is(err, ai.ErrNoKey) {
					a.openSettings()
				}
				a.showHUD("warn", err.Error())
				return
			}
			_, _, _ = a.store.Add(store.Note{Section: n.Section, Text: out, SourceApp: "AI · " + tr(act.label)})
			a.selected = 0
			a.showHUD("added", tr(act.label)+tr("完成"))
		})
	}()
}
