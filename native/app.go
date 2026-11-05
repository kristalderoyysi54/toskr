package main

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/detector"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 面板页
// 页签与 Tauri 版一致：剪贴 / 笔记 / 任务；账单与秘文从「更多」菜单进入。
const (
	pageClip = iota
	pageNotes
	pageTasks
)

// delivery 是一条发送记录（内存中保留最近 50 条，设置 → 发送记录可查）。
type delivery struct {
	At     time.Time
	Target string
	Count  int
	Err    string
}

// app 的字段只在主线程读写（view、窗口回调、托盘、快捷键都在主线程）；
// 其他 goroutine 一律经 panel.Update 回到主线程。
type app struct {
	sys   core.System
	store *store.Store

	panel, hud, settingsWin, detailWin *mygo.Window
	tray                               *mygo.Tray

	// 面板状态
	page          int
	section       string // 当前笔记分组
	query         string
	notes         []store.Note // 当前分组 + 搜索后的未完成项
	done          []store.Note // 当前分组已完成项
	counts        map[string]int
	selected      int
	chosen        ui.Selection[string]
	list          ui.ListState
	search        ui.Handle
	draft         string
	draftIn       ui.Handle
	editing       string // 正在编辑的笔记 ID
	editText      string
	pinned        bool
	showDone      bool
	newSecOn      bool
	newSec        string
	target        macos.FrontApp // 发送目标：面板唤出前的前台应用
	targetStarted int64          // 目标进程启动时刻（身份锁定）
	pending       []store.Note   // 预检命中、等待确认的发送
	findings      []core.Finding
	history       []delivery
	thumbs        map[string]ui.ImageSource
	aiBusy        string // 正在 AI 处理的笔记 ID

	// 1:1 主面板
	noteGroups    []noteGroup
	doneOpen      map[string]bool
	searchOpen    bool
	menuOpen      bool
	placementOpen bool // 面板菜单「位置与停靠」二级页
	openAtLogin   bool // 设置页「开机启动」（打开设置时读一次）
	focusList     bool

	clock func() time.Time // 可注入时钟（视觉对照测试固定在参照截图时刻）

	// 任务页
	tasks     []store.Task
	taskDraft string
	taskSub   int // 0 今天 1 任务
	sparkMode bool
	clipView  string // 剪贴页视图：time | source | image
	noteSub   int    // 内容页子视图：0 笔记 1 秘文（秘文功能开启时）

	// 秘文
	secretKeyID   string
	secretDraft   string
	secretBusy    bool
	secretOpening map[string]bool   // 正在后台试解的卡
	secretPlain   map[string]string // 已显现的明文（只在内存）
	updMu         sync.Mutex
	updQueue      []func() // 无窗口时的主线程回调队列（视图测试）

	// 订阅子视图
	billDay       time.Time
	billView      string // week | month
	billFilter    string // upcoming | all
	billMonth     int    // 月历相对本月的偏移
	billAnalytics bool
	paying        string // 正在「标记已还」的账单
	payAmount     string
	bandOpen      map[string]bool // 智能区 / 分组折叠（已到期、灵感、已完成）
	taskIn        ui.Handle
	taskSel       int
	taskList      ui.ListState
	showDoneT     bool

	// 账单页
	bills    []store.Bill
	billForm billForm

	// 秘文页
	secrets  []store.Secret
	revealed map[string]time.Time

	// 详情窗
	detailText string
	detail     detailState

	// HUD
	hudText, hudKind string
	hudGen           int
	hudUndo          func() // 可撤销气泡的撤销动作
	hudHover         bool   // 光标在气泡上（关闭穿透、显出撤销）

	// 设置窗编辑态
	setModifier                         int
	setGap                              float64
	setClip                             bool
	setGlass                            int
	setExcluded                         string
	setRetain                           float64
	setLang                             int
	setAIKey                            string
	setAIEnd                            string
	setAIModel                          string
	setCompan                           string
	axTrusted                           bool
	tapErr                              string
	shortcut                            string
	recovery                            []string
	health                              string
	updateMsg                           string
	setPage                             int    // 设置窗左侧分类
	setSub                              int    // 分类内子页签
	setQuery                            string // 设置搜索
	setSearch                           ui.Handle
	newKeyLabel, newKeyPass, newKeyNote string // 设置「秘文」添加密钥的草稿
}

func newApp(sys core.System, st *store.Store) *app {
	a := &app{sys: sys, store: st, page: pageNotes, section: store.SectionInbox, doneOpen: map[string]bool{}, bandOpen: map[string]bool{"overdue": true, "spark": true}, clipView: "time", billView: "week", billFilter: "upcoming", clock: time.Now, thumbs: map[string]ui.ImageSource{}, revealed: map[string]time.Time{}, secretOpening: map[string]bool{}, secretPlain: map[string]string{}}
	a.reload()
	return a
}

