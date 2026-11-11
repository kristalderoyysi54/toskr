package main

import (
	"github.com/egoist/mygo/ui"
)

// Platinum 下的设置窗与控件，按 Tauri 的 platinum 段与 Segmented / Switch / range 的 Platinum 分支复刻：
// 条纹标题栏 → 左栏（白井搜索框 + 白井导航，选中为高亮色反白）→ 右侧（标题 · 文件夹页签 · 斜面内容框 · 组框带标题）
// + 经典滚动条。分段控件：两项为单选钮，三项以上为弹出菜单；开关为复选框；滑杆为凹槽 + 尖头滑块。

// ptHighlight 是 Platinum 高亮颜色四档（与 index.css 的 data-pt-highlight 段一致）：选中 / 菜单高亮 + 滑块与滚动条的三色渐变。
var ptHighlights = map[string][4]ui.Color{
	"lavender": {ui.RGB(51, 51, 153), ui.RGB(238, 238, 255), ui.RGB(204, 204, 255), ui.RGB(153, 153, 204)},
	"blue":     {hex(0x3366cc), hex(0xe6f0ff), hex(0xbbd6ff), hex(0x6f98d6)},
	"teal":     {hex(0x006666), hex(0xe4f6f4), hex(0xb8e6e0), hex(0x66aaa4)},
	"graphite": {hex(0x555555), hex(0xeeeeee), hex(0xcccccc), hex(0x999999)},
}

var ptHighlightNames = []string{"lavender", "blue", "teal", "graphite"}
var ptHighlightLabels = []string{"薰衣草（默认）", "蓝色", "青色", "石墨"}

// ptHL 是当前高亮色（applyAppearance 设置）。
var ptHL = ui.RGB(51, 51, 153)

// ptClassicScroll：Platinum 经典滚动条（false = 细条）。
var ptClassicScroll = true

func setPlatinumDetail(highlight, scrollbar string) {
	h, ok := ptHighlights[highlight]
	if !ok {
		h = ptHighlights["lavender"]
	}
	ptHL, ptLavHi, ptLav, ptLavDeep = h[0], h[1], h[2], h[3]
	ptClassicScroll = scrollbar != "thin"
}

func ptLavGradient(angle float32) ui.LinearGradient {
	return ui.LinearGradient{Stops: []ui.GradientStop{{Color: ptLavHi, At: 0}, {Color: ptLav, At: 0.45}, {Color: ptLavDeep, At: 1}}, Angle: angle}
}

