package main

import (
	"bytes"
	_ "embed"
	"image"
	"image/color"
	"image/png"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
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
		return
	}
	a.showHUDForce(kind, text)
	a.hudUndo = undo
}

func (a *app) showHUDForce(kind, text string) {
	a.hudKind, a.hudText, a.hudUndo, a.hudHover = kind, text, nil, false
	a.hudGen++
	gen := a.hudGen
	if a.hud == nil {
		return // 无窗口（视图测试）
	}
	d := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint())
	a.hud.SetPosition(d.WorkArea.X+d.WorkArea.Width-hudW-8, d.WorkArea.Y+8)
	a.hud.SetIgnoreMouseEvents(true)
	a.hud.Invalidate()
	a.hud.ShowInactive()
	hold := 1800 * time.Millisecond
	if kind == "warn" {
		hold = 4 * time.Second
	}
	go a.watchHUDHover(gen, time.Now().Add(hold))
}

// watchHUDHover 轮询光标：在气泡上时关闭穿透并暂停计时，离开后重新计时，到时收起。
func (a *app) watchHUDHover(gen int, deadline time.Time) {
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
			in := p.X >= b.X && p.X < b.X+b.Width && p.Y >= b.Y && p.Y < b.Y+60 // 气泡区（不含下方 logo）
			if in != a.hudHover {
				a.hudHover = in
				a.hud.SetIgnoreMouseEvents(!in)
				a.hud.Invalidate()
			}
			if in {
				deadline = time.Now().Add(1200 * time.Millisecond)
			} else if time.Now().After(deadline) {
				a.hud.Hide()
				done = true
			}
		})
		if done {
			return
		}
	}
}

func (a *app) dismissHUD() {
	a.hudGen++
	if a.hud != nil {
		a.hud.Hide()
	}
}

func (a *app) hudView(c *ui.Context) {
	registerFonts()
	c.Root().Background(ui.Transparent)
	paper, ink := oklch(0.965, 0.012, 90, 1), oklch(0.24, 0.01, 90, 1)
	if c.Theme().Dark {
		paper, ink = oklch(0.9, 0.014, 90, 1), gray(0.205, 1)
	}
	ic := hudIcons[a.hudKind]
	if ic.icon == "" {
		ic = hudIcons["info"]
	}
	icon := func() {
		ui.Box(c).Size(20, 20).Radius(10).Background(ic.color).Center().Children(func() { licon(c, ic.icon, 12, ui.RGB(255, 255, 255)) })
	}
	title := hudTitle(a.hudKind, a.hudText, 1)
	actionable := a.hudUndo != nil
	ui.Column(c).Fill().Padding(8, 12, 0, 12).AlignItems(ui.End).Children(func() {
		if !actionable {
			pill := ui.Row(c).Padding(4, 12, 4, 6).Gap(6).Radius(16).Background(paper).AlignItems(ui.Center).
				Shadow(0, 6, 16, -4, gray(0, 0.12)).Shadow(0, 1, 2, 0, gray(0, 0.08))
			pill.Children(func() {
				icon()
				text(c, title, 12, 15, 500, ink).Wrap().MaxLines(3)
			})
			if pill.Clicked() {
				a.dismissHUD()
			}
			return
		}
		ui.Column(c).FillWidth().Children(func() {
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
			balloon.Children(func() {
				icon()
				ui.Column(c).Grow(1).Basis(0).Children(func() {
					tightText(c, title, 12, 15, 500, ink).FillWidth()
					if (a.hudKind == "added" || a.hudKind == "duplicate") && a.hudText != "" {
						tightText(c, a.hudText, 10, 12.5, 400, ink.Alpha(0.55)).FillWidth()
					}
				})
				undo := ui.Row(c).Height(20).Padding(2, 6).Gap(4).Radius(6).Border(1, ink.Alpha(0.25)).AlignItems(ui.Center)
				if !a.hudHover {
					undo.Opacity(0)
				}
				undo.Children(func() {
					licon(c, "undo-2", 10, ink.Alpha(0.75))
					text(c, tr("撤销"), 10, 14, 400, ink.Alpha(0.75))
				})
				if undo.Clicked() && a.hudUndo != nil {
					fn := a.hudUndo
					a.showHUDForce("undone", tr("已撤销"))
					fn()
				}
				x := ui.Box(c).Size(22, 22).Radius(11).Background(ink.Alpha(0.1)).Center().Tooltip(tr("关闭"))
				x.Children(func() { licon(c, "x", 14, ink.Alpha(0.6)) })
				if x.Clicked() {
					a.dismissHUD()
				}
			})
			// 尾巴：22×13 固定几何，从气泡右下弯向 logo
			ui.Row(c).FillWidth().Height(12).Margin(-1, 0, 0, 0).Justify(ui.End).Padding(0, 14, 0, 0).Children(func() {
				ui.Box(c).Size(22, 13).Children(func() {
					ui.Icon(c, hudTail).Absolute().Top(4).Left(0).Size(22, 13).TextColor(s2).Blur(5) // 尾巴随气泡同一组投影
					ui.Icon(c, hudTail).Absolute().Top(0).Left(0).Size(22, 13).TextColor(paper)
				})
			})
		})
		hudLogoOnce.Do(loadHUDLogo)
		if hudLogo != nil {
			dy, sigma, alpha := float32(2), float32(5), float32(0.28)
			if c.Theme().Dark {
				dy, sigma, alpha = 3, 7, 0.55
			}
			ui.Box(c).Size(36, 36).Margin(-6, 2, 0, 0).Children(func() {
				if hudLogoMask != nil {
					ui.Image(c, hudLogoMask).Absolute().Top(dy).Left(0).Size(36, 36).Blur(sigma).Opacity(alpha)
				}
				ui.Image(c, hudLogo).Absolute().Top(0).Left(0).Size(36, 36)
			})
		}
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
