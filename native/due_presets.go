package main

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 到期快捷档（同 Tauri DuePresetsSection / presetCfgLabel）：任务「到期」菜单与消息「提醒我」共用，
// 设置 → 更多功能 → 提醒 里增删改，按顺序显示。

var weekdayZH = []string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}
var weekdayEN = []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}

func weekdayLabel(d int) string {
	if d < 0 || d > 6 {
		d = 1
	}
	if langEN.Load() {
		return weekdayEN[d]
	}
	return weekdayZH[d]
}

func presetLabel(p store.DuePreset) string {
	hm := fmt.Sprintf("%d:%02d", p.Hour, p.Minute)
	switch p.Kind {
	case "relative":
		if p.Minutes >= 60 && p.Minutes%60 == 0 {
			return fmt.Sprintf(tr("%d 小时后"), p.Minutes/60)
		}
		return fmt.Sprintf(tr("%d 分钟后"), p.Minutes)
	case "today":
		return fmt.Sprintf(tr("今天 %s"), hm)
	case "tomorrow":
		return fmt.Sprintf(tr("明天 %s"), hm)
	case "weekday":
		return fmt.Sprintf(tr("下个%s %s"), weekdayLabel(p.Weekday), hm)
	}
	return ""
}

// presetMenu 列出快捷档；没有快捷档时给一条去设置的提示（同 Tauri「没有快捷档」）。
func (a *app) presetMenu(m *ui.Menu, pick func(time.Time)) {
	ps := a.store.Settings().Presets()
	for _, p := range ps {
		if m.Item(presetLabel(p)).Chosen() {
			pick(p.Due(a.now()))
		}
	}
	if len(ps) == 0 && m.Item(tr("没有快捷档，去设置添加…")).Chosen() {
		if a.panel != nil {
			a.openSettings()
		}
		a.setJump = "更多功能"
	}
}

type dueEditor struct {
	id   string
	kind int    // 0 多久后 / 1 今天 / 2 明天 / 3 下个周几
	unit int    // 0 分钟 / 1 小时
	num  string // 多久后的数值
	at   string // HH:MM
	wd   int
}

var presetKinds = []string{"relative", "today", "tomorrow", "weekday"}

func (a *app) editPreset(p store.DuePreset) {
	e := dueEditor{id: p.ID, kind: max(0, slices.Index(presetKinds, p.Kind)), wd: p.Weekday, at: fmt.Sprintf("%02d:%02d", p.Hour, p.Minute)}
	if p.Kind == "relative" && p.Minutes >= 60 && p.Minutes%60 == 0 {
		e.unit, e.num = 1, strconv.Itoa(p.Minutes/60)
	} else {
		e.num = strconv.Itoa(max(1, p.Minutes))
	}
	a.dueEdit = e
}

// draft 把编辑态还原成档位；输入不合法返回 false。
func (e dueEditor) draft() (store.DuePreset, bool) {
	p := store.DuePreset{ID: e.id, Kind: presetKinds[e.kind]}
	if p.Kind == "relative" {
		n, err := strconv.ParseFloat(strings.TrimSpace(e.num), 64)
		if err != nil || n <= 0 {
			return p, false
		}
		if e.unit == 1 {
			n *= 60
		}
		p.Minutes = max(1, int(n+0.5))
		return p, true
	}
	h, m, ok := parseHM(e.at)
	if !ok {
		return p, false
	}
	p.Hour, p.Minute = h, m
	if p.Kind == "weekday" {
		p.Weekday = e.wd
	}
	return p, p.Valid()
}

func parseHM(s string) (int, int, bool) {
	hs, ms, ok := strings.Cut(strings.TrimSpace(strings.ReplaceAll(s, "：", ":")), ":")
	h, err1 := strconv.Atoi(hs)
	m, err2 := strconv.Atoi(ms)
	if !ok || err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, 0, false
	}
	return h, m, true
}

func (a *app) savePresets(ps []store.DuePreset) {
	cur := a.store.Settings()
	cur.DuePresets = &ps
	_ = a.store.SetSettings(cur)
}

