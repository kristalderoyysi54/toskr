package main

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 剪贴卡「收下 / 提醒」与收件箱归类（用户 2026-11-17 定）：
//   - 收下 = 复制一份进收件箱（或直接进分组），原剪贴卡留在剪贴页，显示绿色分组小标、不再按保留时长清理
//   - 提醒 = 收下到收件箱 + 新建一条带到期时间的提醒
//   - 收件箱里每条给一个建议分组：先看归类规则，再看同一来源应用 + 类型的内容大多归在哪
//   - 同一来源 + 类型归到同一分组满 3 次，自动记成规则（设置里可看可删）

// fileTargets：「收到哪里」与逐条整理里可选的分组（用户分组，按分组顺序，最多 9 个，对应数字键 1–9）。
func (a *app) fileTargets() []store.Section {
	var out []store.Section
	for _, s := range a.store.Sections() {
		if !store.IsSystemSection(s.ID) && len(out) < 9 {
			out = append(out, s)
		}
	}
	return out
}

// fileKeyHint：数字键提示（1 个分组写「1」，多个写「1–N」）。
func fileKeyHint(n int) string {
	if n <= 1 {
		return "1"
	}
	return "1–" + itoa(n)
}

func noteKind(n store.Note) string {
	switch {
	case n.Kind == "image":
		return "image"
	case n.Kind == "link":
		return "link"
	case isCode(n):
		return "code"
	}
	return "text"
}

type fileSuggestion struct {
	section string
	rule    bool   // 来自归类规则（实线显示）
	why     string // 悬停说明
}

// fileIndex：一次扫描全部内容得到的归类依据（规则 + 各「来源应用 + 类型」在各分组的条数）。
type fileIndex struct {
	rules  []store.FileRule
	order  []store.Section
	valid  map[string]bool
	counts map[string]map[string]int // bundle|kind → 分组 → 条数
}

func (a *app) newFileIndex(all []store.Note) fileIndex {
	ix := fileIndex{rules: a.store.Settings().FileRules, order: a.fileTargets(), valid: map[string]bool{}, counts: map[string]map[string]int{}}
	for _, s := range ix.order {
		ix.valid[s.ID] = true
	}
	for _, x := range all {
		if !ix.valid[x.Section] || x.BundleID == "" {
			continue
		}
		key := x.BundleID + "|" + noteKind(x)
		if ix.counts[key] == nil {
			ix.counts[key] = map[string]int{}
		}
		ix.counts[key][x.Section]++
	}
	return ix
}

// suggest：给一条内容找建议分组——先看归类规则，再看同一来源应用 + 类型的内容大多归在哪（至少 2 条）；没把握时 ok = false。
func (ix fileIndex) suggest(n store.Note) (fileSuggestion, bool) {
	if n.BundleID == "" {
		return fileSuggestion{}, false
	}
	kind := noteKind(n)
	for _, r := range ix.rules {
		if ix.valid[r.Section] && r.Bundle == n.BundleID && (r.Kind == "" || r.Kind == kind) {
			return fileSuggestion{section: r.Section, rule: true, why: fmt.Sprintf(tr("你的规则：%s 的%s"), cmpOr(r.App, n.SourceApp), kindName(r.Kind))}, true
		}
	}
	count := ix.counts[n.BundleID+"|"+kind]
	best, bestN := "", 0
	for _, s := range ix.order { // 按分组顺序：条数相同取靠前的，结果稳定
		if count[s.ID] > bestN {
			best, bestN = s.ID, count[s.ID]
		}
	}
	if bestN < 2 {
		return fileSuggestion{}, false
	}
	return fileSuggestion{section: best, why: fmt.Sprintf(tr("%s 的%s大多归在这里"), cmpOr(n.SourceApp, tr("这个应用")), kindName(kind))}, true
}

