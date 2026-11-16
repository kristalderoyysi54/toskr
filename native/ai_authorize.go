package main

import (
	"errors"
	"fmt"
	"net/url"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/core"
)

// AI 请求的隐私闸（同 Tauri authorize_payload）：每次请求发出前扫描实发内容——扫不全直接拒绝；含敏感内容时弹框说明用途、
// 目标地址与命中类别，用户点「仅本次发送原文」才发。不看设置里的隐私检查开关与关掉的提示类别：那些决定只管粘贴到其他应用，
// 不适用于发给 AI 服务。

var (
	errAITooLarge = errors.New("AI 请求超过隐私检查上限，未发送")
	errAIDeclined = errors.New("已取消向 AI 发送敏感原文")
)

// aiAsk：确认窗（测试替换）。所有 AI 请求都在后台 goroutine 里发，阻塞等待不会卡渲染帧。
var aiAsk = func(s confirmSpec) bool { return confirmAsk(s) }

func init() {
	ai.Authorize = authorizeAI
	for k, v := range map[string]string{
		"发给 AI 的原文含敏感内容": "Text for AI contains sensitive content", "仅本次发送原文": "Send original once",
		"此前对其他应用「保留原文」的决定不适用于 AI 请求。": "Earlier choices to keep original text for other apps don't apply to AI requests.",
		"%s %d 处": "%s ×%d", "、": ", ", "AI 请求": "AI request", "自定义敏感字段": "Custom sensitive field",
		"发送中止：文本超出本地隐私扫描上限，无法在发送前复核": "Send stopped: text exceeds the local privacy scan limit and can't be checked before sending",
		"超出隐私扫描上限":       "Over privacy scan limit",
		"已取消向 AI 发送敏感原文": "Sending sensitive original text to AI canceled", "AI 请求超过隐私检查上限，未发送": "AI request exceeds the privacy check limit; not sent",
		"AI 拆解子任务": "AI subtasks", "笔记转任务": "Note to task", "生成标题": "Suggest title", "解析任务": "Parse task",
		"检查回复": "Check reply", "草拟回复": "Draft reply", "模板助手": "Template assistant", "图内翻译": "In-image translation",
		"私钥": "private key", "授权凭据": "authorization credential", "密钥/凭据": "key or credential", "数据库连接": "database URL",
		"邮箱": "email", "手机号": "phone number", "身份证号": "national ID number", "银行卡号": "bank card number", "IP 地址": "IP address", "会话标识": "session ID",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}

func authorizeAI(r ai.Request) error {
	var custom []string
	if liveApp != nil {
		custom = liveApp.store.Settings().FirewallCustomFields
	}
	summary, err := aiSensitiveSummary(core.Rules{CustomFields: custom}, r.System, r.User)
	if err != nil || len(summary) == 0 {
		return err
	}
	purpose := r.Purpose
	if purpose == "" {
		purpose = tr("AI 请求")
	}
	spec := confirmSpec{
		icon: "shield-alert", danger: true, title: tr("发给 AI 的原文含敏感内容"),
		facts: []confirmFact{{label: tr("用途"), value: purpose}, {label: tr("AI 服务"), value: endpointHost(r.Endpoint)}, {label: tr("原文包含"), tags: summary}},
		note:  tr("此前对其他应用「保留原文」的决定不适用于 AI 请求。"), ok: tr("仅本次发送原文"),
	}
	if !aiAsk(spec) {
		return errAIDeclined
	}
	return nil
}

// endpointHost：确认框里只写 AI 服务的主机名（完整接口路径长、换行难读）；解析失败原样返回。
func endpointHost(endpoint string) string {
	if u, err := url.Parse(endpoint); err == nil && u.Host != "" {
		return u.Host
	}
	return endpoint
}

// aiSensitiveSummary：各段命中按类别计数（按首次出现排序），如「私钥 1 处」；任一段扫不全返回 errAITooLarge。
func aiSensitiveSummary(rules core.Rules, texts ...string) ([]string, error) {
	var order []string
	counts := map[string]int{}
	for _, t := range texts {
		if !core.ScanComplete(t) {
			return nil, errAITooLarge
		}
		for _, f := range core.Scan(t, rules) {
			label := tr(core.CategoryLabel[f.Category])
			if f.Category == "custom" {
				label = tr("自定义敏感字段")
			}
			if counts[label] == 0 {
				order = append(order, label)
			}
			counts[label]++
		}
	}
	out := make([]string, len(order))
	for i, l := range order {
		out[i] = fmt.Sprintf(tr("%s %d 处"), l, counts[l])
	}
	return out, nil
}