// reload 从 store 重建当前视图（主线程）。
func (a *app) reload() {
	all := a.store.Notes()
	a.counts = map[string]int{}
	for _, n := range all {
		if !n.Done {
			a.counts[n.Section]++
		}
	}
	if !slices.ContainsFunc(a.store.Sections(), func(s store.Section) bool { return s.ID == a.section }) {
		a.section = store.SectionInbox
	}
	a.notes, a.done = a.notes[:0], a.done[:0]
	if a.page == pageClip {
		a.notes = arrangeClips(append(a.notes, store.Search(a.store.Section(store.SectionClipboard), a.query)...), a.clipView)
	} else {
		// 笔记页：所有非剪贴板分组按顺序展开，键盘选择在扁平列表上移动
		a.noteGroups = a.groups()
		for _, g := range a.noteGroups {
			if !g.sec.Collapsed {
				a.notes = append(a.notes, g.open...)
			}
			a.done = append(a.done, g.done...)
		}
	}
	a.selected = max(0, min(a.selected, len(a.notes)-1))
	a.tasks = a.store.Tasks()
	a.bills = a.store.Bills()
	a.secrets = a.store.Secrets()
}

func (a *app) current() (store.Note, bool) {
	if a.selected < 0 || a.selected >= len(a.notes) {
		return store.Note{}, false
	}
	return a.notes[a.selected], true
}

// chosenNotes 返回多选中的笔记（按列表顺序）；未多选时返回当前项。
func (a *app) chosenNotes() []store.Note {
	if a.chosen.Len() > 1 {
		var out []store.Note
		for _, n := range a.notes {
			if a.chosen.Has(n.ID) {
				out = append(out, n)
			}
		}
		return out
	}
	if n, ok := a.current(); ok {
		return []store.Note{n}
	}
	return nil
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
		a.targetStarted = macos.ProcessStartMs(f.PID)
	}
	if !a.store.Settings().FreeMove { // 自由移动：保留用户拖到的位置
		a.panel.SetBounds(a.panelBounds())
	}
	a.reload()
	a.panel.Show()
	diag.Push("面板显示 target=%s", a.target.BundleID)
}

func (a *app) hidePanel() {
	a.editing = ""
	a.remaskAll() // 秘文：面板收起即回遮罩，明文丢弃
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
		if a.captureSecret(got.Text, front.Name) {
			return // 秘文信封：解密进秘文页，绝不进普通笔记
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
			if dup {
				a.showHUD("duplicate", preview(note.Text, 40))
				return
			}
			a.playCaptureSound()
			a.showHUDUndo("added", preview(note.Text, 40), func() { // 撤销捕获：删掉刚收进的笔记
				a.store.Delete(note.ID)
				a.reload()
			})
		})
	}()
}

// ---- 笔记操作（主线程） ----

func (a *app) addDraft() {
	text := strings.TrimSpace(a.draft)
	if text == "" {
		return
	}
	sec := a.section
	if sec == store.SectionClipboard {
		sec = store.SectionInbox
	}
	if _, dup, err := a.store.Add(store.Note{Section: sec, Text: a.draft}); err == nil {
		a.draft = ""
		a.section, a.query, a.selected = sec, "", 0
		if dup {
			a.showHUD("duplicate", tr("已存在，移到顶部"))
		}
	}
}

func (a *app) deleteSelected(c *ui.Context) {
	notes := a.chosenNotes()
	if len(notes) == 0 {
		return
	}
	type gone struct {
		n   store.Note
		pos int
	}
	var removed []gone
	for _, n := range notes {
		if r, pos, ok := a.store.Delete(n.ID); ok {
			removed = append(removed, gone{r, pos})
		}
	}
	a.chosen.Clear()
	if len(removed) == 0 {
		return
	}
	msg := "已删除 · " + preview(removed[0].n.Text, 14)
	if len(removed) > 1 {
		msg = fmt.Sprintf("已删除 %d 条", len(removed))
	}
	c.ToastAction(msg, "撤销", func() {
		for i := len(removed) - 1; i >= 0; i-- {
			_ = a.store.Restore(removed[i].n, removed[i].pos)
		}
	})
}

func (a *app) mergeChosen(c *ui.Context) {
	notes := a.chosenNotes()
	if len(notes) < 2 {
		return
	}
	ids := make([]string, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
	}
	merged, originals, ok := a.store.Merge(ids, "\n\n")
	if !ok {
		return
	}
	a.chosen.Clear()
	c.ToastAction(fmt.Sprintf("已合并 %d 条", len(originals)), "撤销", func() { _ = a.store.Unmerge(merged, originals) })
}

func (a *app) repositionPanel() {
	if a.panel != nil {
		a.panel.SetBounds(a.panelBounds())
	}
}

