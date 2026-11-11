package main

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/store"
)

// 设置 → 更多功能 → AI（同 Tauri SettingsView AiSection）：总开关、提供商预设、Base URL、钥匙串密钥（覆盖 / 删除）、
// 模型名（手填或从服务取列表）、连接测试。

var aiPresets = []struct{ id, label, base, model string }{
	{"deepseek", "DeepSeek", "https://api.deepseek.com", "deepseek-chat"},
	{"openai", "OpenAI", "https://api.openai.com", "gpt-4o-mini"},
	{"kimi", "Kimi", "https://api.moonshot.cn", "moonshot-v1-8k"},
	{"qwen", "通义", "https://dashscope.aliyuncs.com/compatible-mode", "qwen-plus"},
	{"custom", "自定义", "", ""},
}

// matchAIPreset 同 Tauri matchPreset；原生版旧默认值带 /v1，也认作同一家。
func matchAIPreset(base string) string {
	b := strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(base), "/"), "/v1")
	for _, p := range aiPresets {
		if p.id != "custom" && p.base == b {
			return p.id
		}
	}
	return "custom"
}

type aiUI struct {
	models             []string
	fetching, testing  bool
	deleting, keyKnown bool
	newLabel, newInstr string // 自定义动作的新增草稿
}

var ( // 测试替换
	aiListModels = ai.ListModels
	aiTest       = ai.Test
	aiDeleteKey  = removeAIKey
)

func (a *app) aiDraftConfig() ai.Config {
	return ai.Config{Endpoint: strings.TrimSpace(a.setAIEnd), Key: aiKey(), Model: strings.TrimSpace(a.setAIModel)}
}

func (a *app) aiSettingsRows(c *ui.Context, k tokens, s settingsTokens, st store.Settings, changed *bool) []setRow {
	configured := aiKey() != ""
	keyHint := tr("未配置；保存后只能覆盖或删除，不会回显")
	if configured {
		keyHint = tr("已配置")
	}
	preset := matchAIPreset(a.setAIEnd)
	modelHint := tr("手动填写，或从服务获取列表")
	if n := len(a.aiUI.models); n > 0 {
		modelHint = fmt.Sprintf(tr("已获取 %d 个模型"), n)
	}
	return []setRow{
		{title: tr("AI 智能"), hint: tr("关闭后所有 AI 入口都不会发起请求"), control: func() {
			on := st.AIOn()
			if toggle(c, s, &on) {
				cur := a.store.Settings()
				cur.AIEnabled = &on
				_ = a.store.SetSettings(cur)
			}
		}},
		{title: tr("提供商（OpenAI 兼容）"), hint: tr("API Key 只存在 macOS 钥匙串；只有你主动使用 AI 时，相关文本才会发送到所选服务。"), below: func() {
			ui.Row(c).Wrap().Gap(6).Children(func() {
				for _, p := range aiPresets {
					chip := ui.Row(c).Height(22).Padding(0, 10).Radius(11).AlignItems(ui.Center).Key("aip-" + p.id).Role(ui.RoleButton).Label(tr(p.label))
					fg := k.muted
					if preset == p.id {
						chip.Background(s.primary.Alpha(0.1)).Border(1, s.cardBorder)
						fg = k.fg
					} else {
						chip.Border(1, s.cardBorder)
					}
					chip.Children(func() { text(c, tr(p.label), 11, 16, 500, fg) })
					if chip.Clicked() {
						a.setAIEnd = p.base
						if strings.TrimSpace(a.setAIModel) == "" {
							a.setAIModel = p.model
						}
						a.aiUI.models = nil
						*changed = true
					}
				}
			})
		}},
		{title: "Base URL", hint: tr("远程地址需 HTTPS；本机地址可用 HTTP"), control: func() {
			if textField(c, k, s, &a.setAIEnd, 280, "https://…", false) {
				*changed = true
			}
		}},
		{title: "API Key", hint: keyHint, control: func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				ph := tr("输入新密钥")
				if configured {
					ph = tr("输入新密钥以覆盖")
				}
				textField(c, k, s, &a.setAIKey, 180, ph, true)
				label := "保存"
				if configured {
					label = "覆盖"
				}
				if button(c, s, label) && strings.TrimSpace(a.setAIKey) != "" {
					if err := saveAIKey(strings.TrimSpace(a.setAIKey)); err != nil {
						a.showHUD("warn", tr("保存失败：")+err.Error())
					} else {
						a.setAIKey = ""
						a.showHUD("ok", tr("已存入钥匙串"))
					}
				}
				if configured {
					label := "删除"
					if a.aiUI.deleting {
						label = "删除中…"
					}
					if button(c, s, label) && !a.aiUI.deleting {
						a.confirmDeleteAIKey()
					}
				}
			})
		}},
		{title: tr("模型名"), hint: modelHint, control: func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				if len(a.aiUI.models) > 0 {
					cur := cmpOr(strings.TrimSpace(a.setAIModel), tr("选择模型…"))
					settingsSelect(c, k, s, cur, func(m *ui.Menu) {
						for _, id := range a.aiUI.models {
							if m.Item(id).Radio(id == a.setAIModel).Chosen() {
								a.setAIModel = id
								*changed = true
							}
						}
						m.Separator()
						if m.Item(tr("手动输入…")).Chosen() {
							a.aiUI.models = nil
						}
					})
				} else if textField(c, k, s, &a.setAIModel, 180, tr("模型 ID"), false) {
					*changed = true
				}
				label := "获取列表"
				switch {
				case a.aiUI.fetching:
					label = "获取中…"
				case len(a.aiUI.models) > 0:
					label = "刷新"
				}
				if button(c, s, label) && !a.aiUI.fetching {
					a.fetchAIModels()
				}
			})
		}},
		{title: tr("连接测试"), hint: tr("发送一次最小请求，无需先启用"), control: func() {
			label := "测试连接"
			if a.aiUI.testing {
				label = "测试中…"
			}
			if button(c, s, label) && !a.aiUI.testing {
				a.testAIConnection()
			}
		}},
		{title: tr("右键笔记 → AI"), hint: tr("润色 / 精简 / 翻译 / 写成提示词；结果在详情窗里边生成边显示，逐段采纳后写回原卡")},
		{title: tr("自定义动作"), hint: tr("名称加一句指令，出现在卡片右键 AI 菜单和详情窗「处理」里"), below: func() { a.aiActionEditor(c, k, s) }},
	}
}

