package main

import (
	"bytes"
	_ "embed"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"slices"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// HUD 按 Tauri HudView 复刻（窗口 264×100，透明、置顶、默认点击穿透）：
// 可操作的提示（可撤销 / 粘性）是「纸白说话气泡 + 尾巴指向右下角 logo」，其余是右对齐的小药丸。
// 光标进入气泡时关闭穿透：关闭钮可点，可撤销的提示显出「撤销」。

const hudW, hudH = 264, 100

//go:embed resources/hud-logo.png
var hudLogoPNG []byte

var (
	hudLogoOnce          sync.Once
	hudLogo, hudLogoMask ui.ImageSource // 原图与纯黑剪影（剪影模糊后作「跟随透明轮廓」的投影）
)

func loadHUDLogo() {
	hudLogo, _ = ui.DecodeImage(hudLogoPNG)
	src, err := png.Decode(bytes.NewReader(hudLogoPNG))
	if err != nil {
		return
	}
	b := src.Bounds()
	mask := image.NewNRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			_, _, _, al := src.At(x, y).RGBA()
			mask.SetNRGBA(x, y, color.NRGBA{A: uint8(al >> 8)})
		}
	}
	var buf bytes.Buffer
	if png.Encode(&buf, mask) == nil {
		hudLogoMask, _ = ui.DecodeImage(buf.Bytes())
	}
}

// hudIcons：Tauri HudIcon 每类的圆底色（/0.9）与图标。
var hudIcons = map[string]struct {
	icon  string
	color ui.Color
}{
	"added":     {"check", oklch(0.696, 0.17, 162.48, 0.9)},
	"ok":        {"check", oklch(0.696, 0.17, 162.48, 0.9)},
	"duplicate": {"copy-check", oklch(0.769, 0.188, 70.08, 0.9)},
	"warn":      {"triangle-alert", oklch(0.705, 0.213, 47.604, 0.9)},
	"undone":    {"undo-2", oklch(0.552, 0.016, 285.938, 0.9)},
	"info":      {"info", oklch(0.552, 0.016, 285.938, 0.9)},
	"sent":      {"send", oklch(0.685, 0.169, 237.323, 0.9)},
	"due":       {"alarm-clock", oklch(0.577, 0.245, 27.325, 0.9)},
}

func hudTitle(kind, text string, count int) string {
	switch kind {
	case "added":
		if count > 1 {
			return tr("已捕获 ×") + itoa(count)
		}
		return tr("已捕获")
	case "duplicate":
		return tr("已存在相同内容")
	}
	if text != "" {
		return text
	}
	return map[string]string{"warn": tr("注意"), "undone": tr("已撤销"), "sent": tr("已发送"), "ok": tr("完成"), "info": tr("提示"), "due": tr("任务到期")}[kind]
}

// showHUD 弹出提示气泡；kind: added / duplicate / sent / warn / ok / info / undone。
// added / duplicate 的 text 是内容预览（副行），其余 kind 的 text 即标题。
// 隐身模式下只显示 warn（发送失败等必须知道的事）。主线程调用。
func (a *app) showHUD(kind, text string) { a.showHUDUndo(kind, text, nil) }

// showHUDUndo 同 showHUD，undo 非空时为可撤销气泡（悬停出「撤销」）。
func (a *app) showHUDUndo(kind, text string, undo func()) {
	if kind != "warn" && a.store.Settings().Stealth {
		diag.Push("隐身: 静默气泡 kind=%s", kind)
		a.hudUndo = undo // 同 Tauri：隐身只压气泡，⌘Z 仍可撤销
		return
	}
	a.showHUDForce(kind, text)
	a.hudUndo = undo
}

