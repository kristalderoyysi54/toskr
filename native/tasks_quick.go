package main

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 速记本地解析（原生版新增，Tauri 的自然语言只在 AI 速记里）：不配 AI 也能认出时间、重复、优先级和分组。
// 输入时在速记框下方实时出「片」，每片可点掉（防误认，如标题里恰好含「明天」）；回车按仍开着的片入库，标题去掉已识别的词。
// 规则只覆盖中文常见说法，认不出的句子原文入库（或交给 AI 模式）。

type quickParse struct {
	title      string // 去掉全部已识别词后的标题
	due        time.Time
	recurrence string // daily | weekdays | weekly | monthly | yearly
	priority   string // low | mid | high
	section    string // 任务分组 id
	secName    string
	spans      map[string][][2]int // 各片在原文里的字节区间：due / rec / pri / sec
}

var (
	qDay      = regexp.MustCompile(`今天|今晚|今早|明天|明早|明晚|大后天|后天|(下下|下|这|本)?(周|星期|礼拜)([一二三四五六日天])|(\d{1,2})月(\d{1,2})[日号]?|(\d{1,2})[日号]`)
	qTime     = regexp.MustCompile(`(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(点半|点一刻|点三刻|点|时|[:：])\s*(\d{1,2})?分?`)
	qPeriod   = regexp.MustCompile(`凌晨|早上|早晨|上午|中午|下午|傍晚|晚上`)
	qRelative = regexp.MustCompile(`(\d+|半|一|两|三)\s*个?\s*(分钟|小时|天)\s*(后|之后|以后)`)
	qRecur    = regexp.MustCompile(`每个?工作日|每天|每日|每周|每星期|每个?月|每年`)
	qPrio     = regexp.MustCompile(`\s*[!！]{1,3}\s*$`)
	qSection  = regexp.MustCompile(`[#＃](\S+)|放(?:到|进|在)?\s*(\S+?)\s*(?:分组|组)\s*$`)
)