func (a *app) ptSettingsShell(c *ui.Context, k tokens, s settingsTokens, pages []setPage) {
	c.Root().Background(ptG300)
	a.setPage = min(a.setPage, len(pages)-1)
	defer func() { // 窗框：1px 黑环 + 内侧左上白、右下 #999（压在内容之上，不占布局）
		ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Border(1, ptBlack).
			InsetShadow(1, 1, 0, 0, ptWhite).InsetShadow(-1, -1, 0, 0, ptG600).PassThrough()
	}()
	ui.Column(c).Fill().Children(func() {
		ui.Row(c).Height(21).Padding(5, 6, 3, 6).Gap(4).DragWindow().Children(func() {
			if ptWidget(c, "close") && a.settingsWin != nil {
				a.settingsWin.Close()
			}
			ptStripes(c)
			text(c, tr("Toskr 设置"), 12, 13, 700, ptBlack).Padding(0, 3)
			ptStripes(c)
			ptWidget(c, "zoom")
		})
		ui.Row(c).Grow(1).AlignItems(ui.Stretch).Children(func() {
			ui.Column(c).Width(176).Padding(10, 0, 12, 12).Gap(6).Children(func() {
				search := ui.Row(c).Height(32).Padding(0, 8).Gap(6).AlignItems(ui.Center)
				ptWell(search).Children(func() {
					licon(c, "search", 14, ptMuted)
					ui.TextInputBase(c, &a.setQuery).Bind(&a.setSearch).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).
						TextColor(ptBlack).PlaceholderColor(ptMuted).Placeholder(tr("搜索设置"))
				})
				nav := ui.Column(c).Grow(1).Padding(2)
				ptWell(nav).Children(func() {
					for i, p := range pages {
						sel := a.setPage == i && a.setQuery == ""
						b := ui.Row(c).Height(33).Padding(8, 10).Gap(8).AlignItems(ui.Center).Key("nav-" + p.label)
						w, col := 400, ptMuted
						if sel {
							w, col = 500, ptWhite
							b.Background(ptHL)
						}
						b.Children(func() {
							licon(c, p.icon, 16, col)
							text(c, tr(p.label), 12, 17, w, col)
						})
						if b.Clicked() {
							a.setPage, a.setSub, a.setQuery = i, 0, ""
						}
					}
				})
			})
			ui.Row(c).Grow(1).Basis(0).AlignItems(ui.Stretch).Children(func() {
				ui.Scroll(c).Grow(1).Basis(0).Scrollbars(!ptClassicScroll).TrackScroll(&a.setScroll).Children(func() {
					ui.Column(c).Padding(20, 20, 20, 20).Children(func() {
						if a.setQuery != "" {
							a.searchResults(c, k, s, pages)
							return
						}
						p := pages[a.setPage]
						tightText(c, tr(p.label), 15, 20, 600, ptBlack)
						subs := p.subs
						a.setSub = min(a.setSub, max(len(subs)-1, 0))
						if len(subs) > 0 {
							ui.Row(c).Height(22).Margin(12, 0, 0, 0).Padding(0, 0, 0, 8).AlignItems(ui.End).Children(func() {
								for i, sub := range subs {
									if ptFolderTab(c, sub, a.setSub == i, i > 0) {
										a.setSub = i
									}
								}
							})
						} else {
							ui.Box(c).Height(12)
						}
						secs := p.sections[min(a.setSub, len(p.sections)-1)]
						box := ui.Column(c).Margin(-1, 0, 0, 0).Padding(28, 14, 2, 14).Gap(24).Background(ptG300).Border(1, ptBlack)
						ptBevel(box, ptG600).Children(func() {
							for _, sec := range secs {
								ptSection(c, k, s, sec)
							}
							ui.Box(c).Height(12)
						})
					})
				})
				if ptClassicScroll {
					ptScrollbar(c, &a.setScroll)
				}
			})
		})
	})
}

// ptFolderTab：文件夹页签（选中 22 高、#ddd、底边并入下方内容框；其余 19 高、#ccc）。
func ptFolderTab(c *ui.Context, label string, on, overlap bool) bool {
	t := ui.Row(c).Padding(0, 11).Radius(5, 5, 0, 0).AlignItems(ui.Center).Key("pt-sub-" + label)
	if overlap {
		t.Margin(0, 0, 0, -1)
	}
	if on {
		t.Height(22).Padding(3, 11, 0, 11).AlignItems(ui.Start).Background(ptG300).BorderWidth(1, 1, 0, 1).BorderColor(ptBlack).
			InsetShadow(1, 1, 0, 0, ptWhite).InsetShadow(-1, 0, 0, 0, ptG600)
	} else {
		t.Height(19).Padding(1, 11, 0, 11).AlignItems(ui.Start).Background(ptG400).Border(1, ptBlack).InsetShadow(1, 1, 0, 0, ptG200)
	}
	t.Children(func() { text(c, tr(label), 12, 16, 600, ptBlack).SingleLine() })
	return t.Clicked() && !on
}

// ptSection：组框（#999 细框 + 白色内外高光），标题像 fieldset legend 压在上边框上。
func ptSection(c *ui.Context, k tokens, s settingsTokens, sec setSection) {
	title := sec.title
	if sec.intro != "" {
		text(c, sec.intro, 12, 17, 400, ptMuted).Wrap()
	}
	if sec.body != nil { // 自定义内容（主从布局）：标题照常，内容不套组框
		if title != "" {
			tightText(c, title, 13, 18, 700, ptBlack)
		}
		sec.body()
		return
	}
	visible := sec.rows[:0:0]
	for _, r := range sec.rows {
		if !r.hidden {
			visible = append(visible, r)
		}
	}
	if len(visible) == 0 {
		return
	}
	ui.Box(c).Key("ptsec-" + title + sec.key).Children(func() {
		ui.Column(c).Padding(6, 0, 0, 0).Border(1, ptG600).InsetShadow(1, 1, 0, 0, ptWhite).Shadow(1, 1, 0, 0, ptWhite).Children(func() {
			for i, r := range visible {
				row := ui.Column(c).Padding(10, 14)
				if i < len(visible)-1 {
					row.BorderWidth(0, 0, 1, 0).BorderColor(ui.Transparent)
				}
				row.Children(func() {
					ui.Row(c).Gap(16).AlignItems(ui.Center).Children(func() {
						if r.icon != "" {
							licon(c, r.icon, 16, ptBlack).Margin(0, -4, 0, 0)
						}
						ui.Column(c).Grow(1).Basis(0).Gap(2).Children(func() {
							w, label := 400, r.title
							if r.icon != "" {
								w = 700
							}
							if r.badge != "" {
								label += "（" + r.badge + "）"
							}
							tightText(c, label, 13, 18, w, ptBlack)
							if r.hint != "" {
								text(c, r.hint, 11, 16, 400, ptMuted).Wrap()
							}
						})
						if r.control != nil {
							r.control()
						}
					})
					if r.below != nil {
						ui.Column(c).Margin(8, 0, 0, 0).Gap(6).Children(r.below)
					}
				})
			}
		})
		if title != "" {
			ui.Box(c).Absolute().Left(8).Top(-8).Height(16).Padding(0, 4).Background(ptG300).Children(func() {
				text(c, title, 13, 18.2, 700, ptBlack).SingleLine().Margin(-1.1, 0, 0, 0) // CSS 行高 16 小于自然行高，上移半行距
			})
		}
	})
	if sec.footer != "" {
		text(c, sec.footer, 11, 16, 400, ptMuted).Wrap()
	}
}

