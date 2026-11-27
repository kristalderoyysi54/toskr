package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 合上的分组悬停速览（用户 2026-11-18 选定：面板外侧飞出 + 单行 + 停留 0.4 秒，参照 Arc 的文件夹）：
//   - 鼠标停在合上的分组头上 0.4 秒，面板外侧弹出一个带搜索框、可滚动的内容列表，点一条直接发送，不用先展开分组；
//   - 弹过之后 1 秒内移到别的合上的分组立即切换；拖动卡片 / 分组期间不弹（那时悬停分组头的含义是「放进去」）；
//   - 弹框不抢焦点，鼠标进了弹框才取焦点（直接打字就是搜索）；离开分组头和弹框约 0.3 秒收起。
// 只在合上的分组上启用：展开的分组、收件箱抽屉条都不弹。

const (
	gpDelay   = 400 * time.Millisecond
	gpLeave   = 300 * time.Millisecond
	gpTick    = 150 * time.Millisecond
	gpW       = 260
	gpPad     = 8 // 外圈留给投影
	gpSearchH = 32
	gpRowH    = 26
	gpFootH   = 22
	gpMaxRows = 10
	gpExit    = 140 * time.Millisecond // 离场动画时长，播完才藏窗
)

type groupPeek struct {
	sec                      string    // 弹框属于哪个分组；空 = 没开
	arm                      string    // 正在计时的分组头
	armAt                    time.Time // 计时起点
	rect                     ui.Rect   // 分组头在面板里的位置
	query                    string
	cursor                   int
	gen                      int
	away                     time.Duration
	win                      *mygo.Window
	focused                  bool      // 弹框取过焦点
	menuAt                   time.Time // 行的右键菜单最近一次构建的时刻：菜单开着 / 刚选完时不收（选择下一帧才送达）
	keyMove                  bool      // 刚用 ↑↓ 移过选中项：滚进可视区
	ptrAt                    time.Time // 指针位置的记录时刻；prevX / prevY 是更早一帧的位置（滚动把分组头送到静止指针下不算悬停）
	prevX, prevY, curX, curY float32
	blurred                  bool           // 弹框开着期间面板失过焦（收起裁决推迟到弹框关掉）
	viewSec                  string         // 弹框画的是哪个分组：收起后离场动画期间 sec 已清空，内容仍要画完
	leaving                  bool           // 离场动画中（窗口还在，gpExit 后藏）
	enterArm                 bool           // 本次弹出从 0 起播进场
	frame                    mygo.Rectangle // 卡片（含投影留白）应占的屏幕位置；窗口本身是贴着面板的整条
	placeJump                bool           // 下一帧卡片位置直接到位，不过渡
	mouseOn                  bool           // 窗口当前接收鼠标（光标在卡片范围内）；其余时候整条窗鼠标穿透
}

// groupPeekHover 在合上的分组头渲染时调用，返回分组头是否画选中浅底（悬停着，或弹框属于它）。
// busy：正在拖动 / 改名 / 菜单开着，此时不弹。
func (a *app) groupPeekHover(c *ui.Context, head ui.Element, g noteGroup, busy bool) bool {
	p, id := &a.gp, g.sec.ID
	now := c.Now()
	px, py, _ := c.Root().PointerPosition()
	if !now.Equal(p.ptrAt) {
		p.prevX, p.prevY, p.curX, p.curY, p.ptrAt = p.curX, p.curY, px, py, now
	}
	if p.sec == id {
		p.rect = head.Bounds()
		return true
	}
	if busy || len(g.open) == 0 || !head.Hovered() || head.Pressed() {
		if p.arm == id {
			p.arm = ""
		}
		return false
	}
	if p.arm != id {
		if px == p.prevX && py == p.prevY {
			return false // 指针没动：是列表滚动 / 面板弹出把分组头送到了指针下
		}
		p.arm, p.armAt = id, now
		a.gpEnsureWin()
		if a.panel != nil { // 指针停着不动也要再出一帧，计时才能走到
			time.AfterFunc(gpDelay+20*time.Millisecond, func() { a.panel.Update(a.panel.Invalidate) })
		}
	}
	// 弹框已经开着（属于别的分组）：移到另一个合上的分组头立即换过去，不再等（用户 2026-11-25 改，此前是每次等满）；
	// 还没弹出时照旧等满 gpDelay，划过分组头不会误弹。
	if now.Sub(p.armAt) >= gpDelay || p.sec != "" && !p.leaving {
		p.arm = ""
		a.openGroupPeek(g, head.Bounds())
	}
	return true
}