func (a *app) showHUDForce(kind, text string) {
	// 连发：上一条仍在场时作「被顶替」的残影下沉淡出；窗口原本收着时 logo 一并重新入场
	onScreen := a.hud != nil && a.hud.IsVisible() && !a.hudLeaving
	if kind == "added" && onScreen && a.hudKind == "added" { // 连续捕获 ×N（同 Tauri hud.streak）
		a.hudStreak++
	} else {
		a.hudStreak = 1
	}
	if onScreen && a.hudKind != "" {
		a.hudGhost, a.hudGhostAt = &hudBubble{kind: a.hudKind, text: a.hudText, actionable: a.hudActionable(), undo: a.hudUndo != nil, due: a.hudDue, count: a.hudStreakOf(a.hudKind)}, time.Time{}
	} else {
		a.hudGhost, a.hudLogoAt = nil, time.Time{}
	}
	a.hudAt, a.hudLeaving = time.Time{}, false
	a.hudKind, a.hudText, a.hudUndo, a.hudHover, a.hudTarget, a.hudDue = kind, text, nil, false, "", nil
	a.hudGen++
	gen := a.hudGen
	if a.hud == nil {
		return // 无窗口（视图测试）
	}
	d := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint())
	a.hud.SetSize(hudW, hudH) // 到期气泡会再加高一行（showDueHUD）
	a.hud.SetPosition(d.WorkArea.X+d.WorkArea.Width-hudW-8, d.WorkArea.Y+8)
	a.hud.SetIgnoreMouseEvents(true)
	a.hud.Invalidate()
	a.hud.ShowInactive()
	hold := a.store.Settings().HUDDuration() // 提示显示时长（Tauri hudDurationMs，默认 3 秒）
	if kind == "warn" {
		hold = max(hold, 4*time.Second)
	}
	sticky := kind == "due" // 同 Tauri：到期气泡 sticky，只能手动点掉
	if sticky {
		hold = 100 * 365 * 24 * time.Hour
	}
	go a.watchHUDHover(gen, time.Now().Add(hold), sticky)
}

// hudActionable：说话气泡形态（可撤销 / 到期 / 可定位到卡，同 Tauri hudActionable 看 targetId）。
func (a *app) hudActionable() bool {
	return a.hudUndo != nil || len(a.hudDue) > 0 || a.hudTarget != "" || a.upd.pendingOpen && a.hudKind == "info"
}

func (a *app) hudStreakOf(kind string) int {
	if kind == "added" {
		return max(a.hudStreak, 1)
	}
	return 1
}

// watchHUDHover 轮询光标：在气泡上时关闭穿透并暂停计时，离开后重新计时，到时收起。
func (a *app) watchHUDHover(gen int, deadline time.Time, sticky bool) {
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for range t.C {
		p := mygo.Screen.CursorScreenPoint()
		done := false
		a.hud.Update(func() {
			if a.hudGen != gen {
				done = true
				return
			}
			b := a.hud.Bounds()
			in := p.X >= b.X && p.X < b.X+b.Width && p.Y >= b.Y && p.Y < b.Y+a.hudBubbleH() // 气泡区（不含下方 logo）
			if in != a.hudHover {
				a.hudHover = in
				a.hud.SetIgnoreMouseEvents(!in)
				a.hud.Invalidate()
			}
			if in && !sticky {
				deadline = time.Now().Add(1200 * time.Millisecond)
			} else if time.Now().After(deadline) {
				a.dismissHUD()
				done = true
			}
		})
		if done {
			return
		}
	}
}

// dismissHUD 收起气泡：先播离场（opacity → 0、scale → 0.96，120ms ease-standard），160ms 后藏窗（同 Tauri window.rs 的 emit exit → sleep 160ms → hide）。
func (a *app) dismissHUD() {
	a.hudGen++
	gen := a.hudGen
	if a.hud == nil {
		return
	}
	a.hudLeaving, a.hudLeaveAt, a.hudGhost = true, time.Time{}, nil
	a.hud.Invalidate()
	go func() {
		time.Sleep(160 * time.Millisecond)
		a.hud.Update(func() {
			if a.hudGen == gen && a.hudLeaving {
				a.hud.Hide()
				a.hudLeaving = false
			}
		})
	}()
}

