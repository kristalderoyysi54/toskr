package main

import (
	"time"

	"github.com/egoist/mygo/ui"
)

// 动效常量逐条照抄 Tauri：src/lib/motion.ts（motion 弹簧 / 补间）与 index.css 的 --duration-* / --ease-*，
// 以及 Tailwind v4 的默认过渡（150ms cubic-bezier(0.4,0,0.2,1)）。motion 的 easeIn / easeInOut 是三次贝塞尔，
// 与 mygo 自带的同名三次多项式不同，这里一律用 CubicBezier 精确复现。
var (
	easeStandard = ui.CubicBezier(0.2, 0.9, 0.3, 1)   // --ease-standard / tweenMenu / tweenOverlay / tweenValue
	easePop      = ui.CubicBezier(0.2, 0.9, 0.3, 1.2) // --ease-pop（开关滑块，带回弹）
	easeTw       = ui.CubicBezier(0.4, 0, 0.2, 1)     // Tailwind 默认 transition
	easePulse    = ui.CubicBezier(0.4, 0, 0.6, 1)     // Tailwind animate-pulse
	easeMIn      = ui.CubicBezier(0.42, 0, 1, 1)      // motion "easeIn"
	easeMInOut   = ui.CubicBezier(0.42, 0, 0.58, 1)   // motion "easeInOut"（只给 duration 的补间默认值）
	easeMOut     = ui.CubicBezier(0, 0, 0.58, 1)      // motion "easeOut" = CSS ease-out（捕获闪烁）
	easeCSS      = ui.CubicBezier(0.25, 0.1, 0.25, 1) // CSS ease（tw-animate-css 默认、dnd-kit）

	springSnappy  = ui.Animation{Spring: ui.SpringOptions{Stiffness: 480, Damping: 40}}             // 面板显隐、换页、详情正文
	springControl = ui.Animation{Spring: ui.SpringOptions{Stiffness: 600, Damping: 42, Mass: 0.65}} // 页签胶囊、分段滑块、下划线
	springModal   = ui.Animation{Spring: ui.SpringOptions{Stiffness: 500, Damping: 38}}             // 预览、更新弹窗

	tweenExit    = tw(140, easeMIn)      // 面板收起
	tweenFade    = tw(120, easeMInOut)   // 秘文遮罩
	tweenMenu    = tw(120, easeStandard) // HUD 关闭、任务展开、秘文淡出
	tweenOverlay = tw(160, easeStandard) // HUD 进入、浮层（--duration-overlay）
	tweenControl = tw(100, easeTw)       // duration-(--duration-control) 的颜色 / 透明度
	tweenTw      = tw(150, easeTw)       // Tailwind 默认 transition
	tweenKnob    = tw(180, easePop)      // 开关滑块
)

func tw(ms int, e ui.Easing) ui.Animation {
	return ui.Animation{Duration: time.Duration(ms) * time.Millisecond, Ease: e}
}

// fadeColor 让元素的底色按 a 过渡（CSS transition-colors）；key 区分同一元素上的多个颜色。
func fadeColor(e ui.Element, key string, to ui.Color, a ui.Animation) ui.Element {
	return e.Background(e.AnimateColor(key, to, a))
}

// Shared-layout 指示器（motion layoutId）的身份：同一 id 的元素在两帧间换了位置时从旧位置滑过去。
type layoutID struct{ name string }

// pressScale：按下时的 active:scale-[…]。
func pressScale(pressed bool, s float32) float32 {
	if pressed {
		return s
	}
	return 1
}

// pressY：Button 的 active:translate-y-[0.5px]。
func pressY(pressed bool) float32 {
	if pressed {
		return 0.5
	}
	return 0
}

// mixColor 在 a、b 之间按 t 线性插值（sRGB 分量）。
func mixColor(a, b ui.Color, t float32) ui.Color {
	l := func(x, y uint8) uint8 { return uint8(float32(x) + (float32(y)-float32(x))*t + 0.5) }
	return ui.RGBA(l(a.R, b.R), l(a.G, b.G), l(a.B, b.B), float32(l(a.A, b.A))/255)
}

// overThumb 画压在共享布局滑块之上的标签：mygo 的绝对定位元素总在流内兄弟之上，
// 所以流内只放一份不可见的占位撑开尺寸，可见的一份绝对定位、排在滑块之后。
func overThumb(c *ui.Context, content func()) {
	ui.Box(c).Invisible().Children(content)
	ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Center().Children(content)
}
