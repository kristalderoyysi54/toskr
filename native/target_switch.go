package main

import (
	"math"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
)

// 目标栏「灵动胶囊」切换动效（用户 2026-11-09 从样本册改选 18，tasks/design/target-switch-lab.html）：目标换应用时，
// 图标与名字后面临时长出一颗应用主色的胶囊（旧主色 → 新主色），挤压、回弹，把新名字包进来再淡出；
// 旧图标 / 名字缩小淡出，新图标回弹弹入，新名字上浮淡入，名字宽度用回弹曲线过渡。
// 触发规则：只在目标真的换了且面板可见时播；播放中又换目标直接接到最新目标（不排队补播）；
// 面板隐藏期间的切换在下次唤出时直接显示最终状态；减弱动态效果时退化为 120ms 淡入。

type targetSwitch struct {
	shown macos.FrontApp // 目标栏当前显示（或正切向）的目标
	from  macos.FrontApp // 动画里被盖住的旧目标
	at    time.Time      // 动画起点；零值 = 不在播
}

const (
	tswTotal   = 1000 * time.Millisecond // 胶囊长出 → 挤压回弹 → 淡出
	tswReduced = 120 * time.Millisecond
)

// tswAlways：测试里没有真实窗口，也按「面板可见」处理。
var tswAlways bool

// syncTargetShown：面板唤出时目标栏直接显示当前目标，不播动画（隐藏期间的切换不补播）。
func (a *app) syncTargetShown() { a.tsw.shown, a.tsw.at = a.target, time.Time{} }

// targetSwitchElapsed：本帧动画进度；ok=false 表示不在播。目标变化在这里统一发现（observeFront / 刷新 / 手动指定 / 捕获都走到这）。
func (a *app) targetSwitchElapsed(c *ui.Context) (time.Duration, bool) {
	t := &a.tsw
	now := c.Now()
	if a.target.PID != t.shown.PID || a.target.BundleID != t.shown.BundleID {
		visible := tswAlways || (a.panel != nil && a.panel.IsVisible())
		switch {
		case t.shown.PID == 0 || !visible: // 首次识别 / 面板不可见：不播
			t.at = time.Time{}
		case !t.at.IsZero() && now.Sub(t.at) < 160*time.Millisecond: // 旧内容还没退完：保留旧目标，直接接到最新目标
			t.at = now
		default:
			t.from, t.at = t.shown, now
		}
		t.shown = a.target
	}
	if t.at.IsZero() {
		return 0, false
	}
	el := now.Sub(t.at)
	total := tswTotal
	if c.Preferences().ReduceMotion {
		total = tswReduced
	}
	if el >= total {
		t.at = time.Time{}
		return 0, false
	}
	c.AnimationFrame()
	return el, true
}

// targetIcon：目标应用图标（16pt，圆角 4）；没取到用通用图标。
func (a *app) targetIcon(c *ui.Context, k tokens, f macos.FrontApp) ui.Element {
	if img := a.appIcon(f.BundleID); img != nil {
		return ui.Image(c, img).Size(16, 16).Radius(4)
	}
	return ui.Box(c).Size(16, 16).Radius(rr(6)).Background(k.chip).Center().Children(func() { licon(c, "app-window", 8, k.muted) })
}

var (
	tswStd    = ui.CubicBezier(0.2, 0, 0, 1)
	tswOut    = ui.CubicBezier(0.16, 1, 0.3, 1)
	tswIn     = ui.CubicBezier(0.4, 0, 1, 1)
	tswSpring = ui.CubicBezier(0.34, 1.56, 0.64, 1)
)

// tswPhase：从 start 起、历时 dur 的一段的进度 [0,1]。
func tswPhase(el, start, dur time.Duration) float32 {
	return min(max(float32(el-start)/float32(dur), 0), 1)
}

// tswKey：分段线性关键帧（offsets 递增，同 CSS @keyframes）。
func tswKey(p float32, offsets, values []float32) float32 {
	for i := 1; i < len(offsets); i++ {
		if p <= offsets[i] {
			u := (p - offsets[i-1]) / (offsets[i] - offsets[i-1])
			return values[i-1] + (values[i]-values[i-1])*u
		}
	}
	return values[len(values)-1]
}

func (a *app) tswColor(k tokens, f macos.FrontApp) ui.Color {
	if col, ok := a.appIconColor(f.BundleID); ok && f.BundleID != "" {
		return col
	}
	return k.muted
}

// capsuleTint：胶囊底色按应用主色的亮度 / 饱和度自适应，保证在面板底上看得出来——
// 深色模式下偏暗的主色（Cursor、iTerm 这类近黑图标）往白提亮，浅色模式下偏亮的主色往黑压暗；
// 偏灰的主色加浓一些；深色底本身吃颜色，基础浓度比浅色高。
func capsuleTint(col ui.Color, dark bool) (ui.Color, float32) {
	l, s := relLum(col), saturation(col)
	alpha := float32(0.18)
	if dark {
		alpha = 0.24
		if l < 0.18 {
			col = mix(ui.RGB(255, 255, 255), col, 0.55*(0.18-l)/0.18+0.15)
		}
	} else if l > 0.55 {
		col = mix(ui.RGB(0, 0, 0), col, 0.45*(l-0.55)/0.45+0.1)
	}
	if s < 0.25 {
		alpha += (0.25 - s) * 0.4
	}
	return col, alpha
}