// hudBubble 是一条气泡的内容（当前条或被顶替的残影）。
type hudBubble struct {
	kind, text string
	actionable bool
	undo       bool     // 有可撤销操作（悬停出「撤销」）
	count      int      // 连续捕获计数
	due        []string // 任务到期气泡的任务（>1 为批量）：气泡里直接完成或稍后
}

// hudProgress 返回从 *at 起经过 d 的进度（0…1），*at 为零时记为本帧；动画中持续要帧。无窗口（视图测试）时恒为 1。
func (a *app) hudProgress(c *ui.Context, at *time.Time, d time.Duration) float32 {
	if a.hud == nil {
		return 1
	}
	now := c.Now()
	if at.IsZero() {
		*at = now
	}
	t := float32(now.Sub(*at)) / float32(d)
	if t < 1 {
		c.AnimationFrame()
	}
	return min(max(t, 0), 1)
}

// hudGhostPose：被顶替气泡的关键帧（1140ms，times 0 / .14 / .75 / 1，ease easeOut / linear / easeIn）。
func hudGhostPose(t float32) (y, scale, op float32) {
	switch {
	case t < 0.14:
		u := easeMOut(t / 0.14)
		return 8 * u, 1 - 0.05*u, 1 - 0.15*u
	case t < 0.75:
		return 8, 0.95, 0.85
	}
	u := easeMIn((t - 0.75) / 0.25)
	return 8 + 2*u, 0.95 - 0.02*u, 0.85 * (1 - u)
}

func (a *app) hudView(c *ui.Context) {
	registerFonts()
	c.Root().Background(ui.Transparent)
	reduce := c.Preferences().ReduceMotion
	cur := hudBubble{kind: a.hudKind, text: a.hudText, actionable: a.hudActionable(), undo: a.hudUndo != nil, due: a.hudDue, count: a.hudStreakOf(a.hudKind)}
	// 进场：opacity 0 → 1、y 10 → 0、scale 0.982 → 1（160ms ease-standard）；离场叠乘 opacity → 0、scale → 0.96
	e := easeStandard(a.hudProgress(c, &a.hudAt, 160*time.Millisecond))
	op, dy, sc := e, 10*(1-e), 0.982+0.018*e
	lop := easeStandard(a.hudProgress(c, &a.hudLogoAt, 160*time.Millisecond)) // logo 独立进场：opacity + y 4 → 0
	ldy := 4 * (1 - lop)
	if a.hudLeaving {
		l := easeStandard(a.hudProgress(c, &a.hudLeaveAt, 120*time.Millisecond))
		op, sc, lop = op*(1-l), sc*(1-0.04*l), lop*(1-l)
	}
	var ghost *hudBubble
	var gy, gs, gop, gt float32
	if a.hudGhost != nil {
		gt = a.hudProgress(c, &a.hudGhostAt, 1140*time.Millisecond)
		if gt >= 1 {
			a.hudGhost = nil
		} else {
			ghost = a.hudGhost
			gy, gs, gop = hudGhostPose(gt)
		}
	}
	if reduce { // 减弱动效：只淡入淡出，不位移不缩放（MotionConfig reducedMotion="user"）
		dy, sc, ldy, gy, gs = 0, 1, 0, 0, 1
	}
	ui.Column(c).Fill().Padding(8, 12, 0, 12).AlignItems(ui.End).Children(func() {
		ui.Box(c).FillWidth().Children(func() {
			if ghost != nil {
				ui.Column(c).Absolute().Top(0).Left(0).Right(0).PassThrough().Opacity(gop).Translate(0, gy).Scale(gs, gs).
					Children(func() { a.hudBubbleView(c, *ghost, gt*1140) })
			}
			ui.Column(c).FillWidth().Opacity(op).Translate(0, dy).Scale(sc, sc).Children(func() { a.hudBubbleView(c, cur, -1) })
		})
		if !cur.actionable {
			return
		}
		hudLogoOnce.Do(loadHUDLogo)
		if hudLogo != nil {
			dy, sigma, alpha := float32(2), float32(5), float32(0.28)
			if c.Theme().Dark {
				dy, sigma, alpha = 3, 7, 0.55
			}
			ui.Box(c).Size(36, 36).Margin(-6, 2, 0, 0).Opacity(lop).Translate(0, ldy).Children(func() {
				if hudLogoMask != nil {
					ui.Image(c, hudLogoMask).Absolute().Top(dy).Left(0).Size(36, 36).Blur(sigma).Opacity(alpha)
				}
				ui.Image(c, hudLogo).Absolute().Top(0).Left(0).Size(36, 36)
			})
		}
	})
}

