package main

import (
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 主题（界面风格）是可插拔的：一个主题 = 一个实现 styleTheme 的类型，在 init 里 registerTheme。
// 共用界面代码不认识任何具体主题，只在固定的位置问当前主题（k.th / s.th / theme()）：
//
//   - 元信息：名称、说明、是否固定浅色 / 整窗不透明 / 直角窗、圆角缩放。
//   - 整块接管（返回 true 表示已画，调用方跳过默认画法）：主面板、设置窗外壳、详情窗标题栏、批量条……
//   - 外观修饰（在默认样式之后调用，改掉需要改的属性）：输入井、分段控件、卡片、浮层……
//
// 新主题嵌入 baseTheme，只覆写要改的方法；没覆写的保持「现代」外观。
// 「现代」本身不是注册的主题：没有主题生效时用 modernTheme（baseTheme 的零实现）。
// 存储沿用 Settings.ColorScheme：值是某个已注册主题的 ID 时该主题生效，否则是现代主题下的颜色名。
type styleTheme interface {
	// —— 元信息 ——
	ID() string    // 存进 Settings.ColorScheme 的值
	Label() string // 设置 →「主题」行里的名称（未翻译）
	Hint() string  // 选中时「主题」行的说明（未翻译）
	// FixedLight：恒为浅色，不跟随「模式」设置。
	FixedLight() bool
	// Opaque：整窗不透明——毛玻璃、内容底色浓度、卡片底色不透明度等设置不生效，对应设置行隐藏。
	Opaque() bool
	// SquareWindows：设置窗 / 详情窗不要系统标题栏与红绿灯，改直角窗，标题栏由主题自绘。
	SquareWindows() bool
	// RadiusScale：圆角档位的缩放（rr 用）；1 = 不变。
	RadiusScale() float32
	// ClassicScroll：列表右侧让出位置给主题自绘的滚动条。
	ClassicScroll() bool
	// Apply：设置变化时同步主题自己的细项（高亮色、滚动条款式等）。所有已注册主题都会收到。
	Apply(st store.Settings)
	// SettingsRows：主题自己的设置行，排在「主题」行之后。
	SettingsRows(a *app, c *ui.Context, k tokens, st store.Settings) []setRow

	// —— 设计变量 ——
	Tokens(base tokens) tokens                         // 在浅 / 深基础变量上改出本主题的变量
	SettingsTokens(base settingsTokens) settingsTokens // 设置窗变量
	LibTheme(t *ui.Theme) bool                         // 改库主题的副本（提示气泡 / 吐司底色等）；返回是否改了

	// —— 整块接管 ——
	Panel(a *app, c *ui.Context, k tokens) bool // 主面板竖栏布局（不含压在最上的浮层，见 panelView）
	SettingsShell(a *app, c *ui.Context, k tokens, s settingsTokens, pages []setPage) bool
	SettingsSection(c *ui.Context, k tokens, s settingsTokens, sec setSection) bool
	DetailHeader(a *app, c *ui.Context, k tokens, n store.Note) bool
	// DetailFrame：详情窗窗框。ok 时不画顶部晕光，over 在内容之后调用（压在最上的装饰）。
	DetailFrame(c *ui.Context) (over func(), ok bool)
	DetailChromePinned() bool // 详情窗标题栏常驻（不随指针进出显隐）
	// SelectionBar：批量条的容器（返回后由调用方填内容）。
	SelectionBar(c *ui.Context) (ui.Element, bool)
	// PreflightFrame：预检区的容器样式；sheet = 盖住整个面板的对话框形态。
	PreflightFrame(box ui.Element, sheet bool) bool
	Scrolled(c *ui.Context, s *ui.ScrollState, build func()) bool // 滚动区 + 主题自绘滚动条

	// —— 控件：整个替换 ——
	Tooltip(c *ui.Context, e ui.Element, s string) bool
	Button(c *ui.Context, label string) (ui.Element, bool)                              // 代替库的 ui.Button
	TextButton(c *ui.Context, label string) (clicked, ok bool)                          // 设置窗的文字按钮
	Popover(c *ui.Context, anchor ui.Element, open *bool, fn func()) (ui.Element, bool) // 代替库的 ui.Popover
	Segmented(c *ui.Context, sel *int, labels ...string) (changed, ok bool)
	Checkbox(c *ui.Context, on *bool) (changed, ok bool) // 设置窗的开关
	Slider(c *ui.Context, v *float64, lo, hi, step float64) (changed, ok bool)
	FloatIconButton(c *ui.Context, k tokens, key, icon, tip string, danger, on bool) (ui.Element, bool) // 卡面悬浮钮
	// IconFace：图标钮的静息 / 悬停 / 按下外观；返回图标颜色。
	IconFace(b ui.Element, rest, hot ui.Color, on bool) (ui.Color, bool)
	// PushButton：把已建好的元素画成文字推钮；返回文字颜色与字重。
	PushButton(b ui.Element) (fg ui.Color, weight int, ok bool)
	PopupButton(c *ui.Context, b ui.Element) bool                      // 推钮旁的下拉钮（连同里面的箭头）
	CheckGlyph(c *ui.Context, box ui.Element, on bool) bool            // 行内小勾选框
	KeyHint(c *ui.Context, label string, fg ui.Color) bool             // 菜单 / 命令面板里的键位提示
	MenuSeparator(c *ui.Context) bool                                  // 自绘菜单的分隔线
	SelectionGlow(c *ui.Context) bool                                  // 选中卡片的盖层
	Elevation(e ui.Element, pick func(string, ui.Color) ui.Color) bool // 悬停 / 选中抬升的阴影
	Etched(b ui.Element) bool                                          // 分块卡的蚀刻框（否则画半透明卡底）
	SelectTrigger(b ui.Element) bool                                   // 自绘下拉的触发钮（ok 时不画悬停底）

	// —— 控件：在默认样式之后修饰 ——
	Well(e ui.Element)        // 输入框 / 文本域
	SearchRow(row ui.Element) // 面板搜索框
	SegTrack(e ui.Element)    // 分段控件的槽
	SegThumb(e ui.Element)    // 分段控件的选中块
	OptionChip(b ui.Element)  // 可选档位小胶囊
	Card(box ui.Element, checked bool)
	CardOutline(c *ui.Context) // 卡片内容之上的描边
	CardHead(head ui.Element)  // 卡片通栏
	ListRow(card ui.Element)   // 任务行 / 横栏任务瓷砖
	DefaultRing(c *ui.Context) // 默认动作钮外的一圈（在按钮的 Children 里调用）
	PanelMenu(menu ui.Element) // ☰ 面板菜单的浮层
	LensDetail(box ui.Element) // 发送详情展开区
	LensButton(btn ui.Element) // 发送详情里的方案钮

	// —— 取值 ——
	SheetBg() (ui.Color, bool)                                                // 盖住整窗的浮层底色
	FloatSurface(b ui.Element) (ui.Element, bool)                             // 浮层底
	Line() (ui.Color, bool)                                                   // 分隔线颜色
	MenuItem(row ui.Element, kind string, active bool) (fg ui.Color, ok bool) // kind: menu | command；ok = 当前项，文字用 fg
	Highlight() (bg, fg ui.Color, ok bool)                                    // 高亮底色与其上的文字色
	SelectedRow(box ui.Element) (ui.Color, bool)                              // 紧凑行选中底色
	BandColors(from, to ui.Color, checked bool) (ui.Color, ui.Color)
	TintBand(band ui.Color) (ui.Color, bool) // 分组色通栏的混色
	CardRadius(r float32) float32            // 卡片圆角

	// —— HUD ——
	HudColors() (paper, ink, ghost ui.Color, ok bool)
	HudPill(e ui.Element) bool
	HudBalloon(e ui.Element) bool
	HudTail(c *ui.Context) bool
}

// styleThemes：已注册的主题；styleThemeOrder 是设置里的排列顺序（注册顺序）。
var (
	styleThemes     = map[string]styleTheme{}
	styleThemeOrder []string
	modernTheme     styleTheme = baseTheme{}
)

func registerTheme(t styleTheme) {
	if _, dup := styleThemes[t.ID()]; dup {
		panic("重复注册主题：" + t.ID())
	}
	styleThemes[t.ID()] = t
	styleThemeOrder = append(styleThemeOrder, t.ID())
}

// themeFor：scheme（Settings.ColorScheme）对应的主题；不是主题 ID 时为现代主题。
func themeFor(scheme string) styleTheme {
	if t, ok := styleThemes[scheme]; ok {
		return t
	}
	return modernTheme
}

// theme：当前主题（随 curScheme）。
func theme() styleTheme { return themeFor(curScheme) }

// isTheme：scheme 是不是某个主题的 ID（否则是现代主题下的颜色）。
func isTheme(scheme string) bool { _, ok := styleThemes[scheme]; return ok }

// baseTheme：styleTheme 的零实现——什么都不接管、不修饰，即「现代」外观。新主题嵌入它。
type baseTheme struct{}

func (baseTheme) ID() string              { return "" }
func (baseTheme) Label() string           { return "现代" }
func (baseTheme) Hint() string            { return "" }
func (baseTheme) FixedLight() bool        { return false }
func (baseTheme) Opaque() bool            { return false }
func (baseTheme) SquareWindows() bool     { return false }
func (baseTheme) RadiusScale() float32    { return 1 }
func (baseTheme) ClassicScroll() bool     { return false }
func (baseTheme) Apply(store.Settings)    {}
func (baseTheme) LibTheme(*ui.Theme) bool { return false }
func (baseTheme) SettingsRows(*app, *ui.Context, tokens, store.Settings) []setRow {
	return nil
}
func (baseTheme) Tokens(base tokens) tokens                         { return base }
func (baseTheme) SettingsTokens(base settingsTokens) settingsTokens { return base }

func (baseTheme) Panel(*app, *ui.Context, tokens) bool { return false }
func (baseTheme) SettingsShell(*app, *ui.Context, tokens, settingsTokens, []setPage) bool {
	return false
}
func (baseTheme) SettingsSection(*ui.Context, tokens, settingsTokens, setSection) bool { return false }
func (baseTheme) DetailHeader(*app, *ui.Context, tokens, store.Note) bool              { return false }
func (baseTheme) DetailFrame(*ui.Context) (func(), bool)                               { return nil, false }
func (baseTheme) DetailChromePinned() bool                                             { return false }
func (baseTheme) SelectionBar(*ui.Context) (ui.Element, bool)                          { return ui.Element{}, false }
func (baseTheme) PreflightFrame(ui.Element, bool) bool                                 { return false }
func (baseTheme) Scrolled(*ui.Context, *ui.ScrollState, func()) bool                   { return false }

func (baseTheme) Tooltip(*ui.Context, ui.Element, string) bool        { return false }
func (baseTheme) Button(*ui.Context, string) (ui.Element, bool)       { return ui.Element{}, false }
func (baseTheme) TextButton(*ui.Context, string) (bool, bool)         { return false, false }
func (baseTheme) Segmented(*ui.Context, *int, ...string) (bool, bool) { return false, false }
func (baseTheme) Checkbox(*ui.Context, *bool) (bool, bool)            { return false, false }
func (baseTheme) Popover(*ui.Context, ui.Element, *bool, func()) (ui.Element, bool) {
	return ui.Element{}, false
}
func (baseTheme) Slider(*ui.Context, *float64, float64, float64, float64) (bool, bool) {
	return false, false
}
func (baseTheme) FloatIconButton(*ui.Context, tokens, string, string, string, bool, bool) (ui.Element, bool) {
	return ui.Element{}, false
}
func (baseTheme) IconFace(ui.Element, ui.Color, ui.Color, bool) (ui.Color, bool) {
	return ui.Color{}, false
}
func (baseTheme) PushButton(ui.Element) (ui.Color, int, bool)                { return ui.Color{}, 0, false }
func (baseTheme) PopupButton(*ui.Context, ui.Element) bool                   { return false }
func (baseTheme) CheckGlyph(*ui.Context, ui.Element, bool) bool              { return false }
func (baseTheme) KeyHint(*ui.Context, string, ui.Color) bool                 { return false }
func (baseTheme) MenuSeparator(*ui.Context) bool                             { return false }
func (baseTheme) SelectionGlow(*ui.Context) bool                             { return false }
func (baseTheme) Elevation(ui.Element, func(string, ui.Color) ui.Color) bool { return false }
func (baseTheme) Etched(ui.Element) bool                                     { return false }
func (baseTheme) SelectTrigger(ui.Element) bool                              { return false }

func (baseTheme) Well(ui.Element)         {}
func (baseTheme) SearchRow(ui.Element)    {}
func (baseTheme) SegTrack(ui.Element)     {}
func (baseTheme) SegThumb(ui.Element)     {}
func (baseTheme) OptionChip(ui.Element)   {}
func (baseTheme) Card(ui.Element, bool)   {}
func (baseTheme) CardOutline(*ui.Context) {}
func (baseTheme) CardHead(ui.Element)     {}
func (baseTheme) ListRow(ui.Element)      {}
func (baseTheme) DefaultRing(*ui.Context) {}
func (baseTheme) PanelMenu(ui.Element)    {}
func (baseTheme) LensDetail(ui.Element)   {}
func (baseTheme) LensButton(ui.Element)   {}

func (baseTheme) SheetBg() (ui.Color, bool)                          { return ui.Color{}, false }
func (baseTheme) FloatSurface(b ui.Element) (ui.Element, bool)       { return b, false }
func (baseTheme) Line() (ui.Color, bool)                             { return ui.Color{}, false }
func (baseTheme) MenuItem(ui.Element, string, bool) (ui.Color, bool) { return ui.Color{}, false }
func (baseTheme) Highlight() (ui.Color, ui.Color, bool)              { return ui.Color{}, ui.Color{}, false }
func (baseTheme) SelectedRow(ui.Element) (ui.Color, bool)            { return ui.Color{}, false }
func (baseTheme) BandColors(from, to ui.Color, _ bool) (ui.Color, ui.Color) {
	return from, to
}
func (baseTheme) TintBand(ui.Color) (ui.Color, bool) { return ui.Color{}, false }
func (baseTheme) CardRadius(r float32) float32       { return r }

func (baseTheme) HudColors() (ui.Color, ui.Color, ui.Color, bool) {
	return ui.Color{}, ui.Color{}, ui.Color{}, false
}
func (baseTheme) HudPill(ui.Element) bool    { return false }
func (baseTheme) HudBalloon(ui.Element) bool { return false }
func (baseTheme) HudTail(*ui.Context) bool   { return false }

func init() { // 不经 tok() 直接拿基础变量的地方也有主题可问
	lightTokens.th, darkTokens.th = modernTheme, modernTheme
}
