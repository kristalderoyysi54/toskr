package main

import (
	_ "embed"
	"math"
	"sync"

	"github.com/egoist/mygo/ui"
)

// 设计变量逐项取自 Tauri 版 index.css 的计算值（浏览器实测导出，见 tasks/mygo-report）。
// 颜色保留 oklch 原值，运行时换算到 sRGB，便于与 CSS 逐字对照。

//go:embed resources/fonts/Geist-Variable.ttf
var geistTTF []byte

const fontSans = "Geist, PingFang SC, Hiragino Sans GB, Helvetica Neue"
const fontMono = "SF Mono, JetBrains Mono, Menlo, monospace"

var fontOnce sync.Once

func registerFonts() {
	fontOnce.Do(func() { _ = ui.RegisterFont(geistTTF, "Geist") })
}

// oklch 把 CSS oklch(L C H / A) 换算为 sRGB（CSS Color 4 公式，越界钳制）。
func oklch(l, c, h, a float64) ui.Color {
	hr := h * math.Pi / 180
	A, B := c*math.Cos(hr), c*math.Sin(hr)
	l_ := l + 0.3963377774*A + 0.2158037573*B
	m_ := l - 0.1055613458*A - 0.0638541728*B
	s_ := l - 0.0894841775*A - 1.2914855480*B
	L, M, S := l_*l_*l_, m_*m_*m_, s_*s_*s_
	r := 4.0767416621*L - 3.3077115913*M + 0.2309699292*S
	g := -1.2684380046*L + 2.6097574011*M - 0.3413193965*S
	b := -0.0041960863*L - 0.7034186147*M + 1.7076147010*S
	enc := func(x float64) uint8 {
		if x <= 0.0031308 {
			x *= 12.92
		} else {
			x = 1.055*math.Pow(x, 1/2.4) - 0.055
		}
		return uint8(math.Round(math.Max(0, math.Min(1, x)) * 255))
	}
	return ui.RGBA(enc(r), enc(g), enc(b), float32(a))
}

func gray(l, a float64) ui.Color { return oklch(l, 0, 0, a) }

func srgbf(r, g, b float64) ui.Color {
	return ui.RGB(uint8(math.Round(r*255)), uint8(math.Round(g*255)), uint8(math.Round(b*255)))
}

// tokens 是一种配色下的全部设计变量。
type tokens struct {
	dark                                   bool
	window                                 ui.Color // 面板底（叠在系统模糊材质上）
	fg, muted                              ui.Color
	track                                  ui.Color // 分段控件槽、输入框底
	pill                                   ui.Color // 分段控件选中块
	pillShadow                             ui.Color
	pillHighlight                          ui.Color // 选中块顶部内高光（仅浅色）
	chip                                   ui.Color // 目标应用图标底
	ok                                     ui.Color // 「可发送」绿点
	card                                   ui.Color
	cardHeadFrom, cardHeadTo               ui.Color // 卡片标题条（浅色为 135° 渐变，深色为纯色）
	cardHeadText                           ui.Color
	floatBtn                               ui.Color // 卡片悬浮操作钮
	floatBorder                            ui.Color
	floatShadowA, floatShadowB, floatInset ui.Color
	inputBorder                            ui.Color
	insetShadow                            ui.Color
	codeKeyword, codeString, codeNumber    ui.Color
	// 任务页语义色（--destructive 与 tailwind amber/teal/violet 色阶）
	danger, amberBar, amberText, tealBar ui.Color
	repeatIcon, violetText, violetIcon   ui.Color
	sparkRow, laterChip                  ui.Color
	bandLine                             ui.Color // 剪贴页分段头细线
	pressed                              ui.Color // 浮钮按下态（如已置顶）
}

func init() {
	amber, teal, violet := oklch(0.769, 0.188, 70.08, 1), oklch(0.704, 0.14, 182.503, 1), oklch(0.606, 0.25, 292.717, 1)
	l, d := &lightTokens, &darkTokens
	l.danger, d.danger = oklch(0.577, 0.245, 27.325, 1), oklch(0.704, 0.191, 22.216, 1)
	l.amberBar, d.amberBar = amber, amber
	l.tealBar, d.tealBar = teal, teal
	l.violetIcon, d.violetIcon = violet, violet
	l.amberText, d.amberText = oklch(0.666, 0.179, 58.318, 1), oklch(0.828, 0.189, 84.429, 1)
	l.repeatIcon, d.repeatIcon = oklch(0.6, 0.118, 184.704, 1), oklch(0.777, 0.152, 181.912, 1)
	l.violetText, d.violetText = oklch(0.541, 0.281, 293.009, 1), oklch(0.702, 0.183, 293.541, 1)
	l.sparkRow, d.sparkRow = ui.RGB(245, 243, 255), ui.RGBA(167, 139, 250, 0.1)
	l.laterChip, d.laterChip = gray(0, 0.06), gray(1, 0.1)
	l.bandLine, d.bandLine = gray(0.922, 0.6), gray(1, 0.06)
	l.pressed, d.pressed = gray(0, 0.05), gray(1, 0.1)
}

