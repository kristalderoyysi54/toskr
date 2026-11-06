package main

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 剪贴页「按来源」分组头右键（同 Tauri ClipSourceHeader）：全选这 n 条、删除这 n 条（可撤销）、保留时长（默认 / 1 天 / 1 周 / 1 个月 / 1 年，
// 会立即清掉超期记录时先确认）、不再收集来自该应用。

var clipAppRetentionSteps = []int{1, 7, 30, 365}

// formatRetention 同 Tauri formatRetention。
func formatRetention(days int) string {
	switch {
	case days%365 == 0:
		return fmt.Sprintf(tr("%d 年"), days/365)
	case days%30 == 0:
		return fmt.Sprintf(tr("%d 个月"), days/30)
	case days%7 == 0:
		return fmt.Sprintf(tr("%d 周"), days/7)
	}
	return fmt.Sprintf(tr("%d 天"), days)
}

var retentionAsk = func(title, msg string) bool { // 测试替换；Dialog.Message 阻塞，调用方在后台 goroutine
	r, err := mygo.Dialog.Message(mygo.MessageOptions{Title: title, Message: msg, Buttons: []string{tr("调整并清理"), tr("取消")}, DefaultButton: 1})
	return err == nil && r.Button == 0
}

func (a *app) clipSourceMenu(row ui.Element, label string, band []store.Note) {
	n := len(band)
	ids := make([]string, n)
	for i, x := range band {
		ids[i] = x.ID
	}
	key := store.ClipSourceKey(band[0])
	bundle := band[0].BundleID
	row.ContextMenu(func(m *ui.Menu) {
		if m.Item(fmt.Sprintf(tr("全选这 %d 条"), n)).Chosen() {
			a.chosen.Clear()
			for _, id := range ids {
				a.chosen.Add(id)
			}
			a.showHUD("info", fmt.Sprintf(tr("已选中「%s」的 %d 条"), label, n))
		}
		if m.Item(fmt.Sprintf(tr("删除这 %d 条"), n)).Chosen() {
			a.deleteNotesUndo(ids, fmt.Sprintf(tr("已删除「%s」的 %d 条"), label, n))
		}
		if key == "" {
			return
		}
		m.Separator()
		st := a.store.Settings()
		cur, has := st.ClipAppRetention[key]
		m.Submenu(tr("保留时长"), func(sm *ui.Menu) {
			def := tr("永久")
			if st.ClipRetainDays > 0 {
				def = formatRetention(st.ClipRetainDays)
			}
			if sm.Item(fmt.Sprintf(tr("默认（%s）"), def)).Radio(!has).Chosen() {
				a.setClipRetention(key, label, 0, band)
			}
			for _, d := range clipAppRetentionSteps {
				if sm.Item(formatRetention(d)).Radio(has && cur == d).Chosen() {
					a.setClipRetention(key, label, d, band)
				}
			}
		})
		if bundle != "" {
			excluded := slices.Contains(st.ExcludedApps, bundle)
			title := fmt.Sprintf(tr("不再收集来自「%s」"), label)
			if excluded {
				title = fmt.Sprintf(tr("已不收集「%s」"), label)
			}
			if m.Item(title).Disabled(excluded).Chosen() {
				a.patchSettings(func(x *store.Settings) { x.ExcludedApps = append(slices.Clone(x.ExcludedApps), bundle) })
				a.setExcluded = strings.Join(a.store.Settings().ExcludedApps, "\n") // 设置窗编辑态同步，免得保存时覆盖回去
				a.showHUD("ok", fmt.Sprintf(tr("已不再收集来自「%s」的复制，现有记录保留"), label))
			}
		}
	})
}

// setClipRetention：days = 0 表示跟随全局。会立即清掉记录时先确认（同 Tauri ask 对话框）。
func (a *app) setClipRetention(key, label string, days int, band []store.Note) {
	st := a.store.Settings()
	if cur, ok := st.ClipAppRetention[key]; (days == 0 && !ok) || (ok && cur == days) {
		return
	}
	effective := days
	if days == 0 {
		effective = st.ClipRetainDays
	}
	doomed := 0
	if effective > 0 {
		cut := a.now().Add(-time.Duration(effective) * 24 * time.Hour)
		for _, n := range band {
			if !n.Kept && n.CreatedAt.Before(cut) {
				doomed++
			}
		}
	}
	apply := func() {
		a.patchSettings(func(x *store.Settings) {
			m := maps.Clone(x.ClipAppRetention)
			if m == nil {
				m = map[string]int{}
			}
			if days == 0 {
				delete(m, key)
			} else {
				m[key] = days
			}
			x.ClipAppRetention = m
		})
		cur := a.store.Settings()
		pruned := a.store.PruneClipboard(cur.ClipRetainDays, cur.ClipAppRetention, func() int64 { return a.now().Unix() })
		a.reload()
		if pruned > 0 {
			a.showHUD("ok", fmt.Sprintf(tr("已调整「%s」保留时长，清理 %d 条"), label, pruned))
		} else {
			a.showHUD("ok", fmt.Sprintf(tr("已调整「%s」保留时长"), label))
		}
	}
	if doomed == 0 {
		apply()
		return
	}
	dur := tr("默认")
	if days > 0 {
		dur = formatRetention(days)
	}
	title := fmt.Sprintf(tr("确定把「%s」的保留时长调整为「%s」吗？"), label, dur)
	msg := fmt.Sprintf(tr("「%s」有 %d 条记录超过新的保留时长，会被立即清理。\n已固定（★）的记录不会被删除。"), label, doomed)
	pfGo(func() {
		if retentionAsk(title, msg) {
			a.onMain(apply)
		}
	})
}