// gpNotes：弹框里列的卡（该组未完成的，按搜索词过滤；只搜这一组）。
func (a *app) gpNotes() (store.Section, []store.Note) {
	for _, g := range a.noteGroups {
		if g.sec.ID != a.gp.viewSec {
			continue
		}
		q := strings.ToLower(strings.TrimSpace(a.gp.query))
		if q == "" {
			return g.sec, g.open
		}
		var out []store.Note
		for _, n := range g.open {
			if strings.Contains(strings.ToLower(n.Title+"\n"+n.Text+"\n"+n.SourceApp), q) {
				out = append(out, n)
			}
		}
		return g.sec, out
	}
	return store.Section{}, nil
}

func gpTitle(n store.Note) string {
	if n.Blur {
		return cmpOr(n.Title, cardTitle(n))
	}
	return cmpOr(n.Title, cmpOr(firstLine(n.Text), cardTitle(n)))
}

func gpHeight(rows int) int {
	return gpSearchH + min(max(rows, 1), gpMaxRows)*gpRowH + 8 + gpFootH + 2*gpPad
}

// gpFrame：弹框位置——贴面板左缘、顶边对齐分组头；左边放不下（面板贴着屏幕左边）改到右侧；上下收进工作区。
func gpFrame(pb, wa mygo.Rectangle, headY float32, h int) mygo.Rectangle {
	const w = gpW + 2*gpPad
	x := pb.X - w + gpPad - 4
	if x+gpPad < wa.X {
		x = pb.X + pb.Width - gpPad + 4
	}
	y := pb.Y + int(headY) - gpPad - 4
	y = max(min(y, wa.Y+wa.Height-h), wa.Y)
	return mygo.Rectangle{X: x, Y: y, Width: w, Height: h}
}

func (a *app) openGroupPeek(g noteGroup, rect ui.Rect) {
	p := &a.gp
	p.gen++
	p.sec, p.rect, p.query, p.cursor, p.away = g.sec.ID, rect, "", 0, 0
	p.viewSec, p.leaving = g.sec.ID, false // gen 已自增：挂着的「离场后藏窗」作废；离场中再弹出就从当前进度折返
	diag.Push("分组速览: 打开「%s」%d 条", g.sec.Name, len(g.open))
	if a.panel == nil {
		return
	}
	pb := a.panel.Bounds()
	d, ok := displayNear(mygo.Screen.Displays(), pb.X+pb.Width/2, pb.Y+pb.Height/2)
	if !ok {
		p.sec = ""
		return
	}
	fr := gpFrame(pb, d.WorkArea, rect.Y, gpHeight(len(g.open)))
	a.gpEnsureWin()
	p.focused = false
	p.enterArm = !p.win.IsVisible() // 已显示（含离场中、换分组）不重播进场
	p.frame = fr
	// 窗口是贴着面板的一整条（工作区等高的透明窗），卡片在窗内定位；换分组时窗口不动，只有卡片的上缘与高度过渡（gpPlace）。
	// 不能边动画边改窗口尺寸：macOS 改尺寸时先把上一帧拉伸显示，与窗内新画的卡片叠成内外两层、动作不一（用户 2026-11-19 截图）。
	if wr := (mygo.Rectangle{X: fr.X, Y: d.WorkArea.Y, Width: fr.Width, Height: d.WorkArea.Height}); p.win.Bounds() != wr {
		p.placeJump = true // 面板挪过 / 换了屏：卡片直接到位
		p.win.SetBounds(wr)
	}
	a.gpMouse(mygo.Screen.CursorScreenPoint(), true)
	p.win.Invalidate()
	p.win.ShowInactive()
	a.gpWatch(p.gen)
}

