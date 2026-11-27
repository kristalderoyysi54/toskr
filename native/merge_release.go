package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 迭代期 → 正式版的可重复并入（用户 2026-11-25）：迭代期日常用着存下的内容，正式版那份数据里没有。
// 设置 → 数据与备份 →「并入正式版」：把这里有而正式版没有的补过去（规则见 store.MergeInto），可以反复点。
// 与 handoff.go 的一次性交接不同：那个要求正式版还没有数据，这个要求已经有。
// 正式版在运行时不做（它会把并入的内容当成外部修改而进只读）。读正式版密钥时系统会弹一次钥匙串授权框。

var ( // 测试替换
	releaseRunning = func() bool { return len(macos.RunningPIDs(releaseBundle)) > 0 }
	mergeAsk       = func(r store.MergeReport) bool { return confirmAsk(mergeSpec(r)) }
)

func mergeSpec(r store.MergeReport) confirmSpec {
	facts := []confirmFact{{label: tr("笔记"), value: fmt.Sprintf(tr("新增 %d · 更新 %d"), r.Notes-r.Clips, r.Updated)}}
	if r.Clips+r.ClipSkip > 0 {
		facts = append(facts, confirmFact{label: tr("剪贴"), value: fmt.Sprintf(tr("置顶的 %d 条 · 其余 %d 条不带"), r.Clips, r.ClipSkip)})
	}
	if n := r.Tasks + r.Bills + r.Secrets + r.Messages; n > 0 {
		facts = append(facts, confirmFact{label: tr("其它"), value: fmt.Sprintf(tr("任务 %d · 账单 %d · 秘文 %d · 消息 %d"), r.Tasks, r.Bills, r.Secrets, r.Messages)})
	}
	if r.Sections > 0 {
		facts = append(facts, confirmFact{label: tr("新分组"), value: itoa(r.Sections)})
	}
	facts = append(facts, confirmFact{label: tr("位置"), value: shortHome(r.Target)})
	return confirmSpec{icon: "arrow-down-to-line", title: tr("并入正式版 Toskr？"),
		body:  tr("只补正式版没有的内容；正式版已有的、已删的都不动。"),
		facts: facts, note: tr("并入前会在正式版留一个恢复点；这里的数据原样保留。"), ok: tr("并入")}
}

// mergeToRelease：设置里的「并入正式版」。
func (a *app) mergeToRelease() {
	if a.merging {
		a.showHUD("info", tr("正在并入…"))
		return
	}
	a.merging = true
	done := func(kind, msg string) {
		a.onMain(func() {
			a.merging = false
			a.showHUDForce(kind, msg)
		})
	}
	pfGo(func() {
		if releaseRunning() {
			done("warn", tr("先退出正式版 Toskr，再并入"))
			return
		}
		dst, err := handoffTarget()
		if err != nil {
			done("warn", err.Error())
			return
		}
		if _, err := os.Stat(filepath.Join(dst, store.DataFile)); err != nil {
			done("warn", tr("正式版还没有数据：先打开一次正式版 Toskr"))
			return
		}
		unlock, err := lockDataDir(dst) // 带写者锁的正式版开着时这里就占不到
		if err != nil {
			done("warn", err.Error())
			return
		}
		defer unlock()
		key, err := tauriKey() // 正式版的数据密钥 = 旧版那一把
		if err != nil {
			done("warn", tr("读不到正式版的数据密钥：")+err.Error())
			return
		}
		defer clear(key)
		pre, err := a.store.MergeInto(dst, key, false)
		if err != nil {
			diag.Push("并入正式版：预检失败 %v", err)
			done("warn", tr("不能并入：")+err.Error())
			return
		}
		if pre.Empty() {
			done("info", tr("正式版已是最新，没有要并入的内容"))
			return
		}
		if !mergeAsk(pre) {
			a.onMain(func() { a.merging = false })
			return
		}
		if releaseRunning() { // 确认窗开着的时候正式版被打开了
			done("warn", tr("先退出正式版 Toskr，再并入"))
			return
		}
		rep, err := a.store.MergeInto(dst, key, true)
		if err != nil {
			diag.Push("并入正式版：失败 %v", err)
			done("warn", tr("并入没有完成：")+err.Error())
			return
		}
		diag.Push("并入正式版完成 新增=%d 更新=%d 任务=%d 账单=%d 秘文=%d 消息=%d 分组=%d 图片=%d 跳过相同剪贴=%d 不带回=%d 目标共 %d 条",
			rep.Notes, rep.Updated, rep.Tasks, rep.Bills, rep.Secrets, rep.Messages, rep.Sections, rep.Media, rep.ClipDup, rep.Gone, rep.TargetNotes)
		done("ok", fmt.Sprintf(tr("已并入正式版：新增 %d 条、更新 %d 条"), rep.Notes, rep.Updated))
	})
}

func init() {
	for k, v := range map[string]string{
		"并入正式版": "Merge into Toskr", "把这里新增的内容补进正式版 Toskr，可反复执行": "Add what's new here to the release Toskr; safe to repeat",
		"数据只读：由更新版本的 Toskr 写入":               "Read-only: written by a newer Toskr",
		"这个版本不认识其中的新内容，为免抹掉它们已停止保存。更新应用后恢复。": "This version can't read some newer content, so saving is paused to avoid erasing it. Update the app to resume.",
		"并入…": "Merge…", "并入": "Merge", "正在并入…": "Merging…", "并入正式版 Toskr？": "Merge into the release Toskr?",
		"只补正式版没有的内容；正式版已有的、已删的都不动。": "Only adds what the release doesn't have; existing and deleted items there stay as they are.",
		"并入前会在正式版留一个恢复点；这里的数据原样保留。": "A recovery point is written in the release first; data here is kept.",
		"置顶的 %d 条 · 其余 %d 条不带":      "%d pinned · %d others left out", "新增 %d · 更新 %d": "%d new · %d updated", "其它": "Other", "新分组": "New groups",
		"任务 %d · 账单 %d · 秘文 %d · 消息 %d": "%d tasks · %d bills · %d secrets · %d messages",
		"先退出正式版 Toskr，再并入":              "Quit the release Toskr first", "正式版还没有数据：先打开一次正式版 Toskr": "The release has no data yet: open it once first",
		"读不到正式版的数据密钥：": "Can't read the release data key: ", "不能并入：": "Can't merge: ", "并入没有完成：": "Merge didn't finish: ",
		"正式版已是最新，没有要并入的内容": "Nothing new to merge", "已并入正式版：新增 %d 条、更新 %d 条": "Merged: %d new, %d updated",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
