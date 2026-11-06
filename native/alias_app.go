package main

import (
	"fmt"
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