// gpEnsureWin 建弹框窗口（只建一次）。分组头开始计时就调用：建窗在 0.4 秒等待里做完，弹出那一帧不再卡一下。
func (a *app) gpEnsureWin() {
	p := &a.gp
	if p.win != nil || a.panel == nil {
		return
	}
	p.win = mygo.NewWindow(mygo.WindowOptions{
		Title: "Toskr Group Peek", Panel: true, Hidden: true, Frameless: true, Transparent: true,
		Width: gpW + 2*gpPad, Height: gpHeight(1), DisableResize: true, AlwaysOnTop: true,
		Content: ui.View(a.groupPeekView),
	})
	p.win.SetVisibleOnAllWorkspaces(true)
	p.win.OnBlur(func() { // 弹框失焦：稍等再看——焦点回了面板就不动，去了别的应用按面板失焦处理
		time.AfterFunc(120*time.Millisecond, func() {
			a.panel.Update(func() {
				if a.gp.sec != "" && a.gp.focused && !a.gp.win.IsFocused() && !a.panel.IsFocused() {
					a.gp.focused = false
					a.closeGroupPeek("失焦", false)
					a.blurHide() // 用户点去了别的应用：按面板失焦裁决
				}
			})
		})
	})
}

// closeGroupPeek 收起弹框。refocus：焦点在弹框里时还给面板（发送时不还：发送自己会把焦点交给目标应用）。
func (a *app) closeGroupPeek(why string, refocus bool) {
	p := &a.gp
	if p.sec == "" {
		return
	}
	diag.Push("分组速览: 收起（%s）", why)
	p.gen++
	if strings.HasPrefix(a.rowHov.id, gpHoverPrefix) {
		a.releaseRow() // 弹框里悬停出的原图窥视一起收
	}
	was, blurred := p.focused, p.blurred
	p.sec, p.arm, p.focused, p.blurred = "", "", false, false
	if p.win != nil {
		p.leaving = true              // 先播离场（淡出 + 缩小），gpExit 后再藏窗
		a.gpMouse(mygo.Point{}, true) // 离场期间整窗穿透
		p.win.Invalidate()
		gen := p.gen
		time.AfterFunc(gpExit+30*time.Millisecond, func() {
			a.panel.Update(func() {
				if a.gp.gen == gen && a.gp.leaving {
					a.gp.leaving = false
					a.gp.win.Hide()
				}
			})
		})
	}
	if a.panel == nil || !a.panel.IsVisible() {
		return
	}
	switch {
	case !refocus:
	case was:
		a.panel.Focus()
	case blurred && !a.panel.IsFocused(): // 弹框开着时用户点去了别的应用：补上被推迟的失焦收起
		a.blurHide()
	}
	a.panel.Invalidate()
}

// gpWatch：每 150ms 核对光标是否还在分组头、弹框或两者之间的窄缝里；离开约 0.3 秒收起。
// 面板收起 / 换页 / 分组被展开或清空时立即收。
func (a *app) gpWatch(gen int) {
	time.AfterFunc(gpTick, func() {
		a.panel.Update(func() {
			p := &a.gp
			if p.gen != gen || p.sec == "" {
				return
			}
			sec, _ := a.gpNotes()
			if !a.panel.IsVisible() || a.page != pageNotes || !sec.Collapsed || a.searchOpen {
				a.closeGroupPeek("分组不再合上或面板已变", true)
				return
			}
			cur := mygo.Screen.CursorScreenPoint()
			a.gpMouse(cur, false)
			if wb := p.frame; !p.focused && cur.X >= wb.X+gpPad && cur.X < wb.X+wb.Width-gpPad && cur.Y >= wb.Y+gpPad && cur.Y < wb.Y+wb.Height-gpPad {
				// 光标真的进了弹框才取焦点（直接打字就是搜索）。按屏幕坐标判断：窗内记的指针位置是上次显示时留下的，
				// 靠它判断会在重新弹出 / 已收起后误取焦点——取焦点会把已隐藏的窗重新显示出来，变成一个点不动、关不掉的空弹框
				p.focused = true
				p.win.Focus()
				diag.Push("分组速览: 取焦点")
			}
			if time.Since(p.menuAt) > 600*time.Millisecond && p.arm == "" && !a.gpCursorNear(cur) { // 正在等另一个分组头的计时：先不收，等它弹出直接换
				if p.away += gpTick; p.away >= gpLeave {
					a.closeGroupPeek("光标离开", true)
					return
				}
			} else {
				p.away = 0
			}
			a.gpWatch(gen)
		})
	})
}

