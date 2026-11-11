package main

import (
	"fmt"
	"time"

	"github.com/egoist/mygo"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 设置窗的破坏性操作（同 Tauri SettingsView 的 ask 确认）：清空剪贴板历史、调短全局保留时长。

var clearClipAsk = func() bool { // 测试替换；Dialog.Message 阻塞，调用方在后台 goroutine
	r, err := mygo.Dialog.Message(mygo.MessageOptions{Title: tr("您确定要删除剪贴板历史记录吗？"),
		Message: tr("已固定（★）的记录不会被删除。\n删除后可在主面板的提示气泡中撤销一次。"),
		Buttons: []string{tr("清除"), tr("取消")}, DefaultButton: 1})
	return err == nil && r.Button == 0
}

// confirmClearClipboard：确认后清空未固定的剪贴记录，HUD 可撤销。
func (a *app) confirmClearClipboard() {
	pfGo(func() {
		if !clearClipAsk() {
			return
		}
		a.onMain(func() {
			removed := a.store.ClearSectionNotes(store.SectionClipboard)
			a.reload()
			a.showHUDUndo("ok", fmt.Sprintf(tr("已清空 %d 条"), len(removed)), func() {
				_ = a.store.RestoreMany(removed)
				a.reload()
			})
		})
	})
}

var (
	retainDebounce = 300 * time.Millisecond
	mouseHeld      = macos.MouseButtonsDown // 测试替换
)

// askRetention：全局保留时长调短时不立即生效——松开鼠标后（同 Tauri RetentionSlider 在 pointerup / 键盘提交时 ask）弹确认，
// 取消则滑块弹回原值。拖动中停顿不弹：鼠标仍按着就继续等；键盘调节停 300ms 后视为提交。
func (a *app) askRetention(old, next int) {
	a.retainAskGen++
	gen := a.retainAskGen
	var wait func()
	wait = func() {
		a.onMain(func() {
			if a.retainAskGen != gen {
				return // 值又变了：由新的一轮负责
			}
			if mouseHeld() {
				time.AfterFunc(100*time.Millisecond, wait)
				return
			}
			label := retentionLabel(next)
			title := fmt.Sprintf(tr("确定把保留时长调整为「%s」吗？"), label)
			msg := tr("比新的时长限制更旧的记录将被立即清理。\n已固定（★）的记录不会被删除。")
			pfGo(func() {
				ok := retentionAsk(title, msg)
				a.onMain(func() {
					if a.retainAskGen != gen {
						return
					}
					if !ok {
						a.setRetain = float64(old)
						return
					}
					a.patchSettings(func(s *store.Settings) { s.ClipRetainDays = next })
					cur := a.store.Settings()
					if n := a.store.PruneClipboard(cur.ClipRetainDays, cur.ClipAppRetention, func() int64 { return a.now().Unix() }); n > 0 {
						a.reload()
						a.showHUD("ok", fmt.Sprintf(tr("已调整保留时长，清理 %d 条"), n))
					}
				})
			})
		})
	}
	time.AfterFunc(retainDebounce, wait)
}