// choices：捕获气泡上给的去向，最多 limit 个——建议分组排第一（why 非空），其后按同来源同类型归得多的，再按分组顺序补齐。
func (ix fileIndex) choices(n store.Note, limit int) []fileSuggestion {
	var out []fileSuggestion
	seen := map[string]bool{}
	add := func(s fileSuggestion) {
		if !seen[s.section] && len(out) < limit {
			seen[s.section] = true
			out = append(out, s)
		}
	}
	if s, ok := ix.suggest(n); ok {
		add(s)
	}
	count := ix.counts[n.BundleID+"|"+noteKind(n)]
	byCount := slices.Clone(ix.order)
	slices.SortStableFunc(byCount, func(x, y store.Section) int { return count[y.ID] - count[x.ID] })
	for _, s := range byCount {
		add(fileSuggestion{section: s.ID})
	}
	return out
}

// suggestFile：单条内容的建议分组（「收到哪里」浮层用；收件箱列表用 reload 里算好的 a.inboxSug）。
func (a *app) suggestFile(n store.Note) (fileSuggestion, bool) {
	return a.newFileIndex(a.store.Notes()).suggest(n)
}

// refreshInboxSuggestions：reload 时给收件箱里每条算好建议分组。
func (a *app) refreshInboxSuggestions(all []store.Note) {
	a.inboxSug = map[string]fileSuggestion{}
	var ix *fileIndex
	for _, n := range all {
		if n.Section != store.SectionInbox || n.Done || n.BundleID == "" {
			continue
		}
		if ix == nil {
			x := a.newFileIndex(all)
			ix = &x
		}
		if s, ok := ix.suggest(n); ok {
			a.inboxSug[n.ID] = s
		}
	}
}

func kindName(kind string) string {
	switch kind {
	case "image":
		return tr("图片")
	case "link":
		return tr("链接")
	case "code":
		return tr("代码")
	case "text":
		return tr("文字")
	}
	return tr("内容")
}

func (a *app) sectionLabel(id string) string {
	if id == store.SectionInbox {
		return tr("收件箱")
	}
	for _, s := range a.store.Sections() {
		if s.ID == id {
			return sectionName(s)
		}
	}
	return ""
}

// keepClipsTo：剪贴卡收下到 section（收件箱或分组），可撤销。
func (a *app) keepClipsTo(notes []store.Note, section string) {
	ids := make([]string, len(notes))
	for i, x := range notes {
		ids[i] = x.ID
	}
	undo, copies := a.store.KeepClips(ids, section)
	a.chosen.Clear()
	a.clipPick = ""
	if len(copies) == 0 {
		a.reload()
		a.showHUD("info", tr("已经收下过了"))
		return
	}
	learned := ""
	if section != store.SectionInbox {
		learned = a.learnFileRule(copies[0], section)
	}
	a.reload()
	msg := tr("已收进收件箱")
	if section != store.SectionInbox {
		msg = fmt.Sprintf(tr("已收到「%s」"), a.sectionLabel(section))
	}
	if len(copies) > 1 {
		msg += " " + itoa(len(copies)) + tr(" 条")
	}
	a.showHUDUndo("ok", msg+learned, func() { undo(); a.reload() })
}

// remindClip：设提醒等于收下——剪贴卡先收进收件箱，再建一条到期提醒（正文写进提醒备注）。
func (a *app) remindClip(n store.Note, at time.Time) {
	undoKeep, copies := a.store.KeepClips([]string{n.ID}, store.SectionInbox)
	title := strings.TrimSpace(n.Title)
	if title == "" {
		title = preview(cmpOr(firstLine(n.Text), cardTitle(n)), 40)
	}
	t := a.store.AddTask(store.Task{Text: title, DueAt: at, Note: n.Text})
	a.reload()
	msg := fmt.Sprintf(tr("%s 提醒"), at.Format("01/02 15:04"))
	if len(copies) > 0 {
		msg += tr(" · 已收进收件箱")
	}
	a.showHUDUndo("ok", msg, func() {
		if t.ID != "" {
			a.store.DeleteTask(t.ID)
		}
		undoKeep()
		a.reload()
	})
}