// gpMouse：整条透明窗只在光标落进卡片范围（含投影留白）时接鼠标，其余位置穿透给下面的窗口（同 HUD 气泡）。
func (a *app) gpMouse(cur mygo.Point, force bool) {
	p, f := &a.gp, a.gp.frame
	in := !p.leaving && cur.X >= f.X && cur.X < f.X+f.Width && cur.Y >= f.Y && cur.Y < f.Y+f.Height
	if in != p.mouseOn || force {
		p.mouseOn = in
		p.win.SetIgnoreMouseEvents(!in)
	}
}

func (a *app) gpCursorNear(cur mygo.Point) bool {
	pb, wb, r := a.panel.Bounds(), a.gp.frame, a.gp.rect
	in := func(x0, y0, x1, y1 int) bool { return cur.X >= x0 && cur.X < x1 && cur.Y >= y0 && cur.Y < y1 }
	const m = 6
	hx0, hy0 := pb.X+int(r.X), pb.Y+int(r.Y)
	hx1, hy1 := hx0+int(r.W), hy0+int(r.H)
	if in(hx0-m, hy0-m, hx1+m, hy1+m) || in(wb.X, wb.Y, wb.X+wb.Width, wb.Y+wb.Height) {
		return true
	}
	if wb.X < pb.X { // 弹框在左：分组头左端到弹框右缘之间的缝
		return in(wb.X+wb.Width-gpPad, wb.Y, hx0, wb.Y+wb.Height)
	}
	return in(hx1, wb.Y, wb.X+gpPad, wb.Y+wb.Height)
}

func (a *app) gpSend(c *ui.Context, n store.Note) {
	if !a.quickClickOnce(n.ID, c.Now()) { // 同常用区：双击也只发一次
		return
	}
	diag.Push("分组速览: 发送 %s", n.ID)
	a.closeGroupPeek("发送", false)
	a.sendFromList([]store.Note{n})
}