// hudBubbleView 画一条气泡；ghostMs ≥ 0 时是被顶替的残影（纸色 160ms 换暗一档、尾巴 80ms 淡出，不响应指针）。
func (a *app) hudBubbleView(c *ui.Context, b hudBubble, ghostMs float32) {
	paper, ink, ghostPaper := oklch(0.965, 0.012, 90, 1), oklch(0.24, 0.01, 90, 1), oklch(0.885, 0.014, 90, 1)
	if c.Theme().Dark {
		paper, ink, ghostPaper = oklch(0.9, 0.014, 90, 1), gray(0.205, 1), oklch(0.8, 0.014, 90, 1)
	}
	ghost := ghostMs >= 0
	tailOp := float32(1)
	if ghost {
		paper = mixColor(paper, ghostPaper, easeStandard(min(ghostMs/160, 1)))
		tailOp = 1 - easeMInOut(min(ghostMs/80, 1))
	}
	ic := hudIcons[b.kind]
	if ic.icon == "" {
		ic = hudIcons["info"]
	}
	icon := func() {
		ui.Box(c).Size(20, 20).Radius(10).Background(ic.color).Center().Children(func() { licon(c, ic.icon, 12, ui.RGB(255, 255, 255)) })
	}
	title := hudTitle(b.kind, b.text, b.count)
	if !b.actionable {
		ui.Row(c).FillWidth().Justify(ui.End).Children(func() {
			pill := ui.Row(c).Padding(4, 12, 4, 6).Gap(6).Radius(16).Background(paper).AlignItems(ui.Center).
				Shadow(0, 6, 16, -4, gray(0, 0.12)).Shadow(0, 1, 2, 0, gray(0, 0.08))
			pill.Children(func() {
				icon()
				text(c, title, 12, 15, 500, ink).Wrap().MaxLines(3)
			})
			if !ghost && pill.Clicked() {
				a.dismissHUD()
			}
		})
		return
	}
	// 多层投影 + 0.5px 描边影（Tauri 的 drop-shadow 组，深色加重）
	s1, s2, s3 := ui.RGBA(20, 20, 24, 0.10), ui.RGBA(20, 20, 24, 0.16), ui.RGBA(20, 20, 24, 0.30)
	if c.Theme().Dark {
		s1, s2, s3 = gray(0, 0.35), gray(0, 0.45), gray(0, 0.60)
	}
	balloon := ui.Row(c).FillWidth().Padding(6, 6, 6, 10).Gap(8).Radius(18).Background(paper).AlignItems(ui.Center).
		Shadow(0, 0, 1, 0, s3).Shadow(0, 1, 2, 0, s1) // CSS drop-shadow 的模糊值是标准差，换成 box-shadow 语义要 ×2
	if c.Theme().Dark {
		balloon.Shadow(0, 5, 28, 0, s2)
	} else {
		balloon.Shadow(0, 4, 20, 0, s2)
	}
	hover := a.hudHover && !ghost
	balloon.Children(func() {
		icon()
		body := ui.Column(c).Grow(1).Basis(0).Tooltip(tr("点击查看")).Role(ui.RoleButton).Label(title)
		body.Children(func() {
			tightText(c, title, 12, 15, 500, ink).FillWidth()
			if (b.kind == "added" || b.kind == "duplicate") && b.text != "" {
				tightText(c, b.text, 10, 12.5, 400, ink.Alpha(0.55)).FillWidth()
			}
			if len(b.due) > 0 {
				a.hudDueActions(c, ink, b.due, ghost)
			}
		})
		if !ghost && body.Clicked() {
			a.hudOpen()
		}
		if len(b.due) > 0 { // 到期气泡没有撤销，只留关闭
			x := hudClose(c, ink)
			if !ghost && x.Clicked() {
				a.dismissHUD()
			}
			return
		}
		if !b.undo { // 只可定位（如「已存在相同内容」）：不给撤销钮
			x := hudClose(c, ink)
			if !ghost && x.Clicked() {
				a.dismissHUD()
			}
			return
		}
		undo := ui.Row(c).Height(20).Padding(2, 6).Gap(4).Radius(6).AlignItems(ui.Center)
		if undo.Hovered() {
			undo.Border(1, ink.Alpha(0.45)).Background(ink.Alpha(0.08))
		} else {
			undo.Border(1, ink.Alpha(0.25))
		}
		reveal := float32(0)
		if hover {
			reveal = 1
		}
		undo.Opacity(undo.AnimateTo("reveal", reveal, tweenTw)) // 悬停显出「撤销」：opacity 150ms
		undo.Children(func() {
			licon(c, "undo-2", 10, ink.Alpha(0.75))
			text(c, tr("撤销"), 10, 14, 400, ink.Alpha(0.75))
		})
		if !ghost && undo.Clicked() && a.hudUndo != nil {
			fn := a.hudUndo
			a.showHUDForce("undone", tr("已撤销"))
			fn()
		}
		x := hudClose(c, ink)
		if !ghost && x.Clicked() {
			a.dismissHUD()
		}
	})
	// 尾巴：22×13 固定几何，从气泡右下弯向 logo
	ui.Row(c).FillWidth().Height(12).Margin(-1, 0, 0, 0).Justify(ui.End).Padding(0, 14, 0, 0).Opacity(tailOp).Children(func() {
		ui.Box(c).Size(22, 13).Children(func() {
			ui.Icon(c, hudTail).Absolute().Top(4).Left(0).Size(22, 13).TextColor(s2).Blur(5) // 尾巴随气泡同一组投影
			ui.Icon(c, hudTail).Absolute().Top(0).Left(0).Size(22, 13).TextColor(paper)
		})
	})
}

