package main

import (
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 配色方案按 Tauri index.css 的 data-theme 段复刻：纸墨 / 抹茶 / 樱粉固定浅色，雾蓝跟随主题，
// Platinum 固定浅色且整窗不透明。色值取自浏览器实测导出（同一组数据下与默认方案逐元素比对得出的映射）。

var schemeNames = []string{"default", "platinum", "paper", "matcha", "sakura", "fog"}
var schemeLabels = []string{"Toskr", "Platinum", "纸墨", "抹茶", "樱粉", "雾蓝"}

// curScheme 是当前配色方案（主线程读写；applyAppearance 设置）。
var curScheme = "default"

// fixedLight：不跟随「主题」设置、恒为浅色的方案。
func fixedLight(scheme string) bool {
	switch scheme {
	case "paper", "matcha", "sakura", "platinum":
		return true
	}
	return false
}

// appLive：应用已在运行（main 设置）。无头视图测试里 mygo.Theme.SetSource 会永久阻塞，只在运行时调用。
var appLive bool

// applyAppearance 应用主题与配色方案：固定浅色的方案强制浅色外观，其余按「主题」设置。
func applyAppearance(st store.Settings) {
	curScheme = st.ColorScheme
	if curScheme == "" {
		curScheme = "default"
	}
	setPlatinumDetail(st.PtHighlight, st.PtScrollbar)
	cardAlpha = float32(st.CardAlpha())
	if !appLive {
		return
	}
	theme := st.Theme
	if fixedLight(curScheme) {
		theme = "light"
	}
	switch theme {
	case "light":
		mygo.Theme.SetSource(mygo.ThemeLight)
	case "dark":
		mygo.Theme.SetSource(mygo.ThemeDark)
	default:
		mygo.Theme.SetSource(mygo.ThemeSystem)
	}
}

type schemePalette struct {
	window, fg, muted, chip, card, cardBottom, ok ui.Color
	head, headText                                ui.Color // head 为零值时保留默认通栏渐变
	pill                                          ui.Color // 零值 = card
	keepOK                                        bool
}

var schemes = map[string]schemePalette{
	"paper": {window: ui.RGBA(247, 242, 232, 0.62), fg: ui.RGB(42, 38, 32), muted: ui.RGB(110, 99, 83), chip: ui.RGB(236, 228, 212),
		card: ui.RGB(255, 252, 245), cardBottom: ui.RGB(248, 241, 227), ok: ui.RGB(79, 122, 58),
		head: srgbf(0.836784, 0.800627, 0.731529), headText: ui.RGB(74, 58, 40)},
	"matcha": {window: ui.RGBA(238, 241, 232, 0.62), fg: ui.RGB(35, 42, 32), muted: ui.RGB(85, 96, 80), chip: ui.RGB(228, 233, 220),
		card: ui.RGB(251, 252, 248), cardBottom: ui.RGB(244, 247, 239), keepOK: true,
		head: srgbf(0.524706, 0.608235, 0.50902), headText: ui.RGB(255, 255, 255)},
	"sakura": {window: ui.RGBA(251, 240, 242, 0.62), fg: ui.RGB(43, 31, 35), muted: ui.RGB(110, 87, 93), chip: ui.RGB(246, 230, 234),
		card: ui.RGB(255, 255, 255), cardBottom: ui.RGB(252, 244, 246), keepOK: true,
		head: srgbf(0.738824, 0.572549, 0.64902), headText: ui.RGB(255, 255, 255)},
	"fog": {window: ui.RGBA(229, 233, 240, 0.62), fg: ui.RGB(46, 52, 64), muted: ui.RGB(76, 86, 106), chip: ui.RGB(226, 230, 238),
		card: ui.RGB(248, 249, 251), cardBottom: ui.RGB(240, 243, 247), ok: ui.RGB(106, 138, 82)},
	"fog-dark": {window: ui.RGBA(43, 48, 59, 0.557), fg: ui.RGB(229, 233, 240), muted: ui.RGB(163, 171, 186), chip: ui.RGB(59, 66, 82),
		card: ui.RGB(53, 59, 72), cardBottom: ui.RGB(48, 54, 66), ok: ui.RGB(163, 190, 140), pill: ui.RGB(76, 86, 106),
		head: srgbf(0.285804, 0.311529, 0.365804), headText: gray(0.985, 1)},
}

// schemed 把当前配色方案叠到基础设计变量上。
func schemed(t tokens) tokens {
	name := curScheme
	if name == "fog" && t.dark {
		name = "fog-dark"
	}
	if name == "platinum" {
		return platinumTokens(t)
	}
	p, ok := schemes[name]
	if !ok {
		return t
	}
	t.window, t.fg, t.muted, t.chip = p.window, p.fg, p.muted, p.chip
	t.card, t.cardBottom, t.floatBtn = p.card, p.cardBottom, p.card
	t.pill = p.card
	if p.pill != (ui.Color{}) {
		t.pill = p.pill
	}
	if !p.keepOK {
		t.ok = p.ok
	}
	if p.head != (ui.Color{}) {
		t.cardHeadFrom, t.cardHeadTo, t.cardHeadText = p.head, p.head, p.headText
	}
	if t.dark {
		t.floatBorder = p.fg.Alpha(0.1)
	}
	return t
}

// cardFill 给卡片铺底：方案带底部渐变时为 155° 的 card → card(52%) → cardBottom。
func cardFill(e ui.Element, k tokens) ui.Element {
	card, bottom := k.card, k.cardBottom
	if cardAlpha < 1 && !k.pt { // 卡片底色不透明度（Tauri cardOpacity）
		card, bottom = card.Alpha(cardAlpha), bottom.Alpha(cardAlpha)
	}
	if k.cardBottom == (ui.Color{}) {
		return e.Background(card)
	}
	return e.LinearGradient(ui.LinearGradient{From: card, To: bottom, Angle: 155, Start: 0.52, End: 1})
}

// cardAlpha：卡片底色不透明度，applyAppearance 写入（同 curScheme 的做法）。
var cardAlpha float32 = 1

// 设置窗的方案色：Tauri 设置页直接用 --background / --card / --muted / --border / --primary / 开关与按钮 token。
type setPalette struct {
	bg, card, muted, border, primary, toggleOff, toggleOffBorder, btn, btnBorder, knobOff, knobOn ui.Color
	btnFg                                                                                         ui.Color // 零值保留
	btnHover                                                                                      ui.Color
}

func hex(v uint32) ui.Color { return ui.RGB(uint8(v>>16), uint8(v>>8), uint8(v)) }

var setSchemes = map[string]setPalette{
	"paper":  {bg: hex(0xf7f2e8), card: hex(0xfffcf5), muted: hex(0xece4d4), border: hex(0xe3d9c7), primary: hex(0x8a5a2b), toggleOff: hex(0xe2d8c6), toggleOffBorder: hex(0xd6cab4), btn: hex(0xfffcf5), btnBorder: hex(0xd6cab4), knobOff: hex(0xf7f2e8), knobOn: hex(0xf7f2e8), btnHover: hex(0xf3ecdd)},
	"matcha": {bg: hex(0xf2f4ee), card: hex(0xfbfcf8), muted: hex(0xe4e9dc), border: hex(0xdde3d4), primary: hex(0x4f7a3a), toggleOff: hex(0xd7dfcc), toggleOffBorder: hex(0xcfd8c3), btn: hex(0xfbfcf8), btnBorder: hex(0xcfd8c3), knobOff: hex(0xf2f4ee), knobOn: hex(0xf2f4ee), btnHover: hex(0xeef1e8)},
	"sakura": {bg: hex(0xfdf6f7), card: hex(0xffffff), muted: hex(0xf6e6ea), border: hex(0xf0dfe3), primary: hex(0xc2547a), toggleOff: hex(0xefdbe0), toggleOffBorder: hex(0xead0d7), btn: hex(0xffffff), btnBorder: hex(0xead0d7), knobOff: hex(0xfdf6f7), knobOn: hex(0xfdf6f7), btnHover: hex(0xfbf0f2)},
	"fog":    {bg: hex(0xeceff4), card: hex(0xf8f9fb), muted: hex(0xe2e6ee), border: hex(0xd8dee9), primary: hex(0x5e81ac), toggleOff: hex(0xd8dee9), toggleOffBorder: hex(0xcdd4e0), btn: hex(0xf8f9fb), btnBorder: hex(0xcdd4e0), knobOff: hex(0xeceff4), knobOn: hex(0xeceff4), btnHover: hex(0xe5e9f0)},
	"fog-dark": {bg: hex(0x2b303b), card: hex(0x353b48), muted: hex(0x3b4252), border: ui.RGBA(229, 233, 240, 0.1), primary: hex(0x88c0d0), toggleOff: hex(0x4c566a), toggleOffBorder: ui.RGBA(229, 233, 240, 0.12),
		btn: hex(0xd8dee9), btnFg: hex(0x2b303b), btnBorder: ui.RGBA(229, 233, 240, 0.08), knobOff: hex(0xe5e9f0), knobOn: hex(0x1f242d), btnHover: hex(0xc8d0dc)},
}

func setSchemed(s settingsTokens, dark bool) settingsTokens {
	name := curScheme
	if name == "fog" && dark {
		name = "fog-dark"
	}
	if name == "platinum" {
		return platinumSet()
	}
	p, ok := setSchemes[name]
	if !ok {
		return s
	}
	s.bg, s.input, s.card = p.bg, p.bg, p.card
	s.aside = p.muted.Alpha(0.4)
	s.asideBorder, s.cardBorder, s.rowBorder, s.inputBorder = p.border.Alpha(0.6), p.border.Alpha(0.6), p.border.Alpha(0.5), p.border
	s.primary, s.navSel, s.navSelBorder = p.primary, p.primary.Alpha(0.1), p.primary.Alpha(0.5)
	s.toggleOff, s.toggleOffBorder = p.toggleOff, p.toggleOffBorder
	s.btn, s.btnBorder = p.btn, p.btnBorder
	if p.btnFg != (ui.Color{}) {
		s.btnFg = p.btnFg
	}
	s.knob, s.knobOn, s.btnHover = p.knobOff, p.knobOn, p.btnHover
	return s
}
