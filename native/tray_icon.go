package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"time"

	"github.com/toskr/native/internal/diag"
)

// 菜单栏图标带状态（原生版新增，Tauri 无）：不点开菜单也看得出 Toskr 在不在收集。
// 同时出现时只显示优先级最高的一个：权限失效（琥珀点）→ 有逾期任务（红点）→ 暂停收集（斜线）→ 隐身（半透明）。
// 斜线与半透明仍是模板图（系统按菜单栏深浅着色）；带色点的两种不能做模板图，底图按菜单栏深浅自己着黑 / 白。

// trayState：当前该显示哪种状态。
func (a *app) trayState() string {
	st := a.store.Settings()
	switch {
	case a.permState() == "ax" || a.permState() == "stuck":
		return "perm"
	case a.overdueCount() > 0:
		return "overdue"
	case st.ClipboardWatch && a.now().Before(st.ClipPauseUntil):
		return "paused"
	case st.Stealth:
		return "stealth"
	}
	return "normal"
}

// trayTitle：图标旁的下一个到期时间（设置里开启；今天内的未完成任务，没有则为空）。
func (a *app) trayTitle() string {
	if a.focus != nil { // 专注中：剩余分钟（不受「显示下一个到期」开关影响）
		return fmt.Sprintf(tr("专注 %d 分"), a.focusLeft())
	}
	if !a.store.Settings().TrayNextDue {
		return ""
	}
	now := a.now()
	end := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, now.Location())
	var next time.Time
	for _, t := range a.tasks {
		if t.Status == "done" || t.DueAt.IsZero() || !t.DueAt.After(now) || !t.DueAt.Before(end) {
			continue
		}
		if next.IsZero() || t.DueAt.Before(next) {
			next = t.DueAt
		}
	}
	if next.IsZero() {
		return ""
	}
	return next.Format("15:04")
}

var (
	trayDotRed   = color.NRGBA{R: 232, G: 64, B: 54, A: 255}
	trayDotAmber = color.NRGBA{R: 245, G: 166, B: 35, A: 255}
)

// trayIconFor 合成某状态的图标；template 为 false 时底图已按 dark 着色。
func trayIconFor(base []byte, state string, dark bool) (out []byte, template bool) {
	src, err := png.Decode(bytes.NewReader(base))
	if err != nil || state == "normal" {
		return base, true
	}
	b := src.Bounds()
	img := image.NewNRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			img.Set(x, y, src.At(x, y))
		}
	}
	w, h := float64(b.Dx()), float64(b.Dy())
	each := func(fn func(x, y float64, px *color.NRGBA)) {
		for y := 0; y < b.Dy(); y++ {
			for x := 0; x < b.Dx(); x++ {
				px := img.NRGBAAt(b.Min.X+x, b.Min.Y+y)
				fn(float64(x)+0.5, float64(y)+0.5, &px)
				img.SetNRGBA(b.Min.X+x, b.Min.Y+y, px)
			}
		}
	}
	cover := func(d, r float64) float64 { return math.Max(0, math.Min(1, r-d+0.5)) } // 距离 d 处、半径 r 的抗锯齿覆盖率
	template = true
	switch state {
	case "stealth":
		each(func(_, _ float64, px *color.NRGBA) { px.A = uint8(float64(px.A) * 0.4) })
	case "paused": // 左下 → 右上的斜线，两侧各挖一圈空隙
		each(func(x, y float64, px *color.NRGBA) {
			d := math.Abs(x+y-w) / math.Sqrt2 // 到斜线 x + y = w 的距离
			along := x > w*0.14 && x < w*0.86
			if !along {
				return
			}
			px.A = uint8(float64(px.A) * (1 - cover(d, w*0.11)))
			if c := cover(d, w*0.045); c > 0 {
				*px = color.NRGBA{A: uint8(math.Max(float64(px.A), 255*c))}
			}
		})
	case "overdue", "perm":
		template = false
		dot := trayDotRed
		if state == "perm" {
			dot = trayDotAmber
		}
		ink := uint8(0)
		if dark {
			ink = 255
		}
		cx, cy, r := w*0.82, h*0.18, w*0.13
		each(func(x, y float64, px *color.NRGBA) {
			px.R, px.G, px.B = ink, ink, ink
			d := math.Hypot(x-cx, y-cy)
			px.A = uint8(float64(px.A) * (1 - cover(d, r+w*0.06))) // 色点外留一圈空隙
			if c := cover(d, r); c > 0 {
				*px = color.NRGBA{R: dot.R, G: dot.G, B: dot.B, A: uint8(255 * c)}
			}
		})
	}
	var buf bytes.Buffer
	if png.Encode(&buf, img) != nil {
		return base, true
	}
	return buf.Bytes(), template
}

// refreshTrayIcon：状态或菜单栏深浅变了才换图 / 换标题。
func (a *app) refreshTrayIcon() {
	if a.tray == nil {
		return
	}
	state, dark := a.trayState(), a.tray.Dark()
	key := state
	if state == "overdue" || state == "perm" {
		key += map[bool]string{true: "-dark", false: "-light"}[dark]
	}
	if key != a.trayIconKey {
		icon, tmpl := trayIconFor(trayPNG, state, dark)
		if err := a.tray.SetIcon(icon, tmpl); err != nil {
			diag.Push("托盘图标更新失败: %v", err)
		} else {
			a.trayIconKey = key
			a.tray.SetToolTip(trayTip(state))
		}
	}
	if t := a.trayTitle(); t != a.trayTitleShown {
		a.trayTitleShown = t
		a.tray.SetTitle(t)
	}
}

func trayTip(state string) string {
	switch state {
	case "perm":
		return "Toskr · " + tr("权限需要处理")
	case "overdue":
		return "Toskr · " + tr("有逾期任务")
	case "paused":
		return "Toskr · " + tr("已暂停剪贴板收集")
	case "stealth":
		return "Toskr · " + tr("隐身模式")
	}
	return "Toskr"
}
