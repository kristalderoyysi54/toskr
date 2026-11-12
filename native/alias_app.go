package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/store"
)

// aliasNotes：发送前按化名词典把原文换成固定占位符（同 Tauri buildDraft applyAliasEntities：先于隐私检查；秘文与图片卡跳过）。
// 返回副本，原卡不动。
func (a *app) aliasNotes(notes []store.Note) []store.Note {
	st := a.store.Settings()
	if st.AliasOff || len(st.AliasEntities) == 0 {
		return notes
	}
	out := make([]store.Note, len(notes))
	for i, n := range notes {
		if n.Kind != "secret" && n.Kind != "image" {
			n.Text, _ = core.ApplyAliases(n.Text, st.AliasEntities)
		}
		out[i] = n
	}
	return out
}

// restoreCardAliases：卡片上的「恢复化名」——把词典占位符换回原文（可撤销）。
func (a *app) restoreCardAliases(n store.Note) {
	dict := a.store.Settings().AliasEntities
	out, c := core.RestoreAliases(n.Text, dict)
	if c == 0 {
		return
	}
	prev := n.Text
	_ = a.store.Update(n.ID, out)
	a.showHUDUndo("ok", fmt.Sprintf(tr("已恢复 %d 处化名"), c), func() { _ = a.store.Update(n.ID, prev) })
}

// captureRestoreAliases：划词捕获入库时自动把词典占位符恢复为原文（同 Tauri aliasAutoRestoreOnCapture，默认开）。
func (a *app) captureRestoreAliases(text string) string {
	st := a.store.Settings()
	if st.AliasNoAutoRestore || len(st.AliasEntities) == 0 {
		return text
	}
	out, _ := core.RestoreAliases(text, st.AliasEntities)
	return out
}

// addAliasEntity：新增词典条目（取号只增不减）。返回错误提示（空 = 成功）。
func (a *app) addAliasEntity(category, original string) string {
	st := a.store.Settings()
	if issue := core.AliasOriginalIssue(original, st.AliasEntities, ""); issue != "" {
		return issue
	}
	if category == "" {
		category = core.SuggestAliasCategory(original)
	}
	ph, next := core.AllocateAliasPlaceholder(category, st.AliasNext)
	now := time.Now().UnixMilli()
	st.AliasEntities = append(st.AliasEntities, store.AliasEntity{ID: fmt.Sprintf("alias-%d", time.Now().UnixNano()), Category: category, OriginalText: original, Placeholder: ph, CreatedAtMs: now, UpdatedAtMs: now})
	st.AliasNext = next
	_ = a.store.SetSettings(st)
	return ""
}

// quickAddAlias 同 Tauri addAliasEntityFromText：详情窗划词「加入化名词典」——校验 → 取号 → 写入，HUD 回执。
func (a *app) quickAddAlias(original, category string) bool {
	original = strings.TrimSpace(original)
	if original == "" {
		return false
	}
	known := false
	for _, c := range core.AliasPresetCategories {
		known = known || c.Code == category
	}
	for _, c := range a.store.Settings().AliasCategories {
		known = known || c.Code == category
	}
	if !known {
		a.showHUD("warn", tr("无法加入词典：类别无效"))
		return false
	}
	if issue := a.addAliasEntity(category, original); issue != "" {
		a.showHUD("warn", fmt.Sprintf(tr("无法加入词典：%s"), tr(issue)))
		return false
	}
	st := a.store.Settings()
	ph := st.AliasEntities[len(st.AliasEntities)-1].Placeholder
	preview := original
	if r := []rune(original); len(r) > 12 {
		preview = string(r[:12]) + "…"
	}
	if st.AliasOff {
		a.showHUD("added", fmt.Sprintf(tr("已加入词典（%s）；可逆化名总开关当前关闭"), ph))
	} else {
		a.showHUD("added", fmt.Sprintf(tr("已加入化名词典：%s → %s"), preview, ph))
	}
	return true
}