// relLum：sRGB 相对亮度（WCAG）。
func relLum(c ui.Color) float32 {
	ch := func(v uint8) float64 {
		x := float64(v) / 255
		if x <= 0.03928 {
			return x / 12.92
		}
		return math.Pow((x+0.055)/1.055, 2.4)
	}
	return float32(0.2126*ch(c.R) + 0.7152*ch(c.G) + 0.0722*ch(c.B))
}

// saturation：HSL 饱和度。
func saturation(c ui.Color) float32 {
	r, g, b := float32(c.R)/255, float32(c.G)/255, float32(c.B)/255
	hi, lo := max(r, g, b), min(r, g, b)
	if hi == lo {
		return 0
	}
	l := (hi + lo) / 2
	if l > 0.5 {
		return (hi - lo) / (2 - hi - lo)
	}
	return (hi - lo) / (hi + lo)
}

func tswNameWidth(c *ui.Context, name string) float32 {
	w, _ := c.MeasureText(0, ui.Span{Text: name, Font: fontSans, Size: 11, Weight: 600})
	return w
}

// targetSwitchWho：动画中的「图标 + 名字」整组，胶囊垫在后面。
func (a *app) targetSwitchWho(c *ui.Context, k tokens, el time.Duration) {
	name := func(f macos.FrontApp) string {
		if f.PID == 0 {
			return tr("未识别目标")
		}
		return f.Name
	}
	if c.Preferences().ReduceMotion {
		op := float32(el) / float32(tswReduced)
		a.targetIcon(c, k, a.target).Opacity(op)
		text(c, name(a.target), 11, 16, 600, k.fg).SingleLine().Opacity(op)
		return
	}
	ui.Row(c).Gap(6).AlignItems(ui.Center).Key("tsw-who").Children(func() {
		// 胶囊：0→22% 长出并横向拉宽、纵向压扁，50% 反向回弹且换成新主色，72% 归位，之后淡出
		p := tswStd(tswPhase(el, 0, tswTotal))
		offs := []float32{0, 0.22, 0.5, 0.72, 1}
		op := tswKey(p, offs, []float32{0, 1, 1, 1, 0})
		sx := tswKey(p, offs, []float32{0.9, 1.07, 0.97, 1, 1})
		sy := tswKey(p, offs, []float32{0.9, 0.84, 1.06, 1, 1})
		mixT := min(p/0.5, 1)
		fc, fa := capsuleTint(a.tswColor(k, a.tsw.from), k.dark)
		tc, ta := capsuleTint(a.tswColor(k, a.target), k.dark)
		col, alpha := mix(tc, fc, mixT), fa+(ta-fa)*mixT
		ui.Box(c).Absolute().Left(-6).Right(-5).Top(-4).Bottom(-4).Radius(12).PassThrough().
			Background(col.Alpha(alpha*op)).Scale(sx, sy)
		// 图标：旧图标 160ms 缩小淡出；新图标 150ms 起回弹弹入
		ui.Box(c).Size(16, 16).Key("tsw-icon").Children(func() {
			if q := tswIn(tswPhase(el, 0, 160*time.Millisecond)); q < 1 {
				s := 1 - 0.4*q
				ui.Box(c).Absolute().Top(0).Left(0).Children(func() { a.targetIcon(c, k, a.tsw.from).Scale(s, s).Opacity(1 - q) })
			}
			if q := tswPhase(el, 150*time.Millisecond, 440*time.Millisecond); q > 0 {
				s := 0.6 + 0.4*tswSpring(q)
				ui.Box(c).Absolute().Top(0).Left(0).Children(func() { a.targetIcon(c, k, a.target).Scale(s, s).Opacity(min(q*2.5, 1)) })
			}
		})
		// 名字：宽度 140ms 起按回弹曲线从旧名宽过渡到新名宽（文字按自身全宽排、横向裁切，随胶囊展开露出，不压住右侧「· 可发送」）；旧名上移淡出，新名自下浮入
		w0, w1 := tswNameWidth(c, name(a.tsw.from)), tswNameWidth(c, name(a.target))
		w := w0 + (w1-w0)*tswSpring(tswPhase(el, 140*time.Millisecond, 560*time.Millisecond))
		ui.Box(c).Width(max(w, 0)).Height(16).ClipX().Key("tsw-name").Children(func() {
			if q := tswIn(tswPhase(el, 0, 160*time.Millisecond)); q < 1 {
				text(c, name(a.tsw.from), 11, 16, 600, k.fg).SingleLine().Width(w0+1).Absolute().Left(0).Top(0).Translate(0, -4*q).Opacity(1 - q)
			}
			if q := tswOut(tswPhase(el, 200*time.Millisecond, 360*time.Millisecond)); q > 0 {
				text(c, name(a.target), 11, 16, 600, k.fg).SingleLine().Width(w1+1).Absolute().Left(0).Top(0).Translate(0, 4*(1-q)).Opacity(q)
			}
		})
	})
}
