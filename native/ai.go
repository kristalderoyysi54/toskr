package main

import (
	"context"
	"errors"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

const aiKeyName = "ai-api-key"

type aiAction struct {
	label, instruction string
	replace            bool // 全文替换类（翻译、改写成另一种文体）：结果并排显示，不做逐段差异
	custom             bool // 用户在设置里自己加的
}

var aiActions = []aiAction{
	{label: "润色", instruction: "把下面的文字润色得更清晰通顺，保持原意和语言。"},
	{label: "精简", instruction: "把下面的文字压缩到一半长度以内，保留关键信息。"},
	{label: "翻译为英文", instruction: "把下面的文字翻译成自然的英文。", replace: true},
	{label: "翻译为中文", instruction: "把下面的文字翻译成自然的简体中文。", replace: true},
	{label: "写成提示词", instruction: "把下面的需求改写成给 AI 编码助手的清晰指令：目标、约束、验收标准。", replace: true},
}

// allAIActions：内置动作 + 设置里的自定义动作（名称 + 一句指令）。
func (a *app) allAIActions() []aiAction {
	out := append([]aiAction(nil), aiActions...)
	for _, c := range a.store.Settings().AIActions {
		if strings.TrimSpace(c.Label) != "" && strings.TrimSpace(c.Instruction) != "" {
			out = append(out, aiAction{label: c.Label, instruction: c.Instruction, custom: true})
		}
	}
	return out
}

var aiRewrite = ai.Rewrite // 测试替换

var aiKey = func() string { // 测试替换
	if usesLegacyKeychain() { // 正式版：沿用旧版的钥匙串记录
		return legacyAIKey()
	}
	k, err := mygo.Secrets.Get(aiKeyName)
	if err != nil {
		return ""
	}
	return string(k)
}

// cancelAI 取消进行中的 AI 改写（同 Tauri cancelAiRequest：本地先放弃结果，同时中断 HTTP）。
func (a *app) cancelAI() {
	if a.aiCancel == nil {
		return
	}
	a.aiCancel()
	a.aiBusy, a.aiCancel = "", nil
	if rv := a.aiReviewing; rv != nil { // 核对流程：一并作废
		rv.dead, a.aiReviewing = true, nil
	}
	a.showHUD("info", tr("已取消 AI 请求"))
}

// aiBusyMark：卡片底栏的「AI 处理中」转圈 + 取消钮。
func (a *app) aiBusyMark(c *ui.Context, k tokens, id string) {
	if a.aiBusy != id {
		return
	}
	ui.Spinner(c).Size(10, 10)
	if a.aiCancel != nil && ghostIconButton(c, k, "ai-cancel-"+id, "x", tr("取消 AI 请求"), 16, 10, false, true).Clicked() {
		a.cancelAI()
	}
}

// runAI 改写笔记：结果作为新笔记插在原笔记上方（原文保留，便于对照与撤销）。
func (a *app) runAI(n store.Note, act aiAction) {
	if a.aiBusy != "" {
		return
	}
	if aiReviewable(n) { // 纯文字卡：在详情窗里流式显示并逐段核对
		a.startAIReview(n, act)
		return
	}
	st := a.store.Settings()
	cfg := ai.Config{Endpoint: st.AIEndpoint, Key: aiKey(), Model: st.AIModel, Off: !st.AIOn()}
	a.aiBusy = n.ID
	ctx, cancel := context.WithCancel(context.Background())
	a.aiCancel = cancel
	go func() {
		out, err := aiRewrite(ctx, cfg, act.instruction, n.Text)
		diag.Push("AI: %s %d→%d 字 err=%v", act.label, len([]rune(n.Text)), len([]rune(out)), err != nil)
		a.onMain(func() {
			if ctx.Err() != nil { // 已取消：结果丢弃（同 Tauri AiError cancelled）
				return
			}
			cancel()
			a.aiBusy, a.aiCancel = "", nil
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
