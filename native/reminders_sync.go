package main

import (
	"fmt"
	"hash/fnv"
	"maps"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 任务 ⇄ 苹果「提醒事项」同步调度（同 Tauri appleReminders.ts useAppleRemindersSync）：开启后先对账一轮，
// 此后任务变化（1.5s 防抖）与系统提醒库变化（0.8s 防抖）各触发一轮；同一时刻只跑一轮，期间的触发合并为跑完再补一轮。
// 原生版推到单独的「Toskr Native」列表：评估期 Tauri 版仍在同步「Toskr」列表，共用一个列表会互删对方的提醒。

// 正式版接替旧版后直接用旧版的「Toskr」列表（关联键同为 toskr://task/<任务 id>，任务 id 随导入保留）。
func remindersListTitle() string { return appName() }

var ( // 测试替换
	remStatus  = macos.RemindersStatus
	remRequest = macos.RequestRemindersAccess
	remFetch   = macos.FetchReminders
	remWrite   = macos.WriteReminders
	remWatch   = macos.OnEventStoreChanged
)

type remStats struct {
	rounds, created, updated, deleted, imported, completed, missing, titleBack, notesBack, dueBack, conflicts, failures int
	lastErr                                                                                                             string
	lastErrAt                                                                                                           time.Time
}

type remSync struct {
	mu        sync.Mutex
	running   bool
	again     bool
	forced    bool
	timer     *time.Timer
	recreate  map[string]bool
	fp        uint64
	stats     remStats
	statusStr string // 授权状态（设置页显示）
	watching  bool
}

// remindersFingerprint：只看影响下发内容的字段；同步写回的基准字段不算，免得每轮都触发下一轮。
func remindersFingerprint(tasks []store.Task, alarm bool) uint64 {
	h := fnv.New64a()
	fmt.Fprint(h, alarm)
	for _, t := range tasks {
		fmt.Fprint(h, t.ID, t.Text, t.Note, t.Status, t.Priority, t.DueAt.Unix(), t.Spark, t.Offsets(), t.AppleSyncOff, t.AppleSyncedID, t.AppleImportItemID, "|")
	}
	return h.Sum64()
}

// remindersChanged 挂在 store.OnChange 上：任务内容变了才排一轮。
func (a *app) remindersChanged() {
	st := a.store.Settings()
	if !st.RemindersOn {
		return
	}
	fp := remindersFingerprint(a.store.Tasks(), st.RemindersAlarm)
	a.rem.mu.Lock()
	changed := fp != a.rem.fp
	a.rem.fp = fp
	a.rem.mu.Unlock()
	if changed {
		a.scheduleReminderSync(1500 * time.Millisecond)
	}
}

func (a *app) scheduleReminderSync(d time.Duration) {
	a.rem.mu.Lock()
	defer a.rem.mu.Unlock()
	if !a.rem.watching {
		a.rem.watching = true
		remWatch(func() { a.scheduleReminderSync(800 * time.Millisecond) })
	}
	if a.rem.timer != nil {
		a.rem.timer.Stop()
	}
	a.rem.timer = time.AfterFunc(d, a.runReminderSync)
}

// syncRemindersNow：设置页「立即同步」——本轮（或排队的下一轮）结束后提示结果。
func (a *app) syncRemindersNow() {
	a.rem.mu.Lock()
	a.rem.forced = true
	a.rem.mu.Unlock()
	go a.runReminderSync()
}

func toMacReminder(w store.DesiredReminder) macos.Reminder {
	r := macos.Reminder{Title: w.Title, Notes: w.Notes, Priority: w.Priority, Completed: w.Completed, Alarms: w.Alarms}
	if w.Due != nil {
		r.HasDue, r.Y, r.M, r.D, r.H, r.Mi = true, w.Due.Y, w.Due.M, w.Due.D, w.Due.H, w.Due.Mi
	}
	return r
}

func fromMacReminder(it macos.Reminder) store.RemoteReminder {
	r := store.RemoteReminder{ItemID: it.ItemID, Title: it.Title, Notes: it.Notes, Priority: it.Priority, Completed: it.Completed, Alarms: it.Alarms}
	if id, ok := strings.CutPrefix(it.URL, store.ReminderURLPrefix); ok {
		r.TaskID = id
	}
	if it.HasDue {
		r.Due = &store.DueParts{Y: it.Y, M: it.M, D: it.D, H: it.H, Mi: it.Mi}
	}
	return r
}

// remindersOps 把对账计划翻译成写操作（回流的标题 / 备注 / 到期按对端算）。
func remindersOps(p store.ReminderPlan, desired []store.DesiredReminder) []macos.ReminderOp {
	byTask := map[string]store.DesiredReminder{}
	for _, w := range desired {
		byTask[w.TaskID] = p.Effective(w)
	}
	var ops []macos.ReminderOp
	for _, id := range p.Create {
		ops = append(ops, macos.ReminderOp{Kind: "create", URL: store.ReminderURLPrefix + id, Want: toMacReminder(byTask[id])})
	}
	for _, u := range p.Update {
		ops = append(ops, macos.ReminderOp{Kind: "update", ItemID: u[0], Want: toMacReminder(byTask[u[1]])})
	}
	for _, u := range p.Adopt {
		ops = append(ops, macos.ReminderOp{Kind: "adopt", ItemID: u[0], URL: store.ReminderURLPrefix + u[1], Want: toMacReminder(byTask[u[1]])})
	}
	for _, id := range p.Delete {
		ops = append(ops, macos.ReminderOp{Kind: "delete", ItemID: id})
	}
	return ops
}

// runReminderSync 跑一轮（在后台 goroutine）：拉取 → 对账 → 写对端 → 回主线程写回任务。
func (a *app) runReminderSync() {
	r := &a.rem
	r.mu.Lock()
	if r.running {
		r.again = true
		r.mu.Unlock()
		return
	}
	r.running = true
	manual := r.forced
	r.forced = false
	recreate := maps.Clone(r.recreate)
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.running = false
		again := r.again
		r.again = false
		r.mu.Unlock()
		if again {
			go a.runReminderSync()
		}
	}()
	st := a.store.Settings()
	if !st.RemindersOn {
		return
	}
	fail := func(err error) {
		msg := err.Error()
		r.mu.Lock()
		r.stats.failures++
		r.stats.lastErr, r.stats.lastErrAt = msg, time.Now()
		r.mu.Unlock()
		diag.Push("提醒事项同步失败: %s", msg)
		a.onMain(func() {
			if cur := a.store.Settings(); cur.RemindersError != msg {
				cur.RemindersError = msg
				_ = a.store.SetSettings(cur)
			}
			if manual {
				a.showHUD("warn", tr("提醒事项同步失败：")+msg)
			}
		})
	}
	desired := store.DesiredReminders(a.store.Tasks(), recreate, st.RemindersAlarm)
	listID, items, err := remFetch(st.RemindersListID, remindersListTitle())
	if err != nil {
		fail(err)
		return
	}
	remote := make([]store.RemoteReminder, 0, len(items))
	for _, it := range items {
		remote = append(remote, fromMacReminder(it))
	}
	plan := store.PlanReminders(desired, remote)
	if err := remWrite(listID, remindersOps(plan, desired)); err != nil {
		fail(err)
		return
	}
	receipt := plan.Receipt(desired)
	done := make(chan struct{})
	a.onMain(func() { // 等写回完成再放下一轮：否则下一轮拿旧任务对账会重复新建
		defer close(done)
		a.applyReminderResult(plan, receipt, listID, manual)
	})
	<-done
}