// ptRadios：两项分段控件在 Platinum 下的单选钮组（12×12 圆钮 + 文字，组间距 16）。
func ptRadios(c *ui.Context, sel *int, labels ...string) bool {
	changed := false
	ui.Row(c).Gap(16).AlignItems(ui.Center).Children(func() {
		for i, l := range labels {
			r := ui.Row(c).Gap(6).AlignItems(ui.Center).Key("ptr-" + l)
			r.Children(func() {
				dot := ui.Box(c).Size(12, 12).Radius(6).Border(1, ptBlack)
				if r.Pressed() {
					dot.Background(ptG600)
				} else {
					dot.RadialGradient(ui.RadialGradient{Center: ui.Point{X: 0.35, Y: 0.35}, Stops: []ui.GradientStop{{Color: ptWhite, At: 0}, {Color: ptWhite, At: 0.25}, {Color: ptG300, At: 0.7}}})
				}
				dot.Children(func() {
					if *sel == i {
						ui.Box(c).Absolute().Top(1).Left(1).Size(6, 6).Radius(3).Background(ptBlack)
					}
				})
				text(c, tr(l), 12, 16, 400, ptBlack)
			})
			if r.Clicked() && *sel != i {
				*sel, changed = i, true
			}
		}
	})
	return changed
}

var ptPopupArrows = ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 10"><path fill="currentColor" d="M3 0h1v1H3zM2 1h3v1H2zM1 2h5v1H1zM0 3h7v1H0zM0 6h7v1H0zM1 7h5v1H1zM2 8h3v1H2zM3 9h1v1H3z"/></svg>`))

// ptPopup：三项以上分段控件在 Platinum 下的弹出菜单（19 高、黑框圆角 3，右侧 21 宽双箭头井），点开原生菜单。
func ptPopup(c *ui.Context, sel *int, labels ...string) bool {
	changed := false
	b := ui.Row(c).Height(19).MinWidth(98).Radius(3).Border(1, ui.RGB(0, 0, 0)).Background(ptG300).AlignItems(ui.Stretch)
	b.Children(func() {
		ui.Row(c).Grow(1).Padding(0, 8, 0, 7).AlignItems(ui.Center).BorderWidth(1, 0, 1, 1).BorderColor(ptWhite).
			InsetShadow(0, -1, 0, 0, ui.RGB(170, 170, 170)).Children(func() {
			text(c, tr(labels[max(0, min(*sel, len(labels)-1))]), 12, 17, 400, ui.RGB(0, 0, 0)).SingleLine()
		})
		ui.Box(c).Width(21).Margin(1, 0, 0, 0).BorderWidth(0, 0, 0, 1).BorderColor(ui.RGB(170, 170, 170)).Children(func() {
			ui.Box(c).Absolute().Top(0).Left(1).Right(0).Bottom(0).BorderWidth(0, 1, 1, 0).BorderColor(ui.RGB(119, 119, 119))
			ui.Box(c).Absolute().Top(0).Left(0).Right(1).Bottom(1).Border(1, ptWhite).BorderWidth(1, 1, 1, 1).Children(func() {
				ui.Box(c).Absolute().Top(-1).Left(-1).Right(-1).Bottom(-1).BorderWidth(0, 1, 1, 0).BorderColor(ui.RGB(170, 170, 170))
				ui.Icon(c, ptPopupArrows).Absolute().Left(4).Top(1).Size(7, 10).TextColor(ui.RGB(0, 0, 0))
			})
		})
	})
	b.Menu(func(m *ui.Menu) {
		for i, l := range labels {
			if m.Item(tr(l)).Radio(i == *sel).Chosen() && i != *sel {
				*sel, changed = i, true
			}
		}
	})
	return changed
}

