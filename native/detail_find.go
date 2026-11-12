package main

import (
	"fmt"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 详情窗阅读辅助（原生版新增，Tauri 无）：⌘F 文内查找（琥珀标记同面板搜索，⏎ / ⇧⏎ 前后跳）、
// 有两个以上标题时右缘的大纲（悬停展开为标题列表，点击跳转）、顶部 1.5pt 的阅读进度线。
// 只在阅读态起作用；编辑态由编辑器自己的光标与选区负责。

// mdCtx：一次阅读态渲染里，Markdown 各文字块共享的查找 / 大纲上下文（renderMarkdown 经 mdActive 读取）。
type mdCtx struct {
	query  string
	cur    int // 当前命中序号（0 起）
	n      int // 本帧已数到的命中数
	curR   ui.Rect
	curOK  bool
	heads  []mdHead
	scroll float32 // 本帧滚动量与滚动视口上沿：把窗口坐标换回内容坐标
	top    float32
}

type mdHead struct {
	title string
	level int
	y     float32 // 内容坐标
}

var mdActive *mdCtx

// mdText：Markdown 文字块。查找开着时命中处加琥珀底（当前命中更实），并记下当前命中所在块的位置。
func mdText(c *ui.Context, k tokens, s string, size, lh float32, weight int, mono bool) ui.Element {
	font := fontSans
	if mono {
		font = fontMono
	}
	m := mdActive
	if m == nil || strings.TrimSpace(m.query) == "" {
		return text(c, s, size, lh, weight, k.fg).Font(font)
	}
	segs := splitHighlight(s, m.query)
	if len(segs) == 1 && !segs[0].hit {
		return text(c, s, size, lh, weight, k.fg).Font(font)
	}
	mark, strong := k.amberBar.Alpha(0.35), k.amberBar.Alpha(0.85)
	spans := make([]ui.Span, len(segs))
	hasCur := false
	for i, sg := range segs {
		spans[i] = ui.Span{Text: sg.text, Color: k.fg}
		if sg.hit {
			spans[i].Background, spans[i].Radius = mark, 2
			if m.n == m.cur {
				spans[i].Background, hasCur = strong, true
				if k.dark {
					spans[i].Color = ui.RGB(20, 20, 20)
				}
			}
			m.n++
		}
	}
	el := ui.RichText(c, spans...).Font(font).FontSize(size).FixedLineHeight(lh).FontWeight(weight)
	if hasCur {
		m.curR, m.curOK = el.Bounds(), true
	}
	return el
}

// mdHeading：记下标题在内容里的纵坐标，供大纲跳转。
func mdHeading(el ui.Element, title string, level int) {
	if m := mdActive; m != nil {
		r := el.Bounds()
		m.heads = append(m.heads, mdHead{title: title, level: level, y: r.Y - m.top + m.scroll})
	}
}

// detailFindable：这张卡的阅读态支持查找 / 大纲（图片卡、选词态、编辑态不支持）。
func (a *app) detailFindable(n store.Note) bool {
	return n.Kind != "image" && !a.detail.edit && !a.detail.pick && !a.detail.gallery && a.detail.review == nil
}

func (a *app) openDetailFind() {
	a.detail.findOn, a.detail.findFocus = true, true
}

func (a *app) closeDetailFind() {
	a.detail.findOn, a.detail.findQuery, a.detail.findCur, a.detail.findTotal = false, "", 0, 0
}

// stepDetailFind：跳到下 / 上一个命中（循环）。
func (a *app) stepDetailFind(d int) {
	if t := a.detail.findTotal; t > 0 {
		a.detail.findCur = ((a.detail.findCur+d)%t + t) % t
		a.detail.findJump = true
	}
}

// beginDetailMD / endDetailMD 包住阅读态正文的构建。
func (a *app) beginDetailMD(view ui.Rect) *mdCtx {
	m := &mdCtx{scroll: a.detail.scroll.Y, top: view.Y}
	if a.detail.findOn {
		m.query, m.cur = a.detail.findQuery, a.detail.findCur
	}
	mdActive = m
	return m
}

func (a *app) endDetailMD(c *ui.Context, m *mdCtx, view ui.Rect) {
	mdActive = nil
	a.detail.heads = m.heads
	if !a.detail.findOn {
		return
	}
	if m.n != a.detail.findTotal { // 查询词或内容变了：回到第一个命中
		a.detail.findTotal = m.n
		if a.detail.findCur >= m.n {
			a.detail.findCur = 0
		}
		a.detail.findJump = m.n > 0
		c.Invalidate()
		return
	}
	if a.detail.findJump && m.curOK && m.curR.H > 0 { // 把当前命中所在的块滚到视口上三分之一处
		a.detail.findJump = false
		y := m.curR.Y - view.Y + a.detail.scroll.Y
		a.detail.scroll.ScrollTo(0, max(0, y-view.H/3), springSnappy)
	}
}

// detailFindBar：右上角查找栏。
func (a *app) detailFindBar(c *ui.Context, k tokens) {
	if !a.detail.findOn {
		return
	}
	d := &a.detail
	bar := floatSurface(ui.Row(c).Absolute().Top(44).Right(14).Width(248).Height(30).Padding(0, 4, 0, 8).Gap(4).Radius(9).AlignItems(ui.Center), k).
		Key("detail-find").Label(tr("文内查找"))
	bar.Children(func() {
		licon(c, "search", 13, k.muted)
		prev := d.findQuery
		in := ui.TextInputBase(c, &d.findQuery).Grow(1).Basis(0).Font(fontSans).FontSize(12).FixedLineHeight(17).TextColor(k.fg).
			PlaceholderColor(k.muted).Placeholder(tr("在这张卡里查找")).Label(tr("查找内容")).OnTextKey(func(key ui.TextKey) bool {
			switch {
			case key.Key == ui.KeyEscape:
				a.closeDetailFind()
			case key.Key == ui.KeyEnter && key.Mods&ui.Shift != 0:
				a.stepDetailFind(-1)
			case key.Key == ui.KeyEnter:
				a.stepDetailFind(1)
			case key.Key == ui.KeyG && key.Mods&ui.Cmd != 0:
				a.stepDetailFind(map[bool]int{false: 1, true: -1}[key.Mods&ui.Shift != 0])
			default:
				return false
			}
			return true
		})
		if d.findFocus {
			in.Focus()
			d.findFocus = false
		}
		if d.findQuery != prev {
			d.findCur, d.findJump = 0, true
		}
		count := ""
		switch {
		case strings.TrimSpace(d.findQuery) == "":
		case d.findTotal == 0:
			count = tr("无结果")
		default:
			count = fmt.Sprintf("%d / %d", d.findCur+1, d.findTotal)
		}
		text(c, count, 10, 14, 400, k.muted).SingleLine().Shrink(0)
		if ghostIconButton(c, k, "find-prev", "chevron-up", tr("上一个（⇧⏎）"), 22, 13, false, true).Clicked() {
			a.stepDetailFind(-1)
		}
		if ghostIconButton(c, k, "find-next", "chevron-down", tr("下一个（⏎）"), 22, 13, false, true).Clicked() {
			a.stepDetailFind(1)
		}
		if ghostIconButton(c, k, "find-close", "x", tr("关闭查找（Esc）"), 22, 13, false, true).Clicked() {
			a.closeDetailFind()
		}
	})
}

// detailOutline：两个以上标题时，右缘一列短横（长度随标题级别）；悬停展开为标题列表，点击滚到该标题。
func (a *app) detailOutline(c *ui.Context, k tokens) {
	heads := a.detail.heads
	if len(heads) < 2 {
		return
	}
	cur := 0 // 当前所在小节：最后一个已滚过视口上沿附近的标题
	for i, h := range heads {
		if h.y <= a.detail.scroll.Y+72 {
			cur = i
		}
	}
	_, vh := c.Size()
	box := ui.Column(c).Absolute().Right(6).Top(84).MaxHeight(vh - 190).Key("detail-outline").Label(tr("大纲"))
	open := box.Hovered()
	if open {
		floatSurface(box.Width(208).Padding(6).Radius(rr(10)), k)
	} else {
		box.Padding(6, 4).Gap(7).AlignItems(ui.End)
	}
	box.Children(func() {
		if !open {
			for i, h := range heads {
				if i >= 24 { // 标题极多时只画前 24 条短横，列表里仍是全量
					break
				}
				col := k.muted.Alpha(0.45)
				if i == cur {
					col = k.fg
				}
				ui.Box(c).Width(float32(max(6, 16-4*(h.level-1)))).Height(2).Radius(1).Background(col).Key("ol-bar-" + itoa(i))
			}
			return
		}
		ui.Scroll(c).Shrink(1).Scrollbars(false).Children(func() {
			ui.Column(c).Children(func() {
				for i, h := range heads {
					row := tipOf(c, ui.Row(c).Height(24).Padding(0, 8, 0, float32(8+10*(min(h.level, 4)-1))).Radius(rr(6)).AlignItems(ui.Center).
						Key("ol-"+itoa(i)).Role(ui.RoleButton).Label(tr("跳到：")+h.title), h.title)
					col, weight := k.muted, 400
					if i == cur {
						col, weight = k.fg, 600
					}
					if row.Hovered() {
						row.Background(k.hoverBg)
						col = k.fg
					}
					row.Children(func() { text(c, h.title, 11, 16, weight, col).SingleLine().Grow(1).Basis(0) })
					if row.Clicked() {
						a.detail.scroll.ScrollTo(0, max(0, h.y-64), springSnappy)
					}
				}
			})
		})
	})
}

// detailProgress：顶部阅读进度线（内容不超过一屏时不画）。
func (a *app) detailProgress(c *ui.Context, k tokens) {
	s := a.detail.scroll
	if s.MaxY <= 8 {
		return
	}
	w, _ := c.Size()
	ui.Box(c).Absolute().Top(0).Left(0).Width(w * min(1, max(0, s.Y/s.MaxY))).Height(1.5).Background(k.fg.Alpha(0.4)).PassThrough().
		Key("detail-progress").Label(tr("阅读进度"))
}