func (a *app) duePresetRows(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setRow {
	ps := st.Presets()
	rows := []setRow{{title: tr("到期提醒快捷档"), hint: tr("任务「到期」菜单和消息「提醒我」里的快捷选项，按此顺序显示。")}}
	for i, p := range ps {
		if a.dueEdit.id == p.ID {
			rows = append(rows, a.presetEditRow(c, k, s, ps, i))
			continue
		}
		rows = append(rows, setRow{title: presetLabel(p), control: func() {
			ui.Row(c).Gap(2).AlignItems(ui.Center).Children(func() {
				if a.iconButton(c, k, "pencil", 22, 13, tr("编辑")+presetLabel(p)) {
					a.editPreset(p)
				}
				if a.iconButton(c, k, "x", 22, 13, tr("删除")+presetLabel(p)) {
					before := slices.Clone(ps)
					a.savePresets(slices.Delete(slices.Clone(ps), i, i+1))
					a.showHUDUndo("ok", fmt.Sprintf(tr("已删除快捷档「%s」"), presetLabel(p)), func() { a.savePresets(before) })
				}
			})
		}})
	}
	hint := ""
	if len(ps) == 0 {
		hint = tr("没有快捷档，菜单里只剩自定义日期时间。")
	}
	return append(rows, setRow{title: fmt.Sprintf(tr("共 %d 档"), len(ps)), hint: hint, control: func() {
		ui.Row(c).Gap(6).Children(func() {
			if st.DuePresets != nil && button(c, s, "恢复默认") {
				before := slices.Clone(ps)
				a.savePresets(store.DefaultDuePresets())
				a.dueEdit = dueEditor{}
				a.showHUDUndo("ok", tr("已恢复默认快捷档"), func() { a.savePresets(before) })
			}
			if button(c, s, "添加档位") {
				p := store.DuePreset{ID: fmt.Sprintf("preset-%x", time.Now().UnixNano()), Kind: "relative", Minutes: 60}
				a.savePresets(append(slices.Clone(ps), p))
				a.editPreset(p)
			}
		})
	}})
}

func (a *app) presetEditRow(c *ui.Context, k tokens, s settingsTokens, ps []store.DuePreset, i int) setRow {
	e := &a.dueEdit
	preview := tr("输入无效")
	d, ok := e.draft()
	if ok {
		preview = "→ " + presetLabel(d)
	}
	return setRow{title: presetLabel(ps[i]), hint: preview, below: func() {
		ui.Column(c).Gap(8).Children(func() {
			if segmented(c, k, &e.kind, tr("多久后"), tr("今天"), tr("明天"), tr("下个周几")) {
				switch e.kind { // 切类型给合理默认值（同 Tauri switchKind）
				case 0:
					e.num, e.unit = "1", 1
				case 1:
					e.at = "20:00"
				default:
					e.at, e.wd = "09:00", 1
				}
			}
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				if e.kind == 0 {
					textField(c, k, s, &e.num, 64, "60", false)
					segmented(c, k, &e.unit, tr("分钟"), tr("小时"))
				} else {
					if e.kind == 3 {
						settingsSelect(c, k, s, weekdayLabel(e.wd), func(m *ui.Menu) {
							for _, d := range []int{1, 2, 3, 4, 5, 6, 0} {
								if m.Item(weekdayLabel(d)).Radio(d == e.wd).Chosen() {
									e.wd = d
								}
							}
						})
					}
					textField(c, k, s, &e.at, 72, "09:00", false)
				}
				ui.Box(c).Grow(1)
				if button(c, s, "保存") {
					if !ok {
						a.showHUD("warn", tr("时间格式应为 时:分，如 9:30"))
						return
					}
					next := slices.Clone(ps)
					next[i] = d
					a.savePresets(next)
					a.dueEdit = dueEditor{}
				}
				if button(c, s, "取消") {
					a.dueEdit = dueEditor{}
				}
			})
		})
	}}
}
