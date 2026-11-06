package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/store"
)

// 右键「AI 转任务」「AI 起标题」（同 Tauri lib/ai.ts noteToTaskSmart / suggestTitle 的提示词与截断规则）。

const onlyJSON = "只输出 JSON，不要任何解释文字，不要使用 markdown 代码块。"

const noteToTaskSystem = `你是笔记转任务助手。阅读笔记正文，提炼一个任务标题与若干检查项。
title：不超过30字，概括这段内容要做的核心事情。
checklist：3-8 条可执行步骤，动词开头、每条不超过20字；内容明显不含多步骤时可给 1-2 条或空数组。
输出结构：{"title": string, "checklist": string[]}
` + onlyJSON

const titleSystem = `你是标题生成助手。为给出的笔记内容生成一个不超过 12 个字的简洁标题，
准确概括核心主题，不加标点符号，不加引号。
输出结构：{"title": string}
` + onlyJSON

const splitSystem = `你是任务拆解助手。把给出的任务（可能带备注/已有检查项）拆解为 3-8 条具体可执行的检查项。
要求：动词开头、可勾选完成、每条不超过20字、按执行顺序排列、不要重复任务标题本身；
若提供了"已有检查项"，不要生成与其重复的内容。
输出结构：{"items": string[]}
` + onlyJSON

// splitSubtasks：右键「AI 拆解子任务」（同 Tauri splitSubtasks）——拆成检查项追加到任务，可整体撤销。
func (a *app) splitSubtasks(t store.Task) {
	cfg := a.aiConfig()
	if cfg.Off {
		a.aiFailed(ai.ErrDisabled)
		return
	}
	user := t.Text
	if t.Note != "" {
		user += "\n备注：" + t.Note
	}
	var existing []string
	for _, c := range t.Checklist {
		existing = append(existing, c.Text)
	}
	if len(existing) > 0 {
		user += "\n已有检查项：" + strings.Join(existing, "、")
	}
	a.showHUD("info", tr("AI 正在拆解子任务…"))
	go func() {
		var r struct {
			Items []string `json:"items"`
		}
		err := aiJSON(cfg, splitSystem, user, &r)
		a.panelUpdate(func() {
			if err != nil {
				a.aiFailed(err)
				return
			}
			var items []string
			for _, x := range r.Items {
				if x = strings.TrimSpace(x); x != "" && len(items) < 8 {
					items = append(items, x)
				}
			}
			i := slices.IndexFunc(a.store.Tasks(), func(x store.Task) bool { return x.ID == t.ID })
			var cur store.Task
			if i >= 0 {
				cur = a.store.Tasks()[i]
			}
			if i < 0 || len(items) == 0 || cur.Text != t.Text {
				a.showHUD("warn", tr("AI 未返回可用的检查项"))
				return
			}
			orig := cur
			cur.Checklist = slices.Clone(cur.Checklist)
			for i, x := range items {
				cur.Checklist = append(cur.Checklist, store.ChecklistItem{ID: fmt.Sprintf("ai-%d-%d", time.Now().UnixNano(), i), Text: x})
			}
			_ = a.store.UpdateTask(cur)
			a.showHUDUndo("ok", fmt.Sprintf(tr("已拆解 %d 条子任务"), len(items)), func() { _ = a.store.UpdateTask(orig) })
		})
	}()
}

func truncateRunes(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}

// aiJSON：调用 AI 并把回复里的 JSON 对象解进 v（容忍代码块包裹）。
var aiJSON = func(cfg ai.Config, system, user string, v any) error {
	out, err := ai.Rewrite(context.Background(), cfg, system, user)
	if err != nil {
		return err
	}
	if i, j := strings.Index(out, "{"), strings.LastIndex(out, "}"); i >= 0 && j > i {
		out = out[i : j+1]
	}
	if json.Unmarshal([]byte(out), v) != nil {
		return errors.New(tr("AI 返回格式无法识别"))
	}
	return nil
}

func (a *app) aiConfig() ai.Config {
	st := a.store.Settings()
	return ai.Config{Endpoint: st.AIEndpoint, Key: aiKey(), Model: st.AIModel, Off: !st.AIOn()}
}

func (a *app) aiFailed(err error) {
	if errors.Is(err, ai.ErrNoKey) {
		a.showHUD("info", tr("请先在 设置 → AI 中配置密钥"))
		return
	}
	if errors.Is(err, ai.ErrDisabled) {
		a.showHUD("info", tr("AI 智能未启用：在 设置 → 更多功能 → AI 里打开"))
		return
	}
	a.showHUD("warn", err.Error())
}

// convertToTask：原子转换，气泡可撤销（换回笔记、删掉任务）。
func (a *app) convertToTask(n store.Note, title string, checklist []string, msg string) {
	t, orig, pos, ok := a.store.ConvertToTask(n.ID, title, checklist)
	if !ok {
		a.showHUD("warn", tr("该卡片不支持转为任务"))
		return
	}
	a.chosen.Remove(n.ID)
	a.showHUDUndo("ok", msg, func() { _ = a.store.UndoConvert(t, orig, pos) })
}

func (a *app) noteToTaskAI(n store.Note) {
	cfg := a.aiConfig()
	a.showHUD("info", tr("AI 正在提炼任务…"))
	go func() {
		var r struct {
			Title     string   `json:"title"`
			Checklist []string `json:"checklist"`
		}
		err := aiJSON(cfg, noteToTaskSystem, n.Text, &r)
		a.onMain(func() {
			if err != nil {
				a.aiFailed(err)
				return
			}
			if cur, ok := a.store.Note(n.ID); !ok || cur.Text != n.Text {
				a.showHUD("warn", tr("笔记已不存在，转换取消"))
				return
			}
			a.convertToTask(n, truncateRunes(r.Title, 30), r.Checklist[:min(len(r.Checklist), 8)], tr("已转为任务（AI）"))
		})
	}()
}

func (a *app) suggestTitle(n store.Note) {
	cfg := a.aiConfig()
	a.showHUD("info", tr("AI 正在起标题…"))
	go func() {
		var r struct {
			Title string `json:"title"`
		}
		err := aiJSON(cfg, titleSystem, n.Text, &r)
		a.onMain(func() {
			if err != nil {
				a.aiFailed(err)
				return
			}
			if cur, ok := a.store.Note(n.ID); !ok || cur.Text != n.Text {
				return
			}
			title := truncateRunes(r.Title, 12)
			_ = a.store.SetTitle(n.ID, title)
			a.showHUD("ok", tr("已命名：")+title)
		})
	}()
}