// groupPeekView：搜索框 + 单行列表（图标 · 标题 · 发送次数）+ 键位提示。
func (a *app) groupPeekView(c *ui.Context) {
	k := tok(c)
	p := &a.gp
	c.Root().Background(ui.Transparent) // 窗口默认会铺一层底色：卡片缩放 / 不占满窗口时露出来，成了「外层面板」
	if p.sec == "" && !p.leaving {      // 已收起：隐藏后可能还会出一帧，不画、不处理输入
		return
	}
	sec, items := a.gpNotes()
	p.cursor = min(max(p.cursor, 0), max(len(items)-1, 0))
	shell := ui.Box(c).Absolute().Padding(gpPad).Key("gp-shell")
	a.gpPlace(c, shell)
	pose := a.gpPresence(c, shell)
	shell.Children(func() {
		card := ui.Column(c).Fill().Radius(rr(12)).Clip().Key("gp-card")
		if !floatEdge(card, k) {
			card.Background(k.card).Border(1, k.inputBorder).Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 8, 24, -6, ui.RGBA(0, 0, 0, 0.3)) // token-exception: 浮窗投影
		}
		pose(card)
		card.Children(func() {
			ui.Row(c).Height(gpSearchH).Padding(0, 10).Gap(6).AlignItems(ui.Center).BorderWidth(0, 0, 1, 0).BorderColor(k.inputBorder).Children(func() {
				licon(c, "search", 12, k.muted)
				prev := p.query
				in := ui.TextInputBase(c, &p.query).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(16).TextColor(k.fg).
					Placeholder(fmt.Sprintf(tr("搜索 %s…"), sec.Name))
				if !p.leaving { // 离场中不抢焦点（刚把焦点还给面板）
					in = in.Focus()
				}
				in.OnTextKey(func(key ui.TextKey) bool {
					switch key.Key {
					case ui.KeyEscape:
						a.closeGroupPeek("Esc", true)
					case ui.KeyDown, ui.KeyUp:
						if n := len(items); n > 0 {
							d := 1
							if key.Key == ui.KeyUp {
								d = -1
							}
							p.cursor, p.keyMove = (p.cursor+d+n)%n, true
						}
					case ui.KeyEnter:
						if p.cursor < len(items) {
							a.gpSend(c, items[p.cursor])
						}
					default:
						return false
					}
					return true
				})
				if p.query != prev {
					p.cursor = 0
				}
				text(c, itoa(len(items)), 10, 14, 500, k.muted).Font(fontMono)
			})
			// 换分组时列表交叉淡入：旧列表原地淡出（不占位，压在新列表下），新列表从下方 6pt 淡入，与卡片高度过渡同步
			ui.Scroll(c).Grow(1).Shrink(1).Scrollbars(false).Key("gp-list-" + p.viewSec).Transition(gpListSwap).Children(func() {
				ui.Column(c).Padding(4).Children(func() {
					if len(items) == 0 {
						text(c, fmt.Sprintf(tr("「%s」里没有匹配的内容"), sec.Name), 11, 16, 400, k.muted).Padding(8, 6).SingleLine()
					}
					for i, n := range items {
						title := gpTitle(n)
						row := tipOf(c, ui.Row(c).Height(gpRowH).Padding(0, 6).Gap(7).Radius(rr(7)).AlignItems(ui.Center).Key("gp-"+n.ID).
							Role(ui.RoleButton).Label(tr("发送：")+title), tr("点一下发送"))
						if row.Hovered() {
							p.cursor = i
						}
						if i == p.cursor {
							row.Background(k.track)
							if p.keyMove {
								p.keyMove = false
								row.ScrollIntoView()
							}
						}
						row.Children(func() {
							a.gpLead(c, k, n)
							text(c, title, 11.5, 16, 400, k.fg).SingleLine().Grow(1).Basis(0)
							if n.SendCount > 0 {
								text(c, "×"+itoa(n.SendCount), 9.5, 14, 400, k.muted).Font(fontMono).Shrink(0)
							}
						})
						row.ContextMenu(func(m *ui.Menu) { // 同列表里的卡片菜单：置顶 / 编辑 / 移动分组…，不用先展开
							p.menuAt = time.Now()
							idx := slices.IndexFunc(a.notes, func(x store.Note) bool { return x.ID == n.ID })
							if idx >= 0 {
								a.selected = idx
							}
							a.cardMenu(c, m, max(idx, 0), n)
						})
						a.gpImageHover(c, row, n)
						if row.Clicked() {
							a.gpSend(c, n)
						}
					}
				})
			})
			ui.Row(c).Height(gpFootH).Padding(0, 10).Gap(10).AlignItems(ui.Center).BorderWidth(1, 0, 0, 0).BorderColor(k.inputBorder).Children(func() {
				for _, s := range []string{"↵ 发送", "↑↓ 选择", "Esc 关闭"} {
					text(c, tr(s), 9.5, 14, 400, k.muted)
				}
			})
		})
	})
}

// gpPresence：弹框进出场。进场：淡入 150ms（ease-out）+ 从 0.95 放大到 1（临界阻尼弹簧，约 250ms 无回弹）；
// 离场：淡出 + 缩到 0.96（140ms ease-in），播完才藏窗。缩放原点在贴着面板的那条边、分组头的高度，像从分组头长出 / 收回；
// 减弱动效时只淡入淡出。
// 透明度设在外壳 shell 上；缩放与合成层（Cache）设在卡片同一元素上，返回的函数给卡片套上。
// 两者必须这样分：mygo 的 Opacity 逐层相乘，设在 Cache 元素自己身上会进位图内部，文字照样先淡没。
// 卡片全程 Cache：淡入淡出开头不再临时把整张卡画进位图（那一帧最慢，正落在动画动得最多的起点上，看起来一顿），
// 结束时也没有从位图切回逐层绘制的跳变；进场第 0 帧透明度取 0.002 而不是 0，让位图在看不见时就画好。
func (a *app) gpPresence(c *ui.Context, shell ui.Element) func(card ui.Element) {
	p := &a.gp
	target, sTarget := float32(1), float32(1)
	fade, grow := tw(150, easeMOut), ui.Animation{Spring: ui.SpringOptions{Stiffness: 400, Damping: 40}}
	if p.leaving {
		out := tw(int(gpExit/time.Millisecond), easeMIn)
		target, sTarget, fade, grow = 0, 0.96, out, out
		shell.PassThrough()
	}
	if p.enterArm {
		shell.Jump("presence", 0)
		shell.Jump("scale", 0.95)
		p.enterArm = false
	}
	v := min(max(shell.AnimateTo("presence", target, fade), 0), 1)
	sc := shell.AnimateTo("scale", sTarget, grow)
	if reduceMotion(c) {
		sc = 1
	}
	ox, oy := float32(0.5), float32(0.5)
	if a.panel != nil && p.win != nil {
		pb, wb := a.panel.Bounds(), p.frame
		ox = map[bool]float32{true: 1, false: 0}[wb.X < pb.X] // 弹框在面板左侧：原点在右缘
		if h := wb.Height - 2*gpPad; h > 0 {
			oy = min(max((float32(pb.Y-wb.Y-gpPad)+p.rect.Y+p.rect.H/2)/float32(h), 0.05), 0.95)
		}
	}
	if !p.leaving {
		v = max(v, 0.002) // 透明度 ≤ 0.001 时不画：进场首帧也要把位图画出来
	}
	shell.Opacity(v)
	return func(card ui.Element) {
		card.Scale(sc, sc).TransformOrigin(ox, oy).Cache()
	}
}