func (a *app) applyReminderResult(plan store.ReminderPlan, receipt store.ReminderReceipt, listID string, manual bool) {
	r := &a.rem
	r.mu.Lock()
	if r.recreate == nil {
		r.recreate = map[string]bool{}
	}
	for _, id := range plan.DeletedTasks {
		r.recreate[id] = true
	}
	for _, id := range plan.Create {
		delete(r.recreate, id)
	}
	s := &r.stats
	s.rounds++
	s.created += len(plan.Create)
	s.updated += len(plan.Update) + len(plan.Adopt)
	s.deleted += len(plan.Delete)
	s.imported += len(plan.Import)
	s.completed += len(plan.CompletedRemote)
	s.missing += len(plan.Missing)
	s.titleBack += len(plan.TitleRemote)
	s.notesBack += len(plan.NotesRemote)
	s.dueBack += len(plan.DueRemote)
	s.conflicts += len(plan.Conflicts)
	r.mu.Unlock()

	a.store.MarkReminderSync(receipt)
	st := a.store.Settings()
	if n := a.store.ImportReminders(plan.Import, st.RemindersSection); n > 0 {
		a.showHUD("added", fmt.Sprintf(tr("从提醒事项导入了 %d 个任务"), n))
	}
	closed := 0
	for _, id := range plan.CompletedRemote {
		if t, ok := a.taskByID(id); ok && t.Status != "done" {
			a.store.CompleteTask(id, true, a.now())
			closed++
		}
	}
	if closed > 0 {
		a.showHUD("ok", fmt.Sprintf(tr("在提醒事项中完成了 %d 个任务"), closed))
	}
	if len(plan.Conflicts) > 0 { // 冲突气泡放最后：HUD 与撤销都是单槽
		conflicts := plan.Conflicts
		a.showHUDUndo("info", conflictTipText(conflicts), func() {
			a.store.ApplyReminderTheirs(conflicts)
			a.showHUD("undone", tr("已改用提醒事项里的版本"))
		})
	}
	var summary []string
	for _, x := range []struct {
		l string
		n int
	}{{"新建", len(plan.Create)}, {"更新", len(plan.Update)}, {"删除", len(plan.Delete)}, {"导入", len(plan.Import)}, {"认领", len(plan.Adopt)},
		{"对端完成", len(plan.CompletedRemote)}, {"对端删除", len(plan.Missing)}, {"标题回流", len(plan.TitleRemote)},
		{"备注回流", len(plan.NotesRemote)}, {"到期回流", len(plan.DueRemote)}, {"冲突", len(plan.Conflicts)}} {
		if x.n > 0 {
			summary = append(summary, fmt.Sprintf("%s %d", x.l, x.n))
		}
	}
	if len(summary) > 0 {
		diag.Push("提醒事项同步: %s", strings.Join(summary, " / "))
	}
	cur := a.store.Settings()
	now := time.Now()
	stale := manual || cur.RemindersSyncAt.IsZero() || now.Sub(cur.RemindersSyncAt) >= 30*time.Second // 自动同步最多每 30s 写一次
	if stale || cur.RemindersListID != listID || cur.RemindersError != "" {
		cur.RemindersListID, cur.RemindersError = listID, ""
		if stale {
			cur.RemindersSyncAt = now
		}
		_ = a.store.SetSettings(cur)
	}
	if manual {
		a.showHUD("ok", tr("提醒事项已同步"))
	}
}