var hudTail = ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 13"><path fill="currentColor" d="M2 0 H20 C19.6 3.8 20.2 7.6 21.6 10.8 Q22.4 12.6 20.6 12.3 C13.8 11.2 6 7.4 2 0 Z"/></svg>`))

func (a *app) createHUD() {
	a.hud = mygo.NewWindow(mygo.WindowOptions{
		Title: "Toskr HUD", Panel: true, Hidden: true, Frameless: true, Transparent: true,
		Width: hudW, Height: hudH, DisableResize: true, AlwaysOnTop: true,
		Content: ui.View(a.hudView),
	})
	a.hud.SetIgnoreMouseEvents(true)
	a.hud.SetVisibleOnAllWorkspaces(true)
}

func vibrancyFor(glassSetting string) mygo.Vibrancy {
	switch glassSetting {
	case "clear":
		return mygo.VibrancyGlassClear
	case "none":
		return mygo.VibrancyNone
	}
	return mygo.VibrancyGlass
}

// hudBubbleH：气泡区高度（光标在其中时关闭鼠标穿透）；到期气泡多一行操作钮。
func (a *app) hudBubbleH() int {
	if len(a.hudDue) > 0 {
		return 88
	}
	return 60
}

// hudDueActions：任务到期气泡里的「完成 · 10 分钟后 · 1 小时后」（批量时为「全部…」，没有完成）。
func (a *app) hudDueActions(c *ui.Context, ink ui.Color, ids []string, ghost bool) {
	ui.Row(c).Margin(5, 0, 0, 0).Gap(4).Children(func() {
		btn := func(key, label string) bool {
			b := ui.Row(c).Height(20).Padding(0, 7).Radius(6).Border(1, ink.Alpha(0.25)).AlignItems(ui.Center).Key("hd-" + key).Role(ui.RoleButton).Label(label)
			if b.Hovered() {
				b.Background(ink.Alpha(0.06))
			}
			b.Children(func() { text(c, label, 10, 14, 500, ink.Alpha(0.8)) })
			return !ghost && b.Clicked()
		}
		if len(ids) == 1 && btn("done", tr("完成")) {
			a.hudDueAction(ids, "complete", 0)
		}
		for _, o := range []struct {
			min   int
			label string
		}{{10, "10 分钟后"}, {60, "1 小时后"}} {
			label := tr(o.label)
			if len(ids) > 1 {
				label = fmt.Sprintf(tr("全部%s"), label)
			}
			if btn(itoa(o.min), label) {
				a.hudDueAction(ids, "snooze", o.min)
			}
		}
	})
}

