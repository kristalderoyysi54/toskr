package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/detector"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// app 的字段只在主线程读写（view、窗口回调、托盘、快捷键都在主线程）；
// 其他 goroutine 一律经 panel.Update 回到主线程。
type app struct {
	sys   core.System
	store *store.Store

	panel, hud, settingsWin *mygo.Window
	tray                    *mygo.Tray

	// 面板状态
	tab      int // 0 笔记 1 剪贴板
	query    string
	notes    []store.Note // 当前分组 + 搜索后的视图
	counts   [2]int
	selected int
	list     ui.ListState
	search   ui.Handle
	draft    string
	draftIn  ui.Handle
	editing  string // 正在编辑的笔记 ID
	editText string
	pinned   bool
	target   macos.FrontApp // 发送目标：面板唤出前的前台应用

	// HUD
	hudText, hudKind string
	hudGen           int

	// 设置窗编辑态
	setModifier int
	setGap      float64
	setClip     bool
	setGlass    int
	setExcluded string
	axTrusted   bool
	tapErr      string
	shortcut    string
}

func newApp(sys core.System, st *store.Store) *app {
	a := &app{sys: sys, store: st, selected: 0}
	a.reload()
	return a
}

func sectionOf(tab int) string {
	if tab == 1 {
		return store.SectionClipboard
	}
	return store.SectionInbox
}

// reload 从 store 重建当前视图（主线程）。
func (a *app) reload() {
	inbox, clip := a.store.Section(store.SectionInbox), a.store.Section(store.SectionClipboard)
	a.counts = [2]int{len(inbox), len(clip)}
	src := inbox
	if a.tab == 1 {
		src = clip
	}
	a.notes = store.Search(src, a.query)
	a.selected = max(0, min(a.selected, len(a.notes)-1))
}

func (a *app) current() (store.Note, bool) {
	if a.selected < 0 || a.selected >= len(a.notes) {
		return store.Note{}, false
	}
	return a.notes[a.selected], true
}

// ---- 面板 ----

func (a *app) togglePanel() {
	if a.panel.IsVisible() {
		a.hidePanel()
		return
	}
	a.showPanel()
}

func (a *app) showPanel() {
	if f, ok := a.sys.Frontmost(); ok && f.PID != a.sys.SelfPID() {
		a.target = f
	}
	d := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint())
	const w, margin = 360, 10
	h := d.WorkArea.Height - margin*2
	a.panel.SetBounds(mygo.Rectangle{X: d.WorkArea.X + d.WorkArea.Width - w - margin, Y: d.WorkArea.Y + margin, Width: w, Height: h})
	a.reload()
	a.panel.Show()
	diag.Push("面板显示 target=%s", a.target.BundleID)
}

func (a *app) hidePanel() {
	a.editing = ""
	if a.panel != nil {
		a.panel.Hide()
	}
}

// ---- 触发与捕获 ----

// onTrigger 在事件监听线程调用：裁决「捕获选区」还是「开关面板」。
func (a *app) onTrigger() {
	front, ok := a.sys.Frontmost()
	if !ok || front.PID == a.sys.SelfPID() {
		a.panel.Update(a.togglePanel)
		return
	}
	if slices.Contains(a.store.Settings().ExcludedApps, front.BundleID) {
		diag.Push("捕获: %s 在排除名单，跳过", front.BundleID)
		a.panel.Update(a.togglePanel)
		return
	}
	go func() {
		started := time.Now()
		got, ok := core.Capture(a.sys, front)
		if !ok {
			diag.Push("捕获: 无选中内容 → 开关面板 (%dms)", time.Since(started).Milliseconds())
			a.panel.Update(a.togglePanel)
			return
		}
		note, dup, err := a.store.Add(store.Note{Section: store.SectionInbox, Text: got.Text, HTML: got.HTML,
			SourceApp: front.Name, BundleID: front.BundleID})
		diag.Push("捕获: %d 字符 来自 %s dup=%v %dms", len([]rune(got.Text)), front.BundleID, dup, time.Since(started).Milliseconds())
		a.panel.Update(func() {
			a.target = front
			if err != nil {
				a.showHUD("warn", "保存失败："+err.Error())
				return
			}
			kind, msg := "added", "已加入队列 · "+preview(note.Text, 18)
			if dup {
				kind, msg = "duplicate", "已存在，移到顶部"
			}
			a.showHUD(kind, msg)
		})
	}()
}

// ---- 笔记操作（主线程） ----

func (a *app) addDraft() {
	text := strings.TrimSpace(a.draft)
	if text == "" {
		return
	}
	if _, dup, err := a.store.Add(store.Note{Section: store.SectionInbox, Text: a.draft}); err == nil {
		a.draft = ""
		a.tab, a.query, a.selected = 0, "", 0
		if dup {
			a.showHUD("duplicate", "已存在，移到顶部")
		}
	}
}

func (a *app) deleteSelected(c *ui.Context) {
	n, ok := a.current()
	if !ok {
		return
	}
	removed, pos, ok := a.store.Delete(n.ID)
	if !ok {
		return
	}
	c.ToastAction("已删除 · "+preview(removed.Text, 14), "撤销", func() { _ = a.store.Restore(removed, pos) })
}

func (a *app) startEdit() {
	if n, ok := a.current(); ok {
		a.editing, a.editText = n.ID, n.Text
	}
}

func (a *app) commitEdit() {
	if a.editing != "" && strings.TrimSpace(a.editText) != "" {
		_ = a.store.Update(a.editing, a.editText)
	}
	a.editing = ""
}