// conflictTipText 同 Tauri：单处写出被覆盖的对端内容，多处给数量。
func conflictTipText(cs []store.ReminderConflict) string {
	if len(cs) > 1 {
		return fmt.Sprintf(tr("提醒事项里有 %d 处修改与 Toskr 冲突，已以 Toskr 为准（撤销可改用提醒事项版本）"), len(cs))
	}
	c := cs[0]
	switch c.Field {
	case "title":
		return fmt.Sprintf(tr("提醒事项里改的标题已被 Toskr 覆盖：「%s」（撤销可改用）"), c.Theirs)
	case "notes":
		return fmt.Sprintf(tr("提醒事项里改的备注已被 Toskr 覆盖：「%s」（撤销可改用）"), c.Theirs)
	}
	label := tr("无到期")
	if d := store.DueFromKey(c.Theirs); d != nil {
		at := d.Time()
		label = monthDay(at)
		if d.H >= 0 {
			label += " " + at.Format("15:04")
		}
	}
	return fmt.Sprintf(tr("提醒事项里改的到期已被 Toskr 覆盖：%s（撤销可改用）"), label)
}

// setRemindersEnabled：打开时没问过就弹系统授权框；被拒带到隐私设置；有权限立即对账。
func (a *app) setRemindersEnabled(on bool) {
	cur := a.store.Settings()
	cur.RemindersOn = on
	_ = a.store.SetSettings(cur)
	if !on {
		return
	}
	calAsync(func() {
		st := remStatus()
		if st == "notDetermined" {
			st = remRequest()
			diag.Push("提醒事项授权请求结果: %s", st) // 仍为 notDetermined = 系统没弹框（如缺 entitlement）
		}
		if st == "denied" || st == "restricted" {
			openPrivacy("Privacy_Reminders")
		}
		a.onMain(func() { a.rem.statusStr = st })
		if st == "granted" {
			a.scheduleReminderSync(0)
		}
	})
}