var cnDigits = map[rune]int{'一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}

func cnNumber(s string) (int, bool) {
	if n, err := strconv.Atoi(s); err == nil {
		return n, true
	}
	rs := []rune(s)
	n := 0
	for i, r := range rs {
		switch {
		case r == '十':
			if i == 0 {
				n = 10
			} else {
				n *= 10
			}
		case cnDigits[r] > 0:
			if i > 0 && rs[i-1] == '十' {
				n += cnDigits[r]
			} else {
				n = cnDigits[r]
			}
		default:
			return 0, false
		}
	}
	return n, n > 0
}

// parseQuickTask 解析一句速记；sections 用来认「#分组名」「放 XX 组」。
func parseQuickTask(raw string, now time.Time, sections []store.Section) quickParse {
	p := quickParse{spans: map[string][][2]int{}}
	mark := func(kind string, loc []int) { p.spans[kind] = append(p.spans[kind], [2]int{loc[0], loc[1]}) }
	text := raw

	// 优先级：句尾 1–3 个叹号
	if loc := qPrio.FindStringIndex(text); loc != nil {
		n := strings.Count(text[loc[0]:loc[1]], "!") + strings.Count(text[loc[0]:loc[1]], "！")
		p.priority = []string{"low", "mid", "high"}[min(n, 3)-1]
		mark("pri", loc)
		text = text[:loc[0]] + strings.Repeat(" ", loc[1]-loc[0])
	}
	// 分组
	for _, m := range qSection.FindAllStringSubmatchIndex(text, -1) {
		name := ""
		if m[2] >= 0 {
			name = text[m[2]:m[3]]
		} else if m[4] >= 0 {
			name = text[m[4]:m[5]]
		}
		i := slices.IndexFunc(sections, func(s store.Section) bool {
			return sectionTitle(s) == name || strings.TrimSuffix(sectionTitle(s), "组") == name
		})
		if i < 0 {
			continue
		}
		p.section, p.secName = sections[i].ID, sectionTitle(sections[i])
		mark("sec", m[:2])
		text = text[:m[0]] + strings.Repeat(" ", m[1]-m[0]) + text[m[1]:]
		break
	}
	// 重复
	if loc := qRecur.FindStringIndex(text); loc != nil {
		w := text[loc[0]:loc[1]]
		switch {
		case strings.Contains(w, "工作日"):
			p.recurrence = "weekdays"
		case w == "每天" || w == "每日":
			p.recurrence = "daily"
		case w == "每周" || w == "每星期":
			p.recurrence = "weekly"
		case strings.Contains(w, "月"):
			p.recurrence = "monthly"
		default:
			p.recurrence = "yearly"
		}
		mark("rec", loc)
		// 「每周一」里的「周一」仍要参与日期解析：只抹掉「每」
		text = text[:loc[0]] + strings.Repeat(" ", len("每")) + text[loc[0]+len("每"):]
		if p.recurrence != "weekly" && p.recurrence != "monthly" {
			text = text[:loc[0]] + strings.Repeat(" ", loc[1]-loc[0]) + text[loc[1]:]
		}
	}

	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	hasDay, hasTime := false, false
	hour, minute := 9, 0
	// 相对时间：N 分钟 / 小时 / 天后
	if m := qRelative.FindStringSubmatchIndex(text); m != nil {
		num, unit := text[m[2]:m[3]], text[m[4]:m[5]]
		n, ok := cnNumber(num)
		half := num == "半"
		if ok || half {
			var d time.Duration
			switch unit {
			case "分钟":
				d = time.Duration(n) * time.Minute
			case "小时":
				d = time.Duration(n) * time.Hour
				if half {
					d = 30 * time.Minute
				}
			}
			if unit == "天" && ok {
				day, hasDay = day.AddDate(0, 0, n), true
			} else if d > 0 {
				p.due = now.Add(d).Truncate(time.Minute)
			}
			if hasDay || !p.due.IsZero() {
				mark("due", m[:2])
				text = text[:m[0]] + strings.Repeat(" ", m[1]-m[0]) + text[m[1]:]
			}
		}
	}
	if p.due.IsZero() {
		if m := qDay.FindStringSubmatchIndex(text); m != nil && !hasDay {
			w := text[m[0]:m[1]]
			switch {
			case w == "今天" || w == "今早":
			case w == "今晚":
				hour = 20
			case w == "明天" || w == "明早":
				day = day.AddDate(0, 0, 1)
			case w == "明晚":
				day, hour = day.AddDate(0, 0, 1), 20
			case w == "后天":
				day = day.AddDate(0, 0, 2)
			case w == "大后天":
				day = day.AddDate(0, 0, 3)
			case m[6] >= 0: // 周几
				wd := strings.Index("日一二三四五六", strings.Replace(text[m[6]:m[7]], "天", "日", 1)) / len("一")
				prefix := ""
				if m[2] >= 0 {
					prefix = text[m[2]:m[3]]
				}
				cur := (int(now.Weekday()) + 6) % 7 // 周一 = 0
				target := (wd + 6) % 7
				diff := target - cur
				switch prefix {
				case "下":
					diff += 7
				case "下下":
					diff += 14
				case "这", "本":
				default:
					if diff < 0 || diff == 0 && p.recurrence == "" {
						diff += 7 // 「周三」已过（或就是今天）：指下一个
					}
				}
				day = day.AddDate(0, 0, diff)
			case m[8] >= 0: // M月D日
				mo, _ := strconv.Atoi(text[m[8]:m[9]])
				d, _ := strconv.Atoi(text[m[10]:m[11]])
				day = time.Date(now.Year(), time.Month(mo), d, 0, 0, 0, 0, now.Location())
				if day.Before(time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())) {
					day = day.AddDate(1, 0, 0)
				}
			case m[12] >= 0: // D日 / D号
				d, _ := strconv.Atoi(text[m[12]:m[13]])
				day = time.Date(now.Year(), now.Month(), d, 0, 0, 0, 0, now.Location())
				if day.Before(time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())) {
					day = day.AddDate(0, 1, 0)
				}
			}
			hasDay = true
			mark("due", m[:2])
			text = text[:m[0]] + strings.Repeat(" ", m[1]-m[0]) + text[m[1]:]
		}
		if m := qTime.FindStringSubmatchIndex(text); m != nil {
			h, ok := cnNumber(text[m[4]:m[5]])
			if ok && h <= 24 {
				period := ""
				if m[2] >= 0 {
					period = text[m[2]:m[3]]
				}
				mi := 0
				switch text[m[6]:m[7]] {
				case "点半":
					mi = 30
				case "点一刻":
					mi = 15
				case "点三刻":
					mi = 45
				}
				if m[8] >= 0 {
					mi, _ = strconv.Atoi(text[m[8]:m[9]])
				}
				switch period {
				case "下午", "傍晚", "晚上":
					if h < 12 {
						h += 12
					}
				case "中午":
					if h < 11 {
						h += 12
					}
				case "":
					if hour == 20 && h < 12 { // 「今晚 8 点」
						h += 12
					}
				}
				if mi < 60 {
					hour, minute, hasTime = h%24, mi, true
					mark("due", m[:2])
					text = text[:m[0]] + strings.Repeat(" ", m[1]-m[0]) + text[m[1]:]
				}
			}
		} else if hasDay {
			if loc := qPeriod.FindStringIndex(text); loc != nil { // 只有时段没有钟点：给时段的默认钟点
				hour = map[string]int{"凌晨": 6, "早上": 8, "早晨": 8, "上午": 9, "中午": 12, "下午": 15, "傍晚": 18, "晚上": 20}[text[loc[0]:loc[1]]]
				mark("due", loc)
				text = text[:loc[0]] + strings.Repeat(" ", loc[1]-loc[0]) + text[loc[1]:]
			}
		}
		if hasDay || hasTime {
			p.due = time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, now.Location())
			if !hasDay && !p.due.After(now) { // 只说了钟点且已过：指明天
				p.due = p.due.AddDate(0, 0, 1)
			}
		}
	}
	p.title = quickTitle(raw, p.spans, nil)
	return p
}