// send 把 notes 依次拼接（空行分隔）发回目标应用；成功才标记完成。
func (a *app) send(notes []store.Note) {
	if len(notes) == 0 {
		return
	}
	target := a.target
	if target.PID == 0 {
		a.showHUD("warn", "没有发送目标：先切到要粘贴的应用再唤出面板")
		return
	}
	texts := make([]string, len(notes))
	ids := make([]string, len(notes))
	for i, n := range notes {
		texts[i], ids[i] = n.Text, n.ID
	}
	if !a.pinned {
		a.hidePanel()
	}
	go func() {
		err := core.Deliver(a.sys, target, strings.Join(texts, "\n\n"))
		diag.Push("发送: %d 条 → %s err=%v", len(notes), target.BundleID, err)
		a.panel.Update(func() {
			if err != nil {
				a.showHUD("warn", err.Error())
				return
			}
			_ = a.store.MarkSent(ids, time.Now())
			a.showHUD("sent", fmt.Sprintf("已发送 %d 条到 %s", len(notes), target.Name))
		})
	}()
}

func (a *app) sendSelected() {
	if n, ok := a.current(); ok {
		a.send([]store.Note{n})
	}
}

// sendQueue 发送当前分组全部未发送项（按队列从下到上，即最早的在前）。
func (a *app) sendQueue() {
	var pending []store.Note
	for i := len(a.notes) - 1; i >= 0; i-- {
		if a.notes[i].SentAt.IsZero() {
			pending = append(pending, a.notes[i])
		}
	}
	a.send(pending)
}

func (a *app) copySelected(c *ui.Context) {
	if n, ok := a.current(); ok {
		mygo.Clipboard.WriteText(n.Text)
		c.Toast("已复制")
	}
}

// reorder 是 ListState.Reorder 回调：把 rows 移到 to（仅无搜索时可排序）。
func (a *app) reorder(rows []int, to int) {
	if a.query != "" {
		return
	}
	moving := map[int]bool{}
	for _, r := range rows {
		moving[r] = true
	}
	var rest, picked []store.Note
	insert := 0
	for i, n := range a.notes {
		if moving[i] {
			picked = append(picked, n)
			continue
		}
		if i < to {
			insert++
		}
		rest = append(rest, n)
	}
	order := slices.Concat(rest[:insert], picked, rest[insert:])
	ids := make([]string, len(order))
	for i, n := range order {
		ids[i] = n.ID
	}
	_ = a.store.Reorder(sectionOf(a.tab), ids)
	a.selected = insert
}

// ---- 剪贴板监听 ----

func (a *app) watchClipboard() {
	w := &core.ClipWatcher{
		Sys:      a.sys,
		Excluded: func() []string { return a.store.Settings().ExcludedApps },
		Enabled:  func() bool { return a.store.Settings().ClipboardWatch },
	}
	go func() {
		for range time.Tick(core.ClipPoll) {
			ev, ok := w.Tick()
			if !ok || ev.Source.PID == a.sys.SelfPID() {
				continue
			}
			_, _, _ = a.store.Add(store.Note{Section: store.SectionClipboard, Text: ev.Text,
				SourceApp: ev.Source.Name, BundleID: ev.Source.BundleID})
			diag.Push("剪贴板: 收文本 %d 字符 来自 %s", len([]rune(ev.Text)), ev.Source.Name)
		}
	}()
}

// ---- 键盘监听 ----

func (a *app) startTap() {
	d := detector.New()
	var prev uint64
	seen := false
	err := macos.StartKeyTap(func(ev macos.KeyEvent) {
		if ev.Synthetic {
			return
		}
		if !seen { // 事件心跳：缺「输入监控」时 tap 能建但事件被静默扣留
			seen = true
			diag.Push("键盘事件流已到达（输入监控正常）")
		}
		st := a.store.Settings()
		d.ReleaseGap = time.Duration(max(st.TriggerGapMs, 150)) * time.Millisecond
		target, others := modifierFlags(st.TriggerModifier)
		var in detector.Event
		switch ev.Type {
		case macos.EventKeyDown:
			in = detector.Event{Kind: detector.Other}
		case macos.EventFlagsChanged:
			now, was := ev.Flags&target != 0, prev&target != 0
			prev = ev.Flags
			switch {
			case now && !was:
				in = detector.Event{Kind: detector.TargetDown, At: time.Now(), OtherMods: ev.Flags&others != 0}
			case !now && was:
				in = detector.Event{Kind: detector.TargetUp, At: time.Now()}
			default:
				in = detector.Event{Kind: detector.Other}
			}
		default:
			return
		}
		out := d.Feed(in)
		switch {
		case out.Triggered:
			diag.Push("双击触发")
			a.onTrigger()
		case out.Rejected != "":
			diag.Push("双击未触发: %s (%dms)", out.Rejected, out.Ms)
		}
	})
	if err != nil {
		a.tapErr = err.Error()
		diag.Push("键盘监听失败: %v", err)
		return
	}
	a.tapErr = ""
	diag.Push("键盘监听已建立")
}

func modifierFlags(name string) (target, others uint64) {
	all := macos.FlagShift | macos.FlagControl | macos.FlagOption | macos.FlagCommand
	switch name {
	case "control":
		target = macos.FlagControl
	case "option":
		target = macos.FlagOption
	default:
		target = macos.FlagShift
	}
	return target, all &^ target
}