// remindersSettings：更多功能 → 苹果提醒事项。
func (a *app) remindersSettings(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setRow {
	rows := []setRow{{title: tr("同步任务到提醒事项"), hint: tr("在 iPhone 的「Toskr Native」列表里查看和勾选"), control: func() {
		on := st.RemindersOn
		if toggle(c, s, &on) {
			a.setRemindersEnabled(on)
		}
	}}}
	if !st.RemindersOn {
		return rows
	}
	if a.rem.statusStr == "" && !a.remStatusAsked {
		a.remStatusAsked = true
		calAsync(func() {
			v := remStatus()
			a.onMain(func() { a.rem.statusStr = v })
		})
	}
	if v := a.rem.statusStr; v != "" && v != "granted" {
		return append(rows, setRow{title: tr("未获得提醒事项访问权限"), hint: tr("在「系统设置 → 隐私与安全性 → 提醒事项」里允许 Toskr Native 完整访问"), control: func() {
			if v == "notDetermined" {
				if button(c, s, "授权") {
					a.setRemindersEnabled(true)
				}
			} else if button(c, s, "打开设置") {
				openPrivacy("Privacy_Reminders")
			}
		}})
	}
	hint, failed := tr("任务变化后几秒内推送"), st.RemindersError != ""
	if failed {
		hint = tr("同步失败：") + st.RemindersError
	} else if !st.RemindersSyncAt.IsZero() {
		hint = fmt.Sprintf(tr("上次同步 %s"), st.RemindersSyncAt.Format("01-02 15:04"))
	}
	a.rem.mu.Lock()
	x := a.rem.stats
	a.rem.mu.Unlock()
	tip := ""
	if x.rounds+x.failures > 0 { // 本次启动以来的明细放悬停全文；说明里只在有动静时带一句小结
		tip = fmt.Sprintf(tr("本次启动以来 %d 轮 · 推送：新建 %d 更新 %d 删除 %d · 回来：完成 %d 导入 %d 标题 %d 备注 %d 到期 %d · 冲突 %d 失败 %d"),
			x.rounds, x.created, x.updated, x.deleted, x.completed, x.imported, x.titleBack, x.notesBack, x.dueBack, x.conflicts, x.failures)
		if x.lastErr != "" {
			tip += fmt.Sprintf(tr(" · 最近失败 %s %s"), x.lastErrAt.Format("15:04"), x.lastErr)
		}
		out, back := x.created+x.updated+x.deleted, x.completed+x.imported+x.titleBack+x.notesBack+x.dueBack
		if out+back > 0 {
			hint += fmt.Sprintf(tr(" · 推送 %d · 回来 %d"), out, back)
		}
		if x.conflicts > 0 {
			hint += fmt.Sprintf(tr(" · 冲突 %d"), x.conflicts)
		}
		if x.failures > 0 {
			hint += fmt.Sprintf(tr(" · 失败 %d"), x.failures)
		}
	}
	rows = append(rows, setRow{title: tr("同步"), hint: hint, tip: tip, warn: failed, control: func() {
		label := "立即同步"
		if failed {
			label = "重试"
		}
		if button(c, s, label) {
			a.syncRemindersNow()
		}
	}})
	secName := tr("收集箱")
	for _, sec := range a.store.TaskSections() {
		if sec.ID == st.RemindersSection && sec.ID != store.TaskInbox {
			secName = sec.Name
		}
	}
	rows = append(rows,
		setRow{title: tr("导入到分组"), hint: tr("iPhone 上新建的提醒放进这个分组"), control: func() {
			settingsSelect(c, k, s, secName, func(m *ui.Menu) {
				for _, sec := range a.store.TaskSections() {
					name := sec.Name
					if sec.ID == store.TaskInbox {
						name = tr("收集箱")
					}
					on := sec.ID == st.RemindersSection || (sec.ID == store.TaskInbox && st.RemindersSection == "")
					if m.Item(name).Radio(on).Chosen() {
						cur := a.store.Settings()
						cur.RemindersSection = sec.ID
						if sec.ID == store.TaskInbox {
							cur.RemindersSection = ""
						}
						_ = a.store.SetSettings(cur)
					}
				}
			})
		}},
		setRow{title: tr("在提醒事项里响铃"), hint: tr("到点 iPhone 也响；Mac 上会响两次"), control: func() {
			on := st.RemindersAlarm
			if toggle(c, s, &on) {
				cur := a.store.Settings()
				cur.RemindersAlarm = on
				_ = a.store.SetSettings(cur)
			}
		}},
		setRow{title: tr("同步规则"), hint: tr("两边都改以 Toskr 为准，可在提示里撤销"), control: func() {
			label, icon := tr("查看"), "chevron-right"
			if a.remRulesOpen {
				label, icon = tr("收起"), "chevron-down"
			}
			b := ui.Row(c).Height(24).Padding(0, 4, 0, 8).Gap(2).Radius(6).AlignItems(ui.Center).Key("rem-rules").Role(ui.RoleButton).Label(tr("同步规则") + " " + label)
			col := hoverLink(b, k)
			b.Children(func() {
				text(c, label, 11, 16, 500, col).SingleLine()
				licon(c, icon, 12, col)
			})
			if b.Clicked() {
				a.remRulesOpen = !a.remRulesOpen
			}
		}, below: a.remRulesBelow(c, k)},
	)
	return rows
}

// remRulesBelow：「同步规则」展开后的分类条目（左侧类别小标 + 一句话）；收起时返回 nil。
func (a *app) remRulesBelow(c *ui.Context, k tokens) func() {
	if !a.remRulesOpen {
		return nil
	}
	return func() {
		for _, r := range [][2]string{
			{"完成", "在 iPhone 勾完成，Toskr 跟着完成"},
			{"新建", "在「Toskr Native」列表里新建的提醒导入为任务"},
			{"修改", "只在提醒事项里改的标题、备注、到期会同步回来；优先级以 Toskr 为准"},
			{"冲突", "两边都改以 Toskr 为准；提示里点「撤销」改用提醒事项版本"},
			{"删除", "在提醒事项里删掉的任务不再同步，Toskr 里的任务保留"},
			{"不推送", "闪念、开启前已完成的任务；重复规则（完成后由 Toskr 生成下一期）"},
		} {
			ui.Row(c).Gap(8).Key("rem-rule-" + r[0]).Children(func() {
				ui.Box(c).Width(44).Height(18).Radius(4).Background(k.track).Center().Children(func() {
					text(c, tr(r[0]), 10, 14, 500, k.muted).SingleLine()
				})
				text(c, tr(r[1]), 11, 18, 400, k.fg.Alpha(0.8)).Wrap().Grow(1).Basis(0)
			})
		}
	}
}

func init() { // 设置 → 苹果提醒事项
	for k, v := range map[string]string{
		"同步任务到提醒事项": "Sync tasks to Reminders", "在 iPhone 的「Toskr Native」列表里查看和勾选": "View and check them off in the “Toskr Native” list on iPhone",
		"未获得提醒事项访问权限": "No access to Reminders", "在「系统设置 → 隐私与安全性 → 提醒事项」里允许 Toskr Native 完整访问": "Allow Toskr Native full access in System Settings → Privacy & Security → Reminders",
		"打开设置": "Open Settings", "同步": "Sync", "立即同步": "Sync now", "重试": "Retry", "同步失败：": "Sync failed: ", "提醒事项同步失败：": "Reminders sync failed: ",
		"任务变化后几秒内推送": "Changes are pushed within seconds", "上次同步 %s": "Last synced %s",
		" · 推送 %d · 回来 %d": " · %d pushed · %d pulled", " · 冲突 %d": " · %d conflicts", " · 失败 %d": " · %d failed", " · 最近失败 %s %s": " · last failure %s %s",
		"本次启动以来 %d 轮 · 推送：新建 %d 更新 %d 删除 %d · 回来：完成 %d 导入 %d 标题 %d 备注 %d 到期 %d · 冲突 %d 失败 %d": "Since launch: %d rounds · pushed: %d new, %d updated, %d deleted · pulled: %d completed, %d imported, %d titles, %d notes, %d due dates · %d conflicts, %d failed",
		"导入到分组": "Import into", "iPhone 上新建的提醒放进这个分组": "Reminders created on iPhone go into this group", "收集箱": "Inbox",
		"在提醒事项里响铃": "Alert in Reminders", "到点 iPhone 也响；Mac 上会响两次": "iPhone alerts too; the Mac alerts twice",
		"同步规则": "Sync rules", "两边都改以 Toskr 为准，可在提示里撤销": "If both sides change, Toskr wins; undo from the notice", "查看": "View", "收起": "Hide",
		"完成": "Done", "新建": "New", "修改": "Edits", "冲突": "Conflict", "删除": "Deleted", "不推送": "Not pushed",
		"在 iPhone 勾完成，Toskr 跟着完成":              "Checking it off on iPhone completes it in Toskr",
		"在「Toskr Native」列表里新建的提醒导入为任务":         "Reminders created in the “Toskr Native” list become tasks",
		"只在提醒事项里改的标题、备注、到期会同步回来；优先级以 Toskr 为准": "Title, notes and due date changed only in Reminders sync back; priority follows Toskr",
		"两边都改以 Toskr 为准；提示里点「撤销」改用提醒事项版本":      "If both sides change, Toskr wins; click Undo in the notice to keep the Reminders version",
		"在提醒事项里删掉的任务不再同步，Toskr 里的任务保留":         "Tasks deleted in Reminders stop syncing; the Toskr task is kept",
		"闪念、开启前已完成的任务；重复规则（完成后由 Toskr 生成下一期）":  "Sparks and tasks completed before sync was on; repeat rules (Toskr creates the next one on completion)",
		"已复制 %d 字": "Copied %d characters",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