const aiActionMax = 12

// addAIAction：新增自定义动作；返回问题说明（空 = 成功）。
func (a *app) addAIAction(label, instr string) string {
	label, instr = strings.TrimSpace(label), strings.TrimSpace(instr)
	st := a.store.Settings()
	switch {
	case label == "" || instr == "":
		return "名称和指令都要填"
	case len([]rune(label)) > 12:
		return "名称最多 12 个字"
	case len([]rune(instr)) > 400:
		return "指令最多 400 个字"
	case len(st.AIActions) >= aiActionMax:
		return "最多 12 个自定义动作"
	}
	for _, x := range a.allAIActions() {
		if x.label == label {
			return "已有同名动作"
		}
	}
	st.AIActions = append(st.AIActions, store.AIAction{ID: fmt.Sprintf("act-%d", a.now().UnixNano()), Label: label, Instruction: instr})
	_ = a.store.SetSettings(st)
	return ""
}

func (a *app) removeAIAction(id string) {
	st := a.store.Settings()
	prev := slices.Clone(st.AIActions)
	st.AIActions = slices.DeleteFunc(slices.Clone(st.AIActions), func(x store.AIAction) bool { return x.ID == id })
	_ = a.store.SetSettings(st)
	a.showHUDUndo("ok", tr("已删除自定义动作"), func() { a.patchSettings(func(x *store.Settings) { x.AIActions = prev }) })
}

