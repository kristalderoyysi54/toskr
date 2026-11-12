package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/store"
)

// 任务速记 ✨ AI 模式（同 Tauri TaskQuickAdd aiMode + lib/ai.ts parseTaskDraft / commitTaskDraft）：
// 自然语言交给 AI 解析出标题、到期、优先级、重复、分组与检查项，先在输入框下方预览（回车确认、Esc 回到编辑），
// 任何失败都按原文建普通任务——回车的语义是「存下这句话」，输入绝不能凭空消失。💡 与 ✨ 互斥。

type taskDraft struct {
	original   string
	title      string
	due        time.Time
	priority   string
	checklist  []string
	recurrence string
	section    string // 任务分组 id，"" = 收集箱
}

func parseTaskSystem(now time.Time, sections []string) string {
	week := []string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}[now.Weekday()]
	return `你是任务解析助手。将用户输入的一句话解析为结构化任务 JSON。

当前本地时间：` + now.Format("2006-01-02 15:04") + `（` + week + `）

规则：
1. title：任务核心内容，去掉"提醒我""帮我"等口语外壳与时间短语，保留动作本身，不超过30字。
2. due：提到时间才给，三选一，不要自行计算时间戳：
   - 相对时长（"20分钟后""2小时后"）→ {"minutesFromNow": 分钟数}（小时换算成分钟）
   - 具体时刻（"下午3点""明早9点"）→ {"date": "YYYY-MM-DD", "time": "HH:MM"}（24小时制；
     结合上面的当前日期推算；该钟点当天已过则用明天的日期；用户说"明天/明早"必须用明天日期）
   - 没提到时间 → null
3. priority：只能是 "none"|"low"|"mid"|"high"。出现"重要""紧急""务必""deadline"→ high；
   "有空""顺手""不急"→ low；无法判断 → none。
4. checklist：以下两种情况给出，其余给空数组 []：
   a. 用户要求拆步骤/清单（"拆一下""分几步""列个清单"）→ 你来拆解 3-8 条，动词开头不超过20字；
   b. 用户列举了多件并列事项并示意归并（"这两个/这几件 做成待办/子任务/子项/检查项"，
      或一句话里明显包含多个并列任务）→ 把每件事各作一条 checklist，保留用户原表述（可轻度精简）。
5. 当 checklist 非空时，title 必须是对整组事项的概括性短标题（不超过30字），
   绝不要把整段原文塞进 title。
6. recurrence：用户说了周期（"每天""每个工作日""每周一""每周二四""每月""每年"）才给，否则 null：
   {"freq": "daily"|"weekdays"|"weekly"|"monthly"|"yearly", "weekdays": number[]}
   weekdays 仅 weekly 时给，0=周日 1=周一 … 6=周六。有周期时 due 给最近一期的日期与时间。
7. section：用户点名放进某个分组（"放工作组""归到家务"）且与下列分组名之一对应时，给出该分组名原文；否则 null。
   现有分组：` + cmpOr(strings.Join(sections, "、"), "（无）") + `

输出结构（所有键都必须出现）：
{"title": string, "due": {"minutesFromNow": number} | {"date": string, "time": string} | null, "priority": string, "checklist": string[], "recurrence": {"freq": string, "weekdays"?: number[]} | null, "section": string | null}

示例（假设当前是 2026-08-05 周三 10:00）：
输入"下午3点提醒我开会" → {"title":"开会","due":{"date":"2026-08-05","time":"15:00"},"priority":"none","checklist":[]}
输入"20分钟后提醒我关火" → {"title":"关火","due":{"minutesFromNow":20},"priority":"high","checklist":[]}
输入"晚上8点提醒我复盘"（当前已 21:00）→ {"title":"复盘","due":{"date":"2026-08-06","time":"20:00"},"priority":"none","checklist":[]}
输入"明早9点前交周报，拆一下步骤" → {"title":"交周报","due":{"date":"2026-08-06","time":"09:00"},"priority":"mid","checklist":["整理本周完成事项","汇总下周计划","检查数据与附件","发送周报"]}
输入"每周一上午10点交周报，放工作组"（现有分组含「工作」）→ {"title":"交周报","due":{"date":"2026-08-10","time":"10:00"},"priority":"none","checklist":[],"recurrence":{"freq":"weekly","weekdays":[1]},"section":"工作"}

` + onlyJSON
}