// clearAllDone 是面板菜单「清理已完成」：笔记视图清全部分组的已完成笔记，任务页清已完成任务；均可撤销。
func (a *app) clearAllDone(c *ui.Context) {
	if a.page == pageTasks {
		var removed []store.Task
		var pos []int
		for _, t := range a.store.Tasks() {
			if t.Status == "done" {
				if r, p, ok := a.store.DeleteTask(t.ID); ok {
					removed, pos = append(removed, r), append(pos, p)
				}
			}
		}
		if len(removed) > 0 {
			c.ToastAction(fmt.Sprintf(tr("已清理 %d 个已完成任务"), len(removed)), tr("撤销"), func() {
				for i := len(removed) - 1; i >= 0; i-- {
					_ = a.store.RestoreTask(removed[i], pos[i])
				}
			})
		}
		a.reload()
		return
	}
	var removed []store.Note
	for _, sec := range a.store.Sections() {
		if sec.ID != store.SectionClipboard {
			removed = append(removed, a.store.ClearDone(sec.ID)...)
		}
	}
	if len(removed) > 0 {
		c.ToastAction(fmt.Sprintf("已清理 %d 条已完成", len(removed)), "撤销", func() { _ = a.store.RestoreMany(removed) })
	}
	a.reload()
}

func (a *app) clearDone(c *ui.Context) {
	removed := a.store.ClearDone(a.section)
	if len(removed) > 0 {
		c.ToastAction(fmt.Sprintf("已清理 %d 条已完成", len(removed)), "撤销", func() { _ = a.store.RestoreMany(removed) })
	}
}

func (a *app) startEdit() {
	if n, ok := a.current(); ok && n.Kind != "image" {
		a.editing, a.editText = n.ID, n.Text
	}
}

func (a *app) commitEdit() {
	if a.editing != "" && strings.TrimSpace(a.editText) != "" {
		_ = a.store.Update(a.editing, a.editText)
	}
	a.editing = ""
}

// send 先做敏感内容预检，命中则挂起等确认；否则直接投递。
func (a *app) send(notes []store.Note) {
	if len(notes) == 0 {
		return
	}
	if a.target.PID == 0 {
		a.showHUD("warn", tr("没有发送目标：先切到要粘贴的应用再唤出面板"))
		return
	}
	var fs []core.Finding
	for _, n := range notes {
		fs = append(fs, core.Preflight(n.Text)...)
	}
	if len(fs) > 0 {
		a.pending, a.findings = notes, fs
		if a.panel != nil {
			a.panel.Show() // 确认条在面板里
		}
		return
	}
	a.deliver(notes, false)
}

// confirmPending 处理预检确认条：redact 为 true 时遮罩命中处再发。
func (a *app) confirmPending(redact bool) {
	notes := a.pending
	a.pending, a.findings = nil, nil
	if redact {
		notes = slices.Clone(notes)
		for i := range notes {
			notes[i].Text = core.Redact(notes[i].Text, core.Preflight(notes[i].Text))
		}
	}
	a.deliver(notes, true)
}

func (a *app) deliver(notes []store.Note, confirmed bool) {
	target := a.target
	var texts []string
	var png []byte
	ids := make([]string, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
		if n.Kind == "image" && png == nil && len(notes) == 1 {
			png, _ = a.store.LoadImage(n.ImageFile)
			continue
		}
		texts = append(texts, n.Text)
	}
	enter := a.store.Settings().PasteThenEnter && !isTerminal(target.BundleID)
	if !a.pinned {
		a.hidePanel()
	}
	go func() {
		check, err := core.DeliverWith(a.sys, target, core.Payload{Text: strings.Join(texts, "\n\n"), PNG: png}, core.Options{Enter: enter, StartedMs: a.targetStarted})
		diag.Push("发送: %d 条 → %s enter=%v confirmed=%v check=%s err=%v", len(notes), target.BundleID, enter, confirmed, check, err)
		a.panel.Update(func() {
			rec := delivery{At: time.Now(), Target: target.Name, Count: len(notes)}
			if err != nil {
				rec.Err = err.Error()
			}
			a.history = append([]delivery{rec}, a.history[:min(len(a.history), 49)]...)
			if err != nil {
				a.showHUD("warn", err.Error())
				return
			}
			_ = a.store.MarkSent(ids, time.Now())
			if check == core.CheckUnchanged {
				a.showHUD("warn", tr("已粘贴，但目标输入框内容没有变化，请确认是否发送成功"))
				return
			}
			a.showHUD("sent", fmt.Sprintf(tr("已发送 %d 条到 %s"), len(notes), target.Name))
		})
	}()
}

// isTerminal：终端里「粘贴后回车」等于直接执行命令，默认不补回车。
func isTerminal(bundle string) bool {
	return slices.Contains([]string{"com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty", "net.kovidgoyal.kitty"}, bundle)
}

func (a *app) sendSelected() { a.send(a.chosenNotes()) }

// sendQueue 发送当前分组全部未完成项（按队列从下到上，即最早的在前）。
func (a *app) sendQueue() {
	var pending []store.Note
	for i := len(a.notes) - 1; i >= 0; i-- {
		if a.notes[i].Kind != "image" {
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
	order := slices.Concat(rest[:insert], picked, rest[insert:], a.done)
	ids := make([]string, len(order))
	for i, n := range order {
		ids[i] = n.ID
	}
	_ = a.store.Reorder(a.section, ids)
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

func (a *app) now() time.Time { return a.clock() }