// fileInbox：把收件箱里的内容归到 section（建议分组 / 逐条整理 / 按建议归好），可撤销。
func (a *app) fileInbox(ids []string, section func(store.Note) string, quiet bool) int {
	type move struct{ id, from, to string }
	var done []move
	learned := ""
	for _, id := range ids {
		n, ok := a.store.Note(id)
		if !ok || n.Section != store.SectionInbox {
			continue
		}
		to := section(n)
		if to == "" || to == n.Section {
			continue
		}
		if a.store.MoveTo(id, to) == nil {
			done = append(done, move{id, n.Section, to})
			if l := a.learnFileRule(n, to); l != "" {
				learned = l
			}
		}
	}
	a.reload()
	if len(done) == 0 || quiet {
		return len(done)
	}
	msg := fmt.Sprintf(tr("已归到「%s」"), a.sectionLabel(done[0].to))
	if len(done) > 1 {
		msg = fmt.Sprintf(tr("已按建议归好 %d 条"), len(done))
	}
	a.showHUDUndo("ok", msg+learned, func() {
		for _, m := range slices.Backward(done) {
			_ = a.store.MoveTo(m.id, m.from)
		}
		a.reload()
	})
	return len(done)
}

const learnRuleAfter = 3

// learnFileRule：同一来源应用 + 类型归到 section 满 3 次且还没有规则时，记一条规则，返回给气泡追加的说明。
// 调用时这一条已经在 section 里（剪贴卡副本已建好 / 收件箱条目已移入）。
func (a *app) learnFileRule(n store.Note, section string) string {
	if n.BundleID == "" || store.IsSystemSection(section) {
		return ""
	}
	kind := noteKind(n)
	st := a.store.Settings()
	if slices.ContainsFunc(st.FileRules, func(r store.FileRule) bool {
		return r.Bundle == n.BundleID && (r.Kind == "" || r.Kind == kind)
	}) {
		return ""
	}
	cnt := 0
	for _, x := range a.store.Notes() {
		if x.Section == section && x.BundleID == n.BundleID && noteKind(x) == kind {
			cnt++
		}
	}
	if cnt < learnRuleAfter {
		return ""
	}
	app := cmpOr(n.SourceApp, n.BundleID)
	a.patchSettings(func(x *store.Settings) {
		x.FileRules = append(slices.Clone(x.FileRules), store.FileRule{Bundle: n.BundleID, App: app, Kind: kind, Section: section})
	})
	return fmt.Sprintf(tr(" · 以后 %s 的%s建议归到这里"), app, kindName(kind))
}

// fileAllSuggested：「按建议归好」——收件箱里有建议的全部归到建议分组。
func (a *app) fileAllSuggested() {
	sug := maps.Clone(a.inboxSug)
	ids := slices.Collect(maps.Keys(sug))
	a.fileInbox(ids, func(n store.Note) string { return sug[n.ID].section }, false)
}

// fileRuleRows：设置「剪贴板」页的归类规则列表，每条可删。
func (a *app) fileRuleRows(c *ui.Context, s settingsTokens, st store.Settings) []setRow {
	if len(st.FileRules) == 0 {
		return []setRow{{title: tr("还没有规则"), hint: tr("在收件箱里归类几次后会自动出现")}}
	}
	var rows []setRow
	for i, r := range st.FileRules {
		to := a.sectionLabel(r.Section)
		if to == "" {
			to = tr("（分组已删除）")
		}
		rows = append(rows, setRow{
			title: fmt.Sprintf(tr("%s 的%s → %s"), cmpOr(r.App, r.Bundle), kindName(r.Kind), to),
			hint:  r.Bundle,
			control: func() {
				if button(c, s, tr("删除")) {
					a.patchSettings(func(x *store.Settings) {
						if i < len(x.FileRules) && x.FileRules[i] == r {
							x.FileRules = slices.Delete(slices.Clone(x.FileRules), i, i+1)
						}
					})
					a.reload()
					a.showHUD("ok", tr("已删除归类规则"))
				}
			},
		})
	}
	return rows
}