type parsedTask struct {
	Title string `json:"title"`
	Due   *struct {
		MinutesFromNow *float64 `json:"minutesFromNow"`
		Date           string   `json:"date"`
		Time           string   `json:"time"`
	} `json:"due"`
	Priority   string   `json:"priority"`
	Checklist  []string `json:"checklist"`
	Recurrence *struct {
		Freq string `json:"freq"`
	} `json:"recurrence"`
	Section *string `json:"section"`
}

// normalizeParsedTask 同 Tauri normalizeParsedTask：校验取值、本地时区换算到期、截断。
func (a *app) normalizeParsedTask(r parsedTask, original string, now time.Time) (taskDraft, bool) {
	title := truncateRunes(r.Title, 30)
	if title == "" {
		return taskDraft{}, false
	}
	d := taskDraft{original: original, title: title, priority: "none"}
	if slices.Contains([]string{"none", "low", "mid", "high"}, r.Priority) {
		d.priority = r.Priority
	}
	if r.Due != nil {
		switch {
		case r.Due.MinutesFromNow != nil && *r.Due.MinutesFromNow > 0:
			d.due = now.Add(time.Duration(*r.Due.MinutesFromNow * float64(time.Minute))).Truncate(time.Minute)
		case r.Due.Date != "":
			if t, err := time.ParseInLocation("2006-01-02 15:04", r.Due.Date+" "+cmpOr(r.Due.Time, "09:00"), now.Location()); err == nil {
				d.due = t
			}
		}
	}
	for _, x := range r.Checklist {
		if x = truncateRunes(x, 40); x != "" && len(d.checklist) < 8 {
			d.checklist = append(d.checklist, x)
		}
	}
	if r.Recurrence != nil && slices.Contains([]string{"daily", "weekdays", "weekly", "monthly", "yearly"}, r.Recurrence.Freq) {
		d.recurrence = r.Recurrence.Freq
		if d.due.IsZero() { // 有周期没到期：同 Tauri setTaskRecurrence 自己补首期（明天 9 点）
			d.due = time.Date(now.Year(), now.Month(), now.Day()+1, 9, 0, 0, 0, now.Location())
		}
	}
	if r.Section != nil {
		for _, s := range a.store.TaskSections() {
			if s.Name == *r.Section && s.ID != store.TaskInbox {
				d.section = s.ID
			}
		}
	}
	return d, true
}

func (a *app) setTaskAIMode(on bool) {
	a.taskAI = on
	if on {
		a.sparkMode = false
	}
}

// parseTaskDraftAI：回车交给 AI；失败按原文建普通任务。
func (a *app) parseTaskDraftAI(text string) {
	text = strings.TrimSpace(text)
	if text == "" || a.taskAIBusy {
		return
	}
	cfg := a.aiConfig()
	fallback := func(err error) {
		a.store.AddTask(store.Task{Text: text})
		a.aiFailed(err)
		a.showHUD("warn", fmt.Sprintf(tr("%s · 已按原文创建任务"), truncateRunes(a.hudText, 60)))
	}
	if cfg.Off { // 未配置密钥由请求本身报 ErrNoKey，同样走回退
		fallback(ai.ErrDisabled)
		return
	}
	now := a.now()
	var names []string
	for _, s := range a.store.TaskSections() {
		names = append(names, s.Name)
	}
	a.taskAIBusy = true
	go func() {
		var r parsedTask
		err := aiJSON(cfg, parseTaskSystem(now, names), text, &r)
		a.panelUpdate(func() {
			a.taskAIBusy = false
			if err != nil {
				fallback(err)
				return
			}
			d, ok := a.normalizeParsedTask(r, text, now)
			if !ok {
				fallback(fmt.Errorf("%s", tr("AI 返回内容缺少必要字段")))
				return
			}
			a.taskAIDraft = &d
		})
	}()
}

func (a *app) commitTaskDraft() {
	d := a.taskAIDraft
	if d == nil {
		return
	}
	a.taskAIDraft = nil
	t := store.Task{Text: cmpOr(strings.TrimSpace(d.title), d.original), Priority: d.priority, DueAt: d.due, Recurrence: d.recurrence, Section: d.section}
	for _, x := range d.checklist {
		t.Checklist = append(t.Checklist, store.NewChecklistItem(x))
	}
	if added := a.store.AddTask(t); added.ID != "" {
		a.showHUD("ok", fmt.Sprintf(tr("已创建任务「%s」"), truncateRunes(t.Text, 12)))
	}
}