// hudDueAction 同 Tauri HUD_DUE_ACTION：只处理仍未完成的任务；完成走 setTaskStatus（重复任务会生成下一期）。
func (a *app) hudDueAction(ids []string, action string, minutes int) {
	a.dismissHUD()
	var live []store.Task
	for _, t := range a.store.Tasks() {
		if t.Status != "done" && slices.Contains(ids, t.ID) {
			live = append(live, t)
		}
	}
	if len(live) == 0 {
		a.showHUD("info", tr("任务已处理或已删除"))
		return
	}
	if action == "complete" {
		for _, t := range live {
			a.setTaskStatus(t, "done")
		}
		if len(live) == 1 {
			a.showHUD("ok", tr("已完成"))
		} else {
			a.showHUD("ok", fmt.Sprintf(tr("已完成 %d 个任务"), len(live)))
		}
		return
	}
	var liveIDs []string
	for _, t := range live {
		liveIDs = append(liveIDs, t.ID)
	}
	at := a.store.SnoozeTasks(liveIDs, minutes, a.now())
	a.showHUD("ok", fmt.Sprintf(tr("已推迟到 %s"), at.Format("15:04")))
}

// hudOpen：点气泡本体查看——到期提醒去提醒页（单条打开该任务），捕获类定位到那张卡，其余唤出面板。
func (a *app) hudOpen() {
	due, target := a.hudDue, a.hudTarget
	update := a.upd.pendingOpen && a.hudKind == "info"
	a.dismissHUD()
	if update {
		a.openUpdate()
		return
	}
	if a.panel != nil {
		a.showPanel()
	}
	switch {
	case len(due) > 0:
		a.switchPage(pageTasks)
		if len(due) == 1 {
			for _, t := range a.store.Tasks() {
				if t.ID == due[0] {
					a.openTaskEdit(t)
				}
			}
		}
	case target != "":
		if n, ok := a.store.Note(target); ok {
			a.focusNote(n)
		}
	}
}

// showDueHUD：任务到期气泡（隐身模式下也显示：这是用户自己设的提醒）。
func (a *app) showDueHUD(text string, ids []string) {
	a.showHUDForce("due", text)
	a.hudDue = ids
	if a.hud != nil {
		a.hud.SetSize(hudW, hudH+28)
	}
}

// hudClose：气泡关闭钮，悬停底色加深、图标转实（同 Tauri HUD close hover）。
func hudClose(c *ui.Context, ink ui.Color) ui.Element {
	x := ui.Box(c).Size(22, 22).Radius(11).Center().Tooltip(tr("关闭"))
	bg, fg := ink.Alpha(0.1), ink.Alpha(0.6)
	if x.Hovered() {
		bg, fg = ink.Alpha(0.18), ink.Alpha(0.9)
	}
	fadeColor(x, "bg", bg, tweenControl)
	x.AnimatePose(ui.Pose{Scale: pressScale(x.Pressed(), 0.94)}, tweenControl)
	x.Children(func() { licon(c, "x", 14, fg) })
	return x
}