// gpPlace：卡片在窗内的位置。换分组时上缘与高度从旧分组的位置过渡到新的（200ms ease-standard，中途再换从当前值折返）；
// 窗口是不动的整条（openGroupPeek）。无窗口（视图测试）时铺满。
func (a *app) gpPlace(c *ui.Context, shell ui.Element) {
	p := &a.gp
	if p.win == nil {
		shell.Top(0).Bottom(0).Left(0).Right(0)
		return
	}
	f, wb := p.frame, p.win.Bounds()
	if p.enterArm || p.placeJump || reduceMotion(c) {
		shell.Jump("y", float32(f.Y))
		shell.Jump("h", float32(f.Height))
		p.placeJump = false
	}
	anim := tw(200, easeStandard)
	y, h := shell.AnimateTo("y", float32(f.Y), anim), shell.AnimateTo("h", float32(f.Height), anim)
	shell.Left(float32(f.X - wb.X)).Width(float32(f.Width)).Top(y - float32(wb.Y)).Height(h)
}

var gpListSwap = ui.ElementTransition{Duration: 200 * time.Millisecond, Ease: easeStandard, Colors: true,
	Enter: &ui.Motion{Y: 6}, Exit: &ui.Motion{}}

const gpHoverPrefix = "gp:"

// gpImageHover：带图的行悬停 360ms 在光标旁弹原图窥视（同列表紧凑行；窥视窗鼠标穿透，离行 / 按下即收）。
func (a *app) gpImageHover(c *ui.Context, row ui.Element, n store.Note) {
	files := n.MediaFiles()
	if len(files) == 0 || n.Blur {
		return
	}
	h, id := &a.rowHov, gpHoverPrefix+n.ID
	if !row.Hovered() || row.Pressed() {
		if h.id == id {
			a.releaseRow()
		}
		return
	}
	px, py, _ := c.Root().PointerPosition()
	if h.id != id {
		if px == h.px && py == h.py {
			return // 指针没动：是列表滚动把行送到了指针下
		}
		a.releaseRow()
		h.id, h.at = id, c.Now()
		a.armPeek(files)
	}
	h.px, h.py, h.rect, h.win = px, py, row.Bounds(), a.gp.win
}

// gpLead：行首 20pt 格——图片卡用小缩略图，其余用类型图标。
func (a *app) gpLead(c *ui.Context, k tokens, n store.Note) {
	ui.Box(c).Size(20, 20).Radius(rr(5)).Clip().Center().Shrink(0).Children(func() {
		if files := n.MediaFiles(); len(files) > 0 && !n.Blur {
			if img := a.thumb(files[0]); img != nil {
				ui.Image(c, img).Fill().Fit(ui.Cover)
				return
			}
		}
		icon := "file-text"
		switch {
		case n.Kind == "link":
			icon = "link-2"
		case isCode(n):
			icon = "braces"
		case n.Kind == "image":
			icon = "image"
		}
		licon(c, icon, 13, k.muted)
	})
}

func init() {
	for k, v := range map[string]string{
		"搜索 %s…": "Search %s…", "「%s」里没有匹配的内容": "Nothing in “%s” matches", "点一下发送": "Click to send",
		"↵ 发送": "↵ Send", "↑↓ 选择": "↑↓ Select", "Esc 关闭": "Esc Close",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