var (
	lightTokens = tokens{
		window: ui.RGBA(252, 252, 252, 0.62), fg: gray(0.145, 1), muted: gray(0.51, 1),
		track: gray(0, 0.04), pill: gray(1, 1), pillShadow: gray(0, 0.14), pillHighlight: gray(1, 0.45),
		chip: gray(0.97, 1), ok: oklch(0.696, 0.17, 162.48, 1),
		card:         ui.RGB(255, 255, 255),
		cardHeadFrom: srgbf(0.558196, 0.585176, 0.639137), cardHeadTo: srgbf(0.447373, 0.476235, 0.533961), cardHeadText: ui.RGB(255, 255, 255),
		floatBtn: gray(1, 1), floatBorder: gray(0.145, 0.1), floatShadowA: gray(0, 0.08), floatShadowB: gray(0, 0.12), floatInset: gray(1, 0.4),
		inputBorder: gray(0, 0.1), insetShadow: gray(0, 0.05),
		codeKeyword: ui.RGB(166, 38, 164), codeString: ui.RGB(20, 133, 106), codeNumber: ui.RGB(183, 107, 1),
	}
	darkTokens = tokens{
		dark:   true,
		window: ui.RGBA(15, 15, 15, 0.557), fg: gray(0.985, 1), muted: gray(0.72, 1),
		track: gray(1, 0.06), pill: gray(0.38, 1), pillShadow: gray(0, 0.4),
		chip: gray(0.269, 1), ok: oklch(0.696, 0.17, 162.48, 1),
		card:         ui.RGB(39, 39, 42),
		cardHeadFrom: srgbf(0.201324, 0.210126, 0.227696), cardHeadTo: srgbf(0.201324, 0.210126, 0.227696), cardHeadText: gray(0.985, 1),
		floatBtn: gray(0.205, 1), floatBorder: gray(0.985, 0.1), floatShadowA: gray(0, 0.35), floatShadowB: gray(0, 0.45), floatInset: gray(1, 0.08),
		inputBorder: gray(1, 0.1), insetShadow: gray(0, 0.35),
		codeKeyword: ui.RGB(210, 168, 255), codeString: ui.RGB(126, 231, 135), codeNumber: ui.RGB(255, 166, 87),
	}
)

func tok(c *ui.Context) tokens {
	if c.Theme().Dark {
		return darkTokens
	}
	return lightTokens
}

var iconCache = map[string]*ui.SVG{}

// lucideIcon 返回与 Tauri 版同源的 lucide 图标（24 viewBox，描边 2，currentColor）。
func lucideIcon(name string) *ui.SVG {
	if s, ok := iconCache[name]; ok {
		return s
	}
	body, ok := lucide[name]
	if !ok {
		panic("缺少 lucide 图标：" + name)
	}
	s := svg(body)
	iconCache[name] = s
	return s
}

// licon 画一个 size×size 的 lucide 图标。
func licon(c *ui.Context, name string, size float32, color ui.Color) ui.Element {
	return ui.Icon(c, lucideIcon(name)).Size(size, size).TextColor(color)
}

// liconFilled 画实心版 lucide 图标（对应 Tauri 的 fill-current 类，如置顶图钉）。
func liconFilled(c *ui.Context, name string, size float32, color ui.Color) ui.Element {
	key := name + "#fill"
	s, ok := iconCache[key]
	if !ok {
		lucideIcon(name) // 名称校验
		s = svg(`<g fill="currentColor">` + lucide[name] + `</g>`)
		iconCache[key] = s
	}
	return ui.Icon(c, s).Size(size, size).TextColor(color)
}

// amber400 是置顶图钉色（tailwind amber-400，两种配色同值）。
var amber400 = oklch(0.828, 0.189, 84.429, 1)

// text 按 Tauri 的字阶设置字号、字重与固定行高。
func text(c *ui.Context, s string, size, lineHeight float32, weight int, color ui.Color) ui.Element {
	return ui.Text(c, s).Font(fontSans).FontSize(size).FixedLineHeight(lineHeight).FontWeight(weight).TextColor(color)
}
