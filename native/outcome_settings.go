package main

import (
	"fmt"
	"math"
	"slices"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 设置 → 帮助与更新：「发送统计」与「数据与隐私」（同 Tauri OutcomeInsightsSection）。
// AI 处理筛选：同 Tauri TRANSFORM_RECIPES 四项，按事件 transformRecipeId 过滤（原生发送不产生配方，主要筛导入的 Tauri 统计）。

type outcomeUI struct {
	rng     string // 7d | 30d | all；空 = 30d
	profile string // 空 = 全部发送方案
	recipe  string // 空 = 全部 AI 处理
	detail  bool   // 「趋势和详细数据」展开
}

var outcomeRecipes = []struct{ id, label string }{
	{"summarize", "总结要点"}, {"extract-actions", "提取行动项"}, {"improve-prompt", "优化 Prompt"}, {"structure-requirements", "结构化需求"},
}

var outcomeRanges = []struct{ id, label string }{{"7d", "近 7 天"}, {"30d", "近 30 天"}, {"all", "全部保留期"}}

var outcomeReasonLabel = map[string]string{
	"target-not-ready":     "目标不可用",
	"draft-target-changed": "目标已变化",
	"target_exited":        "目标已退出",
	"paste_failed":         "粘贴失败",
	"enter_failed":         "回车失败",
	"restored":             "完整恢复",
	"restoredPartial":      "部分恢复",
	"skippedUserChanged":   "保留用户新复制内容",
	"nothingToRestore":     "无需恢复",
	"restoreFailed":        "恢复失败",
	"notOwned":             "剪贴板所有权已变化",
}

func fmtPercent(m store.OutcomeMetrics) string {
	if m.Attempts == 0 {
		return "—"
	}
	return fmt.Sprintf("%d%%", int(math.Round(m.SuccessRate*100)))
}

func fmtOutcomeDuration(d time.Duration) string {
	switch {
	case d < 0:
		return "—"
	case d < time.Minute:
		return fmt.Sprintf(tr("%d 秒"), int(math.Round(d.Seconds())))
	case d < 10*time.Minute:
		return fmt.Sprintf(tr("%.1f 分钟"), d.Minutes())
	}
	return fmt.Sprintf(tr("%d 分钟"), int(math.Round(d.Minutes())))
}

func (a *app) outcomeRange() string { return cmpOr(a.outUI.rng, "30d") }

func (a *app) outcomeMetrics(st store.Settings, events []store.OutcomeEvent) store.OutcomeMetrics {
	return store.AggregateOutcomes(events, store.OutcomeFilter{Range: a.outcomeRange(), Now: a.now(), Profile: a.outUI.profile, Recipe: a.outUI.recipe,
		Epoch: st.OutcomeEpoch, Loc: time.Local})
}

func (a *app) outcomeSections(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setSection {
	events := slices.DeleteFunc(a.store.Outcomes(), func(e store.OutcomeEvent) bool { return e.Epoch != st.OutcomeEpoch })
	m := a.outcomeMetrics(st, events)
	has := len(events) > 0
	ri := max(0, slices.IndexFunc(outcomeRanges, func(r struct{ id, label string }) bool { return r.id == a.outcomeRange() }))
	var rows []setRow
	if has {
		rows = append(rows, setRow{title: tr("查看范围"), control: func() {
			labels := make([]string, len(outcomeRanges))
			for i, r := range outcomeRanges {
				labels[i] = r.label
			}
			if segmented(c, k, &ri, labels...) {
				a.outUI.rng = outcomeRanges[ri].id
			}
		}})
	}
	rows = append(rows, a.outcomeSummaryRow(c, k, s, m, has, tr(outcomeRanges[ri].label)))
	if has {
		rows = append(rows, setRow{title: tr("趋势和详细数据"), hint: tr("查看发送原因、用时、结果和每日变化"), control: func() {
			icon := "chevron-right"
			if a.outUI.detail {
				icon = "chevron-down"
			}
			if ghostIconButton(c, k, "outcome-detail", icon, tr("趋势和详细数据"), 24, 14, false, true).Clicked() {
				a.outUI.detail = !a.outUI.detail
			}
		}, below: func() {
			if a.outUI.detail {
				a.outcomeDetails(c, k, s, st, m)
			}
		}})
	}
	retain := st.OutcomeRetainDays()
	state := tr("已开启")
	if st.OutcomeOff {
		state = tr("已暂停")
	}
	return []setSection{
		{title: tr("发送统计"), rows: rows},
		{title: tr("数据与隐私"), rows: []setRow{
			{title: tr("本机使用统计"), hint: state + " · " + tr("只记录次数、时间和状态，不保存卡片正文、Prompt 或密钥"), control: func() {
				on := !st.OutcomeOff
				if toggle(c, s, &on) {
					cur := a.store.Settings()
					cur.OutcomeOff = !on
					_ = a.store.SetSettings(cur)
				}
			}},
			{title: tr("统计保留时间"), hint: tr("最多保留 500 条，到期后自动清理。"), control: func() {
				settingsSelect(c, k, s, fmt.Sprintf(tr("%d 天"), retain), func(mm *ui.Menu) {
					for _, d := range []int{7, 30, 90} {
						if mm.Item(fmt.Sprintf(tr("%d 天"), d)).Radio(d == retain).Chosen() {
							a.store.SetOutcomeRetention(d, a.now())
						}
					}
				})
			}},
			{title: tr("会记录什么"), hint: tr("只记录时间、目标应用、发送方案、状态、数量和处理结果。不会保存正文、Prompt、API Key、目标 token 或脱敏对应关系。")},
			{title: tr("清除使用统计"), hint: tr("不会删除卡片、任务、附件或最近发送记录。"), control: func() {
				if button(c, s, "清除统计") {
					a.confirmClearOutcomes()
				}
			}},
		}},
	}
}

// outcomeSummaryRow：「这段时间」三项主指标；没有数据时显示空态（同 Tauri OutcomeMetricsSummary）。
func (a *app) outcomeSummaryRow(c *ui.Context, k tokens, s settingsTokens, m store.OutcomeMetrics, has bool, rangeLabel string) setRow {
	if m.Attempts == 0 {
		if !has {
			return setRow{title: tr("还没有可统计的发送"), hint: tr("完成一次发送后，这里会显示按键执行完成率、用时和敏感内容保护情况。"), below: func() {
				text(c, tr("发送第一条内容试试：双击 ⇧ Shift 捕获选中文本，勾选后 ⌘⏎ 发送。"), 11, 16, 400, k.muted).Wrap()
			}}
		}
		return setRow{title: tr("当前筛选没有数据"), hint: tr("换一个时间范围或清除详细筛选后再看。"), control: func() {
			if button(c, s, "清除筛选") {
				a.outUI.profile, a.outUI.recipe, a.outUI.rng = "", "", "all" // 「清除」放宽到最大范围（回 30 天可能仍为空）
			}
		}}
	}
	unresolved := max(0, m.Attempts-m.Sent)
	hint1 := tr("接收与提交未确认")
	if unresolved > 0 {
		hint1 = fmt.Sprintf(tr("受阻或失败 %d 次"), unresolved)
	}
	hint2 := tr("不代表目标接收率")
	if m.Insufficient {
		hint2 = tr("样本仍较少")
	}
	hint3 := tr("未发现需替换内容")
	if m.Findings > 0 {
		hint3 = fmt.Sprintf(tr("共发现 %d 项"), m.Findings)
	}
	note := ""
	switch {
	case m.Workflow >= 0:
		note = fmt.Sprintf(tr("一次完整流程通常用时 %s。"), fmtOutcomeDuration(m.Workflow))
	case m.Insufficient:
		note = tr("继续完成几次发送，累计 5 次后会开始显示趋势。")
	}
	return setRow{title: tr("这段时间"), hint: rangeLabel, control: func() {
		text(c, fmt.Sprintf(tr("共 %d 次尝试"), m.Attempts), 11, 16, 400, k.muted).SingleLine()
	}, below: func() {
		ui.Row(c).Gap(8).Children(func() {
			outcomeMetric(c, k, s, tr("按键执行完成"), itoa(m.Sent), hint1)
			outcomeMetric(c, k, s, tr("按键执行完成率"), fmtPercent(m), hint2)
			outcomeMetric(c, k, s, tr("已保护敏感内容"), itoa(m.Redactions), hint3)
		})
		if note != "" {
			text(c, note, 11, 16, 400, k.muted).Wrap()
		}
	}}
}

func outcomeMetric(c *ui.Context, k tokens, s settingsTokens, label, value, hint string) {
	ui.Column(c).Grow(1).Basis(0).Padding(8, 10).Gap(2).Radius(10).Background(s.card).Border(1, s.cardBorder).Children(func() {
		text(c, label, 11, 16, 400, k.muted).SingleLine()
		text(c, value, 17, 22, 600, k.fg).SingleLine()
		if hint != "" {
			text(c, hint, 10, 14, 400, k.muted).SingleLine()
		}
	})
}

func outcomeGroup(c *ui.Context, k tokens, title string, body func()) {
	ui.Column(c).Gap(6).Children(func() {
		text(c, title, 11, 16, 500, k.muted)
		ui.Row(c).Gap(8).Wrap().Children(body)
	})
}

// outcomeDetails：筛选 + 发送过程 / 用时 / 隐私与结果 / 原因与结果 / 每日发送（同 Tauri OutcomeMetricsDetails）。
func (a *app) outcomeDetails(c *ui.Context, k tokens, s settingsTokens, st store.Settings, m store.OutcomeMetrics) {
	ui.Column(c).Gap(12).Children(func() {
		ui.Row(c).Gap(8).Wrap().Children(func() { // 同 Tauri flex-wrap：发送方案 + AI 处理两个筛选并排
			label := tr("全部发送方案")
			for _, p := range st.TargetProfiles {
				if p.ID == a.outUI.profile {
					label = profileName(p)
				}
			}
			settingsSelect(c, k, s, label, func(mm *ui.Menu) {
				if mm.Item(tr("全部发送方案")).Radio(a.outUI.profile == "").Chosen() {
					a.outUI.profile = ""
				}
				for _, p := range st.TargetProfiles {
					if mm.Item(profileName(p)).Radio(a.outUI.profile == p.ID).Chosen() {
						a.outUI.profile = p.ID
					}
				}
			})
			recipe := tr("全部 AI 处理")
			for _, r := range outcomeRecipes {
				if r.id == a.outUI.recipe {
					recipe = tr(r.label)
				}
			}
			settingsSelect(c, k, s, recipe, func(mm *ui.Menu) {
				if mm.Item(tr("全部 AI 处理")).Radio(a.outUI.recipe == "").Chosen() {
					a.outUI.recipe = ""
				}
				for _, r := range outcomeRecipes {
					if mm.Item(tr(r.label)).Radio(a.outUI.recipe == r.id).Chosen() {
						a.outUI.recipe = r.id
					}
				}
			})
		})
		outcomeGroup(c, k, tr("发送过程"), func() {
			outcomeMetric(c, k, s, tr("发送尝试"), itoa(m.Attempts), "")
			outcomeMetric(c, k, s, tr("重试次数"), itoa(m.Retries), "")
			outcomeMetric(c, k, s, tr("目标变化阻止"), itoa(m.TargetBlocks), "")
			v := m.Verify
			outcomeMetric(c, k, s, tr("结果核验"), itoa(v["pass"]+v["needsReview"]+v["blocked"]),
				fmt.Sprintf(tr("通过 %d · 复核 %d · 阻止 %d"), v["pass"], v["needsReview"], v["blocked"]))
		})
		outcomeGroup(c, k, tr("用时"), func() {
			outcomeMetric(c, k, s, tr("准备到发送（中位）"), fmtOutcomeDuration(m.DraftToSend), "")
			outcomeMetric(c, k, s, tr("发送到回收（中位）"), fmtOutcomeDuration(m.SendToResult), "")
			outcomeMetric(c, k, s, tr("完整流程（中位）"), fmtOutcomeDuration(m.Workflow), "")
		})
		outcomeGroup(c, k, tr("隐私与结果"), func() {
			outcomeMetric(c, k, s, tr("发现敏感内容"), itoa(m.Findings), "")
			outcomeMetric(c, k, s, tr("已保护敏感内容"), itoa(m.Redactions), "")
		})
		dists := []struct {
			title string
			v     map[string]int
		}{{tr("阻止原因"), m.Blocked}, {tr("失败原因"), m.Failed}, {tr("剪贴板结果"), m.Clipboard}}
		dists = slices.DeleteFunc(dists, func(d struct {
			title string
			v     map[string]int
		}) bool {
			return len(d.v) == 0
		})
		if len(dists) > 0 {
			outcomeGroup(c, k, tr("原因与结果"), func() {
				for _, d := range dists {
					outcomeDistribution(c, k, s, d.title, d.v)
				}
			})
		}
		a.outcomeDaily(c, k, s, m)
	})
}

func outcomeDistribution(c *ui.Context, k tokens, s settingsTokens, title string, v map[string]int) {
	keys := make([]string, 0, len(v))
	for key := range v {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	ui.Column(c).Grow(1).Basis(0).MinWidth(150).Padding(8, 10).Gap(4).Radius(10).Background(s.card).Border(1, s.cardBorder).Children(func() {
		text(c, title, 12, 17, 500, k.fg)
		for _, key := range keys {
			ui.Row(c).Gap(8).Children(func() {
				label := key
				if l, ok := outcomeReasonLabel[key]; ok {
					label = tr(l)
				}
				text(c, label, 11, 16, 400, k.muted).SingleLine().Grow(1).Basis(0)
				text(c, itoa(v[key]), 11, 16, 400, k.fg).SingleLine()
			})
		}
	})
}

// outcomeDaily：每日发送柱状图（浅色柱高 = 尝试数，深色填充 = 成功占比）+ 趋势结论。
func (a *app) outcomeDaily(c *ui.Context, k tokens, s settingsTokens, m store.OutcomeMetrics) {
	ui.Column(c).Padding(8, 10).Gap(6).Radius(10).Background(s.card).Border(1, s.cardBorder).Children(func() {
		ui.Row(c).Children(func() {
			text(c, tr("每日发送"), 12, 17, 500, k.fg).Grow(1)
			text(c, fmt.Sprintf(tr("样本 %d"), m.Sample), 10, 14, 400, k.muted)
		})
		if len(m.Daily) == 0 {
			text(c, tr("暂无样本"), 11, 16, 400, k.muted).Padding(16, 0).AlignSelf(ui.Center)
		} else {
			peak := 1
			for _, d := range m.Daily {
				peak = max(peak, d.Attempts)
			}
			ui.Row(c).Height(72).Gap(4).AlignItems(ui.End).Label(fmt.Sprintf(tr("每日发送柱状图，共 %d 天"), len(m.Daily))).Children(func() {
				for _, d := range m.Daily {
					h := max(4, float32(d.Attempts)/float32(peak)*64)
					fill := float32(0)
					if d.Attempts > 0 {
						fill = h * float32(d.Sent) / float32(d.Attempts)
					}
					ui.Column(c).Grow(1).Basis(0).MaxWidth(20).Height(h).Radius(3).Background(s.primary.Alpha(0.25)).Justify(ui.End).
						Tooltip(fmt.Sprintf(tr("%s：尝试 %d，成功 %d"), d.Day, d.Attempts, d.Sent)).Children(func() {
						ui.Box(c).FillWidth().Height(fill).Radius(3).Background(s.primary)
					})
				}
			})
		}
		msg := tr("前后两段成功发送数量持平。")
		switch {
		case m.Insufficient:
			msg = tr("样本少于 5 次，不给出趋势结论。")
		case m.Trend == "":
			msg = tr("至少需要 2 个有发送的日期才给出趋势结论。")
		case m.Trend == "up":
			msg = tr("后半段成功发送数量上升。")
		case m.Trend == "down":
			msg = tr("后半段成功发送数量下降。")
		}
		text(c, msg, 10, 14, 400, k.muted).Wrap()
	})
}

// confirmClearOutcomes：清除前确认（同 Tauri ask 对话框）；Dialog.Message 阻塞，放后台。
func (a *app) confirmClearOutcomes() {
	go func() {
		r, err := mygo.Dialog.Message(mygo.MessageOptions{
			Title:   tr("清除使用统计"),
			Message: tr("清除使用统计？最近发送记录、卡片、任务和附件不会改变。"),
			Buttons: []string{tr("清除"), tr("取消")}, DefaultButton: 1,
		})
		if err != nil || r.Button != 0 {
			return
		}
		a.panelUpdate(func() { a.clearOutcomes() })
	}()
}

func (a *app) clearOutcomes() {
	a.store.ClearOutcomes()
	a.outUI = outcomeUI{}
	a.showHUD("ok", tr("使用统计已清除；最近发送记录仍保留"))
}