var ptCheckMark = ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 13"><path fill="currentColor" d="M11 1h2v2h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v2H4V9H3V8H2V6h2v1h1v1h1V7h1V6h1V5h1V4h1V3h1V2z"/></svg>`))

// ptCheckbox：开关在 Platinum 下的复选框（12×12，勾号溢出框外，同 Mac OS 9）。
func ptCheckbox(c *ui.Context, on *bool) bool {
	changed := false
	ui.Box(c).Size(12, 24).Children(func() {
		b := ui.Box(c).Absolute().Top(6.5).Left(0).Size(12, 12).Border(1, ptBlack)
		if b.Pressed() {
			b.Background(ptG600)
		} else {
			ptBevel(b.Background(ptG200), ptG500)
		}
		if *on {
			ui.Icon(c, ptCheckMark).Absolute().Top(1.5).Left(-1).Size(14, 13).TextColor(ptBlack)
		}
		if b.Clicked() {
			*on, changed = !*on, true
		}
	})
	return changed
}

var ptThumbTip = ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 11 6"><path fill="currentColor" d="M0 0H11V1L5.5 6L0 1Z"/></svg>`))

// ptSlider：凹槽轨道（5 高）+ 11×15 薰衣草尖头滑块；拖动或点按槽位取值。
func ptSlider(c *ui.Context, v *float64, lo, hi, step float64) bool {
	changed := false
	const w, tw = 128, 11
	frac := float32(0)
	if hi > lo {
		frac = float32((*v - lo) / (hi - lo))
	}
	area := ui.Box(c).Size(w, 16)
	area.Children(func() {
		ui.Box(c).Absolute().Top(5.5).Left(0).Right(0).Height(5).Background(ptG500).Border(1, ptBlack).
			InsetShadow(1, 1, 0, 0, ptG700).Shadow(1, 1, 0, 0, ptWhite)
		x := frac * (w - tw)
		ui.Box(c).Absolute().Left(x).Top(0).Size(tw, 10).LinearGradient(ptLavGradient(90)).BorderWidth(1, 1, 0, 1).BorderColor(ptBlack)
		ui.Box(c).Absolute().Left(x).Top(9).Size(tw, 6).Children(func() {
			ui.Icon(c, ptThumbTip).Absolute().Fill().TextColor(ptBlack)
			ui.Box(c).Absolute().Left(1).Top(0).Size(tw-2, 1).Background(ptLav)
		})
	})
	if px, _, ok := area.PointerPosition(); ok && (area.Pressed() || area.Dragging()) {
		f := float64(max(0, min(1, (px-tw/2)/(w-tw))))
		nv := lo + f*(hi-lo)
		nv = float64(int(nv/step+0.5)) * step
		if nv != *v {
			*v, changed = nv, true
		}
	}
	return changed
}

// ptButton：斜面按钮（黑框 + 双层内斜面）。
func ptButton(c *ui.Context, label string) bool {
	b := ui.Row(c).Height(22).Padding(0, 12).Radius(4).Background(ptG300).Border(1, ptBlack).AlignItems(ui.Center).Key("ptb-" + label)
	if b.Pressed() {
		b.Background(ptG700).InsetShadow(1, 1, 0, 0, ui.RGB(68, 68, 68)).InsetShadow(-1, -1, 0, 0, ui.RGB(136, 136, 136))
	} else {
		b.InsetShadow(1, 1, 0, 0, ptG300).InsetShadow(-1, -1, 0, 0, ui.RGB(119, 119, 119)).
			InsetShadow(2, 2, 0, 0, ptWhite).InsetShadow(-2, -2, 0, 0, ui.RGB(170, 170, 170))
	}
	b.Children(func() { text(c, tr(label), 12, 17, 400, ptBlack) })
	return b.Clicked()
}
