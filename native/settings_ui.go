package main

import (
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"
)

// 设置窗按 Tauri 版 SettingsView 复刻（1040×720；规格取自浏览器实测导出）：
// 左侧栏 176（搜索 32 + 分类 33，间距 4）→ 右侧内容最宽 720 居中：标题 15/20 → 子页签 28 → 分组（标题 13/18 + 圆角 14 卡片，行内边距 10/14）。

type settingsTokens struct {
	bg, aside, asideBorder, input, inputBorder ui.Color
	primary, navSel, navSelBorder              ui.Color
	card, cardBorder, rowBorder                ui.Color
	toggleOff, toggleOffBorder, toggleInset    ui.Color
	knob, knobOn                               ui.Color // 开关滑块（关 / 开；shadcn：浅色均为 background，深色关为 foreground、开为 primary-foreground）
	btn, btnFg, btnBorder, btnShadow           ui.Color
	btnHover                                   ui.Color // --button-primary-hover
	pt                                         bool     // Platinum：控件换成 Mac OS 9 形态
}

var (
	lightSet = func() settingsTokens {
		p := oklch(0.56, 0.19, 259.8, 1)
		return settingsTokens{
			bg: gray(1, 1), aside: gray(0.97, 0.4), asideBorder: gray(0.922, 0.6), input: gray(1, 1), inputBorder: gray(0.922, 1),
			primary: p, navSel: p.Alpha(0.1), navSelBorder: p.Alpha(0.5),
			card: gray(1, 1), cardBorder: gray(0.922, 0.6), rowBorder: gray(0.922, 0.5),
			toggleOff: gray(0.86, 1), toggleOffBorder: gray(0, 0.14), toggleInset: gray(0, 0.18), knob: gray(1, 1), knobOn: gray(1, 1),
			btn: gray(1, 1), btnFg: gray(0.145, 1), btnBorder: gray(0, 0.1), btnShadow: gray(0, 0.12), btnHover: gray(0.955, 1),
		}
	}()
	darkSet = func() settingsTokens {
		p := oklch(0.685, 0.19, 259.8, 1)
		return settingsTokens{
			bg: gray(0.145, 1), aside: gray(0.269, 0.4), asideBorder: gray(1, 0.06), input: gray(0.145, 1), inputBorder: gray(1, 0.1),
			primary: p, navSel: p.Alpha(0.1), navSelBorder: p.Alpha(0.5),
			card: gray(0.205, 1), cardBorder: gray(1, 0.06), rowBorder: gray(1, 0.05),
			toggleOff: gray(1, 0.14), toggleOffBorder: gray(1, 0.12), toggleInset: gray(0, 0.45), knob: gray(0.985, 1), knobOn: gray(0.985, 1),
			btn: gray(0.92, 1), btnFg: gray(0.205, 1), btnBorder: gray(1, 0.08), btnShadow: gray(0, 0.3), btnHover: gray(0.87, 1),
		}
	}()
)

func stok(c *ui.Context) settingsTokens {
	if c.Theme().Dark {
		return setSchemed(darkSet, true)
	}
	return setSchemed(lightSet, false)
}

// setRow 是卡片里的一行：左侧标题（可带说明），右侧控件；below 画在标题下方的整宽内容（文本框、列表等）。
type setRow struct {
	title, hint string
	control     func()
	below       func()
	hidden      bool // 条件行（如固定浅色方案下的「主题」）
}

type setSection struct {
	title string
	rows  []setRow
}

type setPage struct {
	label, icon string
	subs        []string       // 子页签（为空则不显示）
	sections    [][]setSection // 每个子页签一组分组
}

func (r setRow) matches(q string) bool {
	q = strings.ToLower(q)
	return strings.Contains(strings.ToLower(r.title), q) || strings.Contains(strings.ToLower(r.hint), q)
}

