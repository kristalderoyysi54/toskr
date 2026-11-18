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
	tweenSlow    = tw(280, easeStandard) // --duration-slow 280ms（笔记分组侧栏展开收起）
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

// swapView 给「同一位置换内容」的容器（子页签、筛选、视图切换、设置页）加进场：新内容从切换方向 10pt 外横移淡入
// （180ms ease-standard），旧内容直接让位——旧版旧内容原地淡出，与新内容叠在一起成重影（用户 2026-11-09 定为
// 剪贴视图切换同款）；减弱动效时 mygo 只保留淡入。容器内不要放切换器本身，否则滑块的共享布局动画会被一起重挂打断。
// Tauri 只有顶层页签有 PageSlide、其余瞬切；用户 2026-11-06 要求所有切换统一带过渡。
func (a *app) swapView(e ui.Element, group string, idx int) ui.Element {
	return e.Key(group + "-" + itoa(idx)).Transition(a.swapTransition(group, idx))
}

func (a *app) swapTransition(group string, idx int) ui.ElementTransition {
	if a.swapIdx == nil {
		a.swapIdx = map[string]int{}
	}
	dx := float32(0)
	if prev, ok := a.swapIdx[group]; ok && prev != idx {
		dx = 10 * sign(idx-prev)
	}
	a.swapIdx[group] = idx
	return ui.ElementTransition{Duration: 180 * time.Millisecond, Ease: easeStandard, Colors: true, Enter: &ui.Motion{X: dx}}
}

// foldTransition：分组折叠 / 展开时内容沿纵向收拢并淡出、展开时反向（200ms ease-standard）；减弱动效时只淡入淡出。
var foldTransition = ui.ElementTransition{Duration: 200 * time.Millisecond, Ease: easeStandard, Colors: true,
	Enter: &ui.Motion{Collapse: true}, Exit: &ui.Motion{Collapse: true}}

// reduceMotionPref：设置 → 「减弱动态效果」总开关（reload 时从设置同步）。
var reduceMotionPref bool

// reduceMotion：本帧按「减弱动态效果」画——应用里的总开关或系统的同名设置。各处自绘动效（跑马灯、呼吸、轮播）读它。
func reduceMotion(c *ui.Context) bool { return reduceMotionPref || c.Preferences().ReduceMotion }

// motionGate：总开关开着时，本帧所有补间 / 弹簧 / 进出场过渡直接到位（加载转圈这类循环动画照常）。每个窗口每帧取配色时调用。
func motionGate(c *ui.Context) {
	if reduceMotionPref {
		c.DisableAnimations()
	}
}

// foldSlide：分组展开时框里的内容从区头下面向下滑出并淡入、折叠时反向（外层裁切窗用 foldTransition 同步放开高度）。
var foldSlide = ui.ElementTransition{Duration: 200 * time.Millisecond, Ease: easeStandard, Colors: true,
	Enter: &ui.Motion{Y: -14}, Exit: &ui.Motion{Y: -14}}

// foldFolder：分组头的小文件夹（用户 2026-11-18：代替折叠箭头）。合上 = 带浅底的文件夹，展开 = 打开的文件夹；
// 两个图标叠放，切换时一个弹出一个缩回（springControl），不是瞬切。
// peek：卡片正拖在合上的分组头上——文件夹先打开并放大一点，表示松手会放进去。
func foldFolder(c *ui.Context, collapsed, peek bool, size float32, col ui.Color) {
	collapsed = collapsed && !peek
	ui.Box(c).Size(size, size).Key("fold-folder").Children(func() {
		layer := func(key string, show bool, tilt float32, draw func()) {
			b := ui.Box(c).Absolute().Left(0).Top(0).Size(size, size).Center().PassThrough().Key(key).TransformOrigin(0.5, 1)
			pose := ui.Pose{Scale: 0.7, Rotate: tilt}
			if show {
				pose = ui.Pose{Scale: map[bool]float32{true: 1.2, false: 1}[peek]}
			}
			b.AnimatePose(pose, springControl)
			b.Opacity(b.AnimateTo("op", map[bool]float32{true: 1}[show], tweenControl))
			b.Children(draw)
		}
		layer("shut", collapsed, 8, func() {
			liconFilled(c, "folder", size, col.Alpha(0.22)).Absolute().Left(0).Top(0)
			licon(c, "folder", size, col)
		})
		layer("open", !collapsed, -8, func() { licon(c, "folder-open", size, col) })
	})
}

// foldChevron：折叠箭头随状态转 -90°（springControl），代替换图标的瞬切。
func foldChevron(c *ui.Context, k tokens, collapsed bool) {
	foldChevronSized(c, collapsed, 12, k.muted)
}

func foldChevronSized(c *ui.Context, collapsed bool, size float32, col ui.Color) {
	rot := float32(0)
	if collapsed {
		rot = -90
	}
	ic := ui.Box(c).Size(size, size).Center()
	ic.AnimatePose(ui.Pose{Rotate: rot}, springControl).Children(func() { licon(c, "chevron-down", size, col) })
}