// quickTitle：从原文里去掉仍开着的片对应的词（off 里的片保留原词）。
func quickTitle(raw string, spans map[string][][2]int, off map[string]bool) string {
	var cut [][2]int
	for kind, ss := range spans {
		if !off[kind] {
			cut = append(cut, ss...)
		}
	}
	slices.SortFunc(cut, func(a, b [2]int) int { return a[0] - b[0] })
	var out strings.Builder
	pos := 0
	for _, s := range cut { // 片的区间可能相交（「每周一」同属重复与日期）：按起点顺序跳过
		if s[0] > pos {
			out.WriteString(raw[pos:s[0]])
		}
		out.WriteByte(' ')
		pos = max(pos, s[1])
	}
	out.WriteString(raw[pos:])
	raw = out.String()
	return strings.Join(strings.Fields(strings.Trim(raw, " ，,。、")), " ")
}

// quickDraft：当前速记草稿的解析结果（闪念 / AI 模式不解析）。
func (a *app) quickDraft() (quickParse, bool) {
	if a.taskSub == 1 && (a.sparkMode || a.taskAI) || strings.TrimSpace(a.taskDraft) == "" {
		return quickParse{}, false
	}
	p := parseQuickTask(a.taskDraft, a.now(), a.store.TaskSections())
	return p, len(p.spans) > 0
}

// quickTask：按仍开着的片把草稿落成任务；标题为空（整句都是时间词）时用原文。
func (a *app) quickTask(raw string) store.Task {
	p := parseQuickTask(raw, a.now(), a.store.TaskSections())
	off := a.taskQuickOff
	t := store.Task{Text: quickTitle(raw, p.spans, off)}
	if t.Text == "" {
		return store.Task{Text: strings.TrimSpace(raw)}
	}
	if !off["due"] {
		t.DueAt = p.due
	}
	if !off["rec"] {
		t.Recurrence = p.recurrence
		if t.Recurrence != "" && t.DueAt.IsZero() { // 重复任务要有起点：今天默认时间
			t.DueAt = todayDefaultDue(a.now())
		}
	}
	if !off["pri"] && p.priority != "" {
		t.Priority = p.priority
	}
	if !off["sec"] {
		t.Section = p.section
	}
	return t
}

// taskQuickChips：速记框下方的识别片；点一下取消（再点恢复）。
func (a *app) taskQuickChips(c *ui.Context, k tokens) {
	p, ok := a.quickDraft()
	if !ok {
		if strings.TrimSpace(a.taskDraft) == "" {
			a.taskQuickOff = nil
		}
		return
	}
	s := stok(c)
	now := a.now()
	chip := func(kind, icon, label string) {
		off := a.taskQuickOff[kind]
		b := ui.Row(c).Height(20).Padding(0, 8, 0, 6).Gap(4).Radius(10).AlignItems(ui.Center).Key("tqc-" + kind).Role(ui.RoleButton).Selected(!off).
			Label(label).Tooltip(map[bool]string{false: tr("点一下不采用，保留原文"), true: tr("点一下重新采用")}[off])
		fg := s.primary
		if off {
			fg = k.muted
			b.Border(1, k.fg.Alpha(0.14))
		} else {
			b.Background(s.primary.Alpha(0.1)).Border(1, s.primary.Alpha(0.4))
		}
		b.Children(func() {
			licon(c, icon, 11, fg)
			t := text(c, label, 10, 14, 500, fg).SingleLine()
			if off {
				t.Strikethrough()
			}
		})
		if b.Clicked() {
			if a.taskQuickOff == nil {
				a.taskQuickOff = map[string]bool{}
			}
			a.taskQuickOff[kind] = !off
		}
	}
	ui.Row(c).Wrap().Gap(4).Margin(6, 12, 0, 12).Key("task-quick-chips").Children(func() {
		if !p.due.IsZero() {
			chip("due", "calendar-clock", dueBadge(p.due, now))
		}
		if p.recurrence != "" {
			chip("rec", "repeat", recurName(p.recurrence))
		}
		if p.priority != "" {
			chip("pri", "circle-alert", fmt.Sprintf(tr("优先级 %s"), priorityName(p.priority)))
		}
		if p.section != "" {
			chip("sec", "folder", p.secName)
		}
	})
}