func (a *app) settingsShell(c *ui.Context, pages []setPage) {
	k, s := tok(c), stok(c)
	if c.Vibrancy() {
		c.Root().Background(ui.Transparent) // 侧栏透出系统侧栏材质；内容区仍是不透明底，与 Tauri 一致
	} else {
		c.Root().Background(s.bg)
	}
	if s.pt {
		a.ptSettingsShell(c, k, s, pages)
		return
	}
	a.setPage = min(a.setPage, len(pages)-1)
	ui.Row(c).Fill().AlignItems(ui.Stretch).Children(func() {
		ui.Column(c).Width(176).Padding(8).Background(s.aside).BorderWidth(0, 1, 0, 0).BorderColor(s.asideBorder).Children(func() {
			ui.Row(c).Height(32).Padding(0, 8).Gap(6).Radius(10).Background(s.input).Border(1, s.inputBorder).AlignItems(ui.Center).Children(func() {
				licon(c, "search", 14, k.muted)
				ui.TextInputBase(c, &a.setQuery).Bind(&a.setSearch).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).
					TextColor(k.fg).PlaceholderColor(k.muted).Placeholder(tr("搜索设置"))
			})
			ui.Column(c).Margin(6, 2, 0, 0).Gap(4).Children(func() {
				for i, p := range pages {
					sel := a.setPage == i && a.setQuery == ""
					b := ui.Row(c).Height(33).Padding(8, 10).Gap(8).Radius(10).AlignItems(ui.Center).Key("nav-" + p.label)
					w, col := 400, k.muted
					if sel {
						w, col = 500, k.fg
						b.Background(s.navSel)
					} else if b.Hovered() {
						b.Background(k.track)
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
		ui.Box(c).Grow(1).Background(s.bg).Children(func() {
			ui.Scroll(c).Fill().Children(func() {
				// 右侧留 5px 与 Tauri 的经典滚动条占位一致，720 内容列在剩余宽度内居中
				ui.Column(c).Padding(20, 25, 20, 20).AlignItems(ui.Center).Children(func() {
					ui.Column(c).FillWidth().MaxWidth(720).Children(func() {
						if a.setQuery != "" {
							a.searchResults(c, k, s, pages)
							return
						}
						p := pages[a.setPage]
						text(c, tr(p.label), 15, 20, 600, k.fg)
						if len(p.subs) > 0 {
							a.setSub = min(a.setSub, len(p.subs)-1)
							ui.Row(c).Height(28).Margin(12, 0, 0, 0).Gap(6).Children(func() {
								for i, sub := range p.subs {
									sel := a.setSub == i
									b := ui.Row(c).Height(28).Padding(0, 10).Radius(10).AlignItems(ui.Center).Key("sub-" + sub)
									bg, bd := ui.Transparent, ui.Transparent
									if sel {
										bg, bd = s.navSel, s.navSelBorder
									} else if b.Hovered() {
										bg = k.track
									}
									ctl := tw(100, easeStandard) // Button：color / bg / border / shadow / transform 100ms ease-standard
									fadeColor(b, "bg", bg, ctl).Border(1, b.AnimateColor("bd", bd, ctl))
									b.AnimatePose(ui.Pose{Y: pressY(b.Pressed())}, ctl)
									b.Children(func() { text(c, tr(sub), 12, 17, 500, k.fg) })
									if b.Clicked() {
										a.setSub = i
									}
								}
							})
						}
						secs := p.sections[min(a.setSub, len(p.sections)-1)]
						ui.Column(c).Margin(16, 0, 0, 0).Gap(24).Children(func() {
							for _, sec := range secs {
								settingsSection(c, k, s, sec.title, sec.rows)
							}
						})
					})
				})
			})
		})
	})
}

func (a *app) searchResults(c *ui.Context, k tokens, s settingsTokens, pages []setPage) {
	text(c, tr("搜索结果"), 15, 20, 600, k.fg)
	found := false
	ui.Column(c).Margin(16, 0, 0, 0).Gap(24).Children(func() {
		for _, p := range pages {
			for _, group := range p.sections {
				for _, sec := range group {
					var rows []setRow
					for _, r := range sec.rows {
						if r.matches(a.setQuery) {
							rows = append(rows, r)
						}
					}
					if len(rows) > 0 {
						found = true
						settingsSection(c, k, s, tr(p.label)+" · "+sec.title, rows)
					}
				}
			}
		}
		if !found {
			text(c, tr("没有匹配的设置"), 12, 17, 400, k.muted)
		}
	})
}

func settingsSection(c *ui.Context, k tokens, s settingsTokens, title string, rows []setRow) {
	if s.pt {
		ptSection(c, k, s, title, rows)
		return
	}
	rows = slices.DeleteFunc(slices.Clone(rows), func(r setRow) bool { return r.hidden })
	if len(rows) == 0 {
		return
	}
	ui.Column(c).Gap(8).Key("sec-" + title).Children(func() {
		text(c, title, 13, 18, 600, k.fg).Padding(0, 2)
		ui.Column(c).Radius(14).Background(s.card).Border(1, s.cardBorder).Children(func() {
			for i, r := range rows {
				row := ui.Column(c).Padding(10, 14).Radius(10)
				if i < len(rows)-1 {
					row.BorderWidth(0, 0, 1, 0).BorderColor(s.rowBorder)
				}
				row.Children(func() {
					ui.Row(c).Gap(16).AlignItems(ui.Center).Children(func() {
						ui.Column(c).Grow(1).Basis(0).Gap(2).Children(func() {
							tightText(c, r.title, 13, 18, 400, k.fg)
							if r.hint != "" {
								text(c, r.hint, 11, 16, 400, k.muted).Wrap()
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
	})
}

// ---- 控件（与 Tauri 的 SegmentedControl / Switch / Button / Input 同规格） ----

func segmented(c *ui.Context, k tokens, sel *int, labels ...string) bool {
	if k.pt { // Platinum：两项为单选钮，三项以上为弹出菜单（Tauri Segmented 的 platinum 分支）
		if len(labels) == 2 {
			return ptRadios(c, sel, labels...)
		}
		return ptPopup(c, sel, labels...)
	}
	changed := false
	ui.Row(c).Height(28).Padding(2).Radius(10).Background(k.track).InsetShadow(0, 1, 2, 0, k.insetShadow).Children(func() {
		for i, l := range labels {
			on := *sel == i
			b := ui.Box(c).Height(24).Padding(4, 8).Radius(8).Center().Key("seg-" + l)
			w, col := 400, k.muted
			if on {
				w, col = 500, k.fg
			} else if b.Hovered() {
				col = k.fg
			}
			b.Children(func() {
				if on { // 共享布局滑块（layoutId ${groupName}-thumb，springControl）
					thumb := ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Radius(8).Background(k.pill).Shadow(0, 1, 2, 0, k.pillShadow).PassThrough().
						Transition(ui.ElementTransition{Match: layoutID{"seg-" + strings.Join(labels, "|")}, Animation: &springControl, Position: true, Size: true})
					if !k.dark {
						thumb.InsetShadow(0, 1, 0, 0, k.pillHighlight)
					}
				}
				fg := b.AnimateColor("fg", col, tweenControl)
				overThumb(c, func() { text(c, tr(l), 11, 16, w, fg) })
			})
			if b.Clicked() && !on {
				*sel, changed = i, true
			}
		}
	})
	return changed
}

func toggle(c *ui.Context, s settingsTokens, on *bool) bool {
	if s.pt {
		return ptCheckbox(c, on)
	}
	changed := false
	ui.Box(c).Size(32, 24).Children(func() {
		sw := ui.Box(c).Size(32, 18).Radius(9).InsetShadow(0, 1, 2, 0, s.toggleInset)
		bg, bd, left := s.toggleOff, s.toggleOffBorder, float32(0)
		if *on {
			bg, bd, left = s.primary, ui.Transparent, 14
		}
		fadeColor(sw, "bg", bg, tweenTw).Border(1, sw.AnimateColor("bd", bd, tweenTw)) // 轨道 150ms
		sw.Children(func() {
			knob := s.knob
			if *on {
				knob = s.knobOn
			}
			// 滑块 translate-x 180ms ease-pop（带一点过冲）
			ui.Box(c).Absolute().Top(0).Left(0).Size(16, 16).Radius(8).Background(knob).
				Shadow(0, 1, 2, 0, gray(0, 0.3)).Shadow(0, 1, 1, 0, gray(0, 0.1)).AnimatePose(ui.Pose{X: left}, tweenKnob)
		})
		if sw.Clicked() {
			*on, changed = !*on, true
		}
	})
	return changed
}

func button(c *ui.Context, s settingsTokens, label string) bool {
	if s.pt {
		return ptButton(c, label)
	}
	b := ui.Row(c).Height(28).Padding(0, 10).Radius(10).Border(1, s.btnBorder).AlignItems(ui.Center)
	bg, sh := s.btn, s.btnShadow
	if b.Hovered() {
		bg = s.btnHover
	}
	ctl := tw(100, easeStandard)
	if b.Pressed() { // active:shadow-none + translate-y 0.5px
		sh = ui.Transparent
	}
	fadeColor(b, "bg", bg, ctl).Shadow(0, 1, 2, 0, b.AnimateColor("sh", sh, ctl))
	b.AnimatePose(ui.Pose{Y: pressY(b.Pressed())}, ctl)
	b.Children(func() { text(c, tr(label), 12, 17, 500, s.btnFg) })
	return b.Clicked()
}

func textField(c *ui.Context, k tokens, s settingsTokens, v *string, w float32, placeholder string, password bool) bool {
	changed := false
	box := ui.Row(c).Width(w).Height(32).Padding(0, 8).Radius(10).Background(s.input).Border(1, s.inputBorder).AlignItems(ui.Center)
	if s.pt {
		ptWell(box.Radius(0))
	}
	box.Children(func() {
		in := ui.TextInputBase(c, v).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).TextColor(k.fg).PlaceholderColor(k.muted).Placeholder(placeholder)
		if password {
			in.Password()
		}
		changed = in.Changed()
	})
	return changed
}

func textBox(c *ui.Context, k tokens, s settingsTokens, v *string, minLines, maxLines int) bool {
	changed := false
	box := ui.Column(c).Padding(6, 8).Radius(10).Background(s.input).Border(1, s.inputBorder)
	if s.pt {
		ptWell(box.Radius(0))
	}
	box.Children(func() {
		changed = ui.TextAreaBase(c, v).FillWidth().Lines(minLines, maxLines).Font(fontMono).FontSize(12).FixedLineHeight(17).TextColor(k.fg).Changed()
	})
	return changed
}

// sliderValue 是滑块 + 右侧数值（Tauri「详情窗字号」同款：128 宽，标签 11/16 右对齐 36 宽）。
func sliderValue(c *ui.Context, k tokens, v *float64, lo, hi, step float64, label string) bool {
	changed := false
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		if k.pt {
			changed = ptSlider(c, v, lo, hi, step)
		} else if ui.Slider(c, v, lo, hi).Width(128).Changed() {
			*v = float64(int(*v/step+0.5)) * step
			changed = true
		}
		text(c, label, 11, 16, 400, k.muted).Width(36).TextAlign(ui.End)
	})
	return changed
}

// settingsSelect 是设置行右侧的下拉（Tauri SimpleSelect w-36：144×32、圆角 10、描边），点开原生菜单。
func settingsSelect(c *ui.Context, k tokens, s settingsTokens, label string, menu func(*ui.Menu)) {
	b := ui.Row(c).Width(144).Height(32).Padding(0, 8).Gap(4).Radius(10).Border(1, s.inputBorder).AlignItems(ui.Center)
	if s.pt {
		b.Radius(3).Border(1, ptG600)
	} else if b.Hovered() {
		b.Background(k.track)
	}
	b.Children(func() {
		text(c, tr(label), 12, 17, 400, k.fg).SingleLine().Grow(1).Basis(0)
		licon(c, "chevron-down", 14, k.muted)
	})
	b.Menu(menu)
}