// aiActionEditor：已有动作列表（悬停出删除）+ 一行新增表单。
func (a *app) aiActionEditor(c *ui.Context, k tokens, s settingsTokens) {
	u := &a.aiUI
	ui.Column(c).Gap(6).Margin(6, 0, 0, 0).Key("ai-actions").Children(func() {
		for _, x := range a.store.Settings().AIActions {
			row := ui.Row(c).Gap(8).Padding(4, 4, 4, 8).Radius(6).Background(k.track).AlignItems(ui.Center).Key("aia-" + x.ID)
			hov := row.Hovered()
			row.Children(func() {
				text(c, x.Label, 12, 17, 500, k.fg).SingleLine().Shrink(0).MaxWidth(140)
				text(c, x.Instruction, 11, 16, 400, k.muted).SingleLine().Grow(1).Basis(0).Tooltip(x.Instruction)
				if ghostIconButton(c, k, "aia-rm-"+x.ID, "trash-2", tr("删除")+" "+x.Label, 22, 13, true, hov).Clicked() {
					a.removeAIAction(x.ID)
				}
			})
		}
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			textField(c, k, s, &u.newLabel, 120, tr("名称，如「改成邮件」"), false)
			ui.Row(c).Grow(1).Basis(0).Height(32).Padding(0, 8).Radius(10).Background(s.input).Border(1, s.inputBorder).AlignItems(ui.Center).Children(func() {
				ui.TextInputBase(c, &u.newInstr).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).TextColor(k.fg).PlaceholderColor(k.muted).
					Placeholder(tr("指令，如「把下面的文字改写成礼貌的工作邮件」")).Label(tr("自定义动作的指令"))
			})
			if button(c, s, "添加") {
				if issue := a.addAIAction(u.newLabel, u.newInstr); issue != "" {
					a.showHUD("warn", tr(issue))
				} else {
					u.newLabel, u.newInstr = "", ""
				}
			}
		})
	})
}

func (a *app) requireAIKey() bool {
	if aiKey() != "" {
		return true
	}
	a.showHUD("info", tr("请先把 AI API Key 存入 macOS 钥匙串"))
	return false
}

func (a *app) fetchAIModels() {
	if !a.requireAIKey() {
		return
	}
	cfg := a.aiDraftConfig()
	a.aiUI.fetching = true
	go func() {
		ids, err := aiListModels(context.Background(), cfg)
		a.panelUpdate(func() {
			a.aiUI.fetching = false
			if err != nil {
				a.showHUD("warn", fmt.Sprintf(tr("获取失败：%s"), truncateRunes(err.Error(), 80)))
				return
			}
			a.aiUI.models = ids
			a.showHUD("ok", fmt.Sprintf(tr("获取到 %d 个模型"), len(ids)))
		})
	}()
}

func (a *app) testAIConnection() {
	if !a.requireAIKey() {
		return
	}
	cfg := a.aiDraftConfig()
	a.aiUI.testing = true
	go func() {
		err := aiTest(context.Background(), cfg)
		a.panelUpdate(func() {
			a.aiUI.testing = false
			if err != nil {
				a.showHUD("warn", fmt.Sprintf(tr("连接失败：%s"), truncateRunes(err.Error(), 120)))
				return
			}
			a.showHUD("ok", tr("AI 连接成功"))
		})
	}()
}

// confirmDeleteAIKey：删前确认（同 Tauri removeKey 的 ask 对话框）；Dialog.Message 阻塞，放后台。
func (a *app) confirmDeleteAIKey() {
	go func() {
		r, err := mygo.Dialog.Message(mygo.MessageOptions{
			Title:   tr("删除 AI 密钥"),
			Message: tr("删除后 AI 功能会停止，且 Toskr 无法恢复原密钥。确认从 macOS 钥匙串删除吗？"),
			Buttons: []string{tr("删除"), tr("取消")}, DefaultButton: 1,
		})
		if err != nil || r.Button != 0 {
			return
		}
		a.panelUpdate(func() { a.deleteAIKey() })
	}()
}

func (a *app) deleteAIKey() {
	a.aiUI.deleting = true
	err := aiDeleteKey()
	a.aiUI.deleting = false
	if err != nil {
		a.showHUD("warn", tr("AI 密钥删除失败；原密钥仍保留"))
		return
	}
	a.setAIKey = ""
	a.aiUI.models = nil
	a.showHUD("ok", tr("AI 密钥已删除"))
}