func (a *app) draftBackToEdit() {
	if d := a.taskAIDraft; d != nil {
		a.taskDraft = d.original
		a.taskAIDraft = nil
	}
}

func (a *app) draftSaveOriginal() {
	if d := a.taskAIDraft; d != nil {
		a.store.AddTask(store.Task{Text: d.original})
		a.taskAIDraft = nil
	}
}

var priorityNext = map[string]string{"none": "low", "low": "mid", "mid": "high", "high": "none"}

// taskDraftPreview：AI 解析结果预览——标题可改；到期 / 重复 / 检查项可去掉，优先级与分组点按循环。
func (a *app) taskDraftPreview(c *ui.Context, k tokens) {
	d := a.taskAIDraft
	if d == nil {
		return
	}
	if c.Shortcut(0, ui.KeyEnter) {
		a.commitTaskDraft()
		return
	}
	if c.Shortcut(0, ui.KeyEscape) {
		a.draftBackToEdit()
		return
	}
	s := stok(c)
	now := a.now()
	ui.Column(c).Margin(6, 12, 0, 12).Padding(8).Gap(6).Radius(12).Background(k.track).Key("task-ai-draft").
		Transition(ui.ElementTransition{Duration: 120 * time.Millisecond, Ease: easeTw, Enter: &ui.Motion{Y: -2}}).Children(func() {
		text(c, tr("AI 解析结果 · 回车确认，Esc 回到编辑"), 10, 14, 400, k.muted)
		ui.TextInputBase(c, &d.title).FillWidth().Font(fontSans).FontSize(13).FixedLineHeight(18).TextColor(k.fg).Label(tr("任务标题"))
		chip := func(key, label string, onClick, onRemove func()) {
			ui.Row(c).Height(20).Padding(0, 4, 0, 8).Gap(2).Radius(10).Background(s.primary.Alpha(0.1)).Border(1, s.primary.Alpha(0.4)).
				AlignItems(ui.Center).Key("tdc-" + key).Children(func() {
				l := ui.Box(c).Children(func() { text(c, label, 10, 14, 500, s.primary) })
				if onClick != nil {
					l.Role(ui.RoleButton).Label(label)
					if l.Clicked() {
						onClick()
					}
				}
				if onRemove != nil {
					x := ui.Box(c).Size(14, 14).Radius(7).Center().Role(ui.RoleButton).Label(tr("去掉") + label)
					if x.Hovered() {
						x.Background(s.primary.Alpha(0.15))
					}
					x.Children(func() { licon(c, "x", 10, s.primary) })
					if x.Clicked() {
						onRemove()
					}
				} else {
					ui.Box(c).Width(4)
				}
			})
		}
		ui.Row(c).Wrap().Gap(4).Children(func() {
			if !d.due.IsZero() {
				chip("due", dueBadge(d.due, now), nil, func() { d.due = time.Time{} })
			}
			if d.recurrence != "" {
				chip("rec", recurName(d.recurrence), nil, func() { d.recurrence = "" })
			}
			chip("pri", fmt.Sprintf(tr("优先级 %s"), priorityName(d.priority)), func() { d.priority = priorityNext[d.priority] }, nil)
			if secs := a.store.TaskSections(); len(secs) > 1 {
				i := max(0, slices.IndexFunc(secs, func(x store.Section) bool { return x.ID == cmpOr(d.section, store.TaskInbox) }))
				name := secs[i].Name
				if secs[i].ID == store.TaskInbox {
					name = tr("收集箱")
				}
				chip("sec", name, func() {
					next := secs[(i+1)%len(secs)].ID
					if next == store.TaskInbox {
						next = ""
					}
					d.section = next
				}, nil)
			}
			if len(d.checklist) > 0 {
				chip("ck", fmt.Sprintf(tr("%d 项检查"), len(d.checklist)), nil, func() { d.checklist = nil })
			}
		})
		ui.Row(c).Gap(6).Justify(ui.End).Children(func() {
			if button(c, s, "按原文存为普通任务") {
				a.draftSaveOriginal()
			}
			if button(c, s, "确认 ⏎") {
				a.commitTaskDraft()
			}
		})
	})
}

func priorityName(p string) string {
	switch p {
	case "low":
		return tr("低")
	case "mid":
		return tr("中")
	case "high":
		return tr("高")
	}
	return tr("无")
}

func recurName(r string) string {
	return map[string]string{"daily": tr("每天"), "weekdays": tr("工作日"), "weekly": tr("每周"), "monthly": tr("每月"), "yearly": tr("每年")}[r]
}
