package main

import (
	"bytes"
	"fmt"
	"image/png"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 详情窗按 Tauri TextPreviewView 复刻（560×540，隐藏标题栏，系统红绿灯在 12,13）：
// 顶部 128 高的灰蓝渐变 → 标题行（来源 · 创建时间 · 字数 + 钉住）→ 标签行 → 正文（左右 20，上下 64）
// → 底部操作坞（选词 / 原文 / 处理 / 复制 / 编辑 + 分体「发送到 目标」）。
// 正文渲染只覆盖常用 Markdown 块（段落、有序/无序列表、标题、代码块）；块级图文混排未移植。

type detailState struct {
	id                  string
	edit, raw, pick     bool
	pinned              bool
	pickAnchor, pickEnd int // 选词区间（段下标，-1 未选）
	tagDraft            string
	tagOn               bool
	full                ui.ImageSource
	enter               bool                 // 正文待播进场（每次打开一条内容）
	readSel             []ui.SelectedText    // 阅读态的划词选区（上一帧）
	editSel             [2]int               // 进编辑时要落的选区（rune 偏移，-1 = 无）
	dblFrames           int                  // 双击正文后再等几帧进编辑（等选词结果落进 readSel）
	editRange           [2]int               // 编辑器当前选区（上一帧，rune 偏移）
	title               string               // 编辑态标题草稿（同 Tauri draftTitle）
	img                 int                  // 多图时当前第几张（主图 + 附件 + 内容块里的图）
	imgW, imgH          int                  // 当前图原始尺寸
	imgNote             bool                 // 图片文字备注编辑中
	pickPara            bool                 // 选词粒度：段（同 Tauri pickGranularity）
	blocks              []store.ContentBlock // 图文混排卡编辑态的内容块草稿（nil = 按纯文本编辑）
	blank               bool                 // 本次是新建的「新笔记」占位卡：关窗时一字未改就删掉（同 Tauri note-discard-blank）
}

// 多详情窗（同 Tauri detailWindows.ts，📌 固定并存）：每扇窗一份 detailPane。渲染 / 获得焦点时把该窗的状态换进
// a.detail / a.detailText / a.detailWin（其余代码照旧读写这三个字段），换出时写回——全在主线程，不会串台。
type detailPane struct {
	st   detailState
	text string
	win  *mygo.Window
}

// usePane：把 p 换成当前详情窗（先把当前窗的状态写回它自己的 pane）。
func (a *app) usePane(p *detailPane) {
	if a.curPane == p {
		return
	}
	if a.curPane != nil {
		a.curPane.st, a.curPane.text, a.curPane.win = a.detail, a.detailText, a.detailWin
	}
	a.curPane = p
	a.detail, a.detailText, a.detailWin = p.st, p.text, p.win
}

// pickPane 同 Tauri pickDetailWindowLabel：同卡复用 > 未固定的窗 > 新窗。
func (a *app) pickPane(id string) (p *detailPane, same bool) {
	if a.curPane != nil {
		a.curPane.st, a.curPane.text, a.curPane.win = a.detail, a.detailText, a.detailWin
	}
	for _, x := range a.panes {
		if x.st.id == id {
			return x, true
		}
	}
	for _, x := range a.panes {
		if !x.st.pinned {
			return x, false
		}
	}
	p = &detailPane{}
	a.panes = append(a.panes, p)
	return p, false
}

func (a *app) openDetail(n store.Note) {
	p, same := a.pickPane(n.ID)
	a.usePane(p)
	if same && a.detailWin != nil {
		a.detailWin.Show()
		a.detailWin.Focus()
		return
	}
	a.saveDetail()
	a.detailText = n.Text
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, enter: true, editSel: [2]int{-1, -1}, title: n.Title}
	if n.Kind == "image" {
		a.detailImageAt(n, 0)
	}
	if a.detailWin != nil {
		a.detailWin.Destroy() // 每次重建：位图随窗口释放
	}
	opts := mygo.WindowOptions{
		Title: preview(n.Text, 24), Width: 560, Height: 540, MinWidth: 380, Hidden: true,
		TitleBarStyle: mygo.TitleBarHidden, TrafficLightPosition: &mygo.Point{X: 12, Y: 13},
		Vibrancy: vibrancyFor(a.store.Settings().Glass), Transparent: true,
		Content: ui.View(func(c *ui.Context) { a.usePane(p); a.detailView(c) }),
	}
	if len(a.panes) > 1 { // 并存的新窗错开 28pt，不整块压住已固定的窗
		for _, x := range a.panes {
			if x != p && x.win != nil {
				wx, wy := x.win.Position()
				opts.X, opts.Y = wx+28, wy+28
			}
		}
	}
	win := mygo.NewWindow(opts)
	a.detailWin = win
	win.OnFocus(func() { a.usePane(p) }) // 双击剪贴卡追加等外部操作落到最近获得焦点的窗
	win.OnClose(func(*mygo.CloseEvent) {
		if p.win != win && a.detailWin != win {
			return // 已被换成新窗（Destroy 旧窗）
		}
		a.usePane(p)
		a.saveDetail()
		a.discardBlankDraft()
		a.detailWin, a.detail.id = nil, ""
		a.panes = slices.DeleteFunc(a.panes, func(x *detailPane) bool { return x == p })
		a.curPane = nil
		if len(a.panes) > 0 {
			a.usePane(a.panes[len(a.panes)-1])
		}
	})
	win.Show()
	win.Focus()
}

func (a *app) saveDetail() {
	if a.detail.id != "" && a.detail.edit && a.detail.blocks != nil {
		_, _ = a.store.SetBlocks(a.detail.id, a.detail.blocks)
		if n, ok := a.store.Note(a.detail.id); ok && n.Title != strings.TrimSpace(a.detail.title) {
			_ = a.store.SetTitle(n.ID, a.detail.title)
		}
	} else if a.detail.id != "" && a.detail.edit && strings.TrimSpace(a.detailText) != "" {
		_ = a.store.Update(a.detail.id, a.detailText)
		if n, ok := a.store.Note(a.detail.id); ok && n.Title != strings.TrimSpace(a.detail.title) {
			_ = a.store.SetTitle(n.ID, a.detail.title)
		}
	}
	if a.detail.id != "" && a.detail.imgNote {
		a.saveImageNote()
	}
}

// detailImageAt 载入第 i 张图（同 Tauri ImagePreviewView 多图：主图 + 附件 + 内容块里的图）。
func (a *app) detailImageAt(n store.Note, i int) {
	files := n.MediaFiles()
	if len(files) == 0 {
		return
	}
	i = max(0, min(i, len(files)-1))
	a.detail.img, a.detail.full, a.detail.imgW, a.detail.imgH = i, nil, 0, 0
	if raw, err := a.store.LoadImage(files[i]); err == nil {
		if src, err := png.Decode(bytes.NewReader(raw)); err == nil {
			a.detail.full = scaledBitmap(src, 1600)
			a.detail.imgW, a.detail.imgH = src.Bounds().Dx(), src.Bounds().Dy()
		}
	}
}

var shotCaption = regexp.MustCompile(`^(图片|Image) \d+×\d+$`)

// imageNoteText：图片卡的文字备注；截图默认标题「图片 W×H」视为没有备注。
func imageNoteText(n store.Note) string {
	if shotCaption.MatchString(strings.TrimSpace(n.Text)) {
		return ""
	}
	return n.Text
}

// saveImageNote：保存图片文字备注；清空时回到默认标题，卡面不至于空白。
func (a *app) saveImageNote() {
	n, ok := a.store.Note(a.detail.id)
	a.detail.imgNote = false
	if !ok {
		return
	}
	t := strings.TrimSpace(a.detailText)
	if t == "" { // 清空 = 清除备注；卡面回到默认标题（imageNoteText 视为无备注）
		t = fmt.Sprintf(tr("图片 %d×%d"), n.ImageW, n.ImageH)
	}
	if t == n.Text {
		return
	}
	_ = a.store.Update(n.ID, t)
	prev := n.Text
	a.showHUDUndo("ok", tr("已保存"), func() { _ = a.store.Update(n.ID, prev) }) // 同 Tauri 经主面板保存的可撤销「已保存」
}

func (a *app) detailView(c *ui.Context) {
	registerFonts()
	k, s := tok(c), stok(c)
	n, ok := a.store.Note(a.detail.id)
	if !ok {
		c.Root().Background(s.bg)
		ui.Column(c).Fill().Center().Children(func() { text(c, tr("这条内容已被删除"), 12, 17, 400, k.muted) })
		return
	}
	bg := s.bg
	if c.Vibrancy() {
		bg = bg.Alpha(0.72) // 原生模糊材质透出（Tauri 关闭玻璃时为不透明底）
	}
	c.Root().Background(bg)
	a.detailKeys(c, n)
	ui.Box(c).Fill().Children(func() {
		ui.Box(c).Absolute().Top(0).Left(0).Right(0).Height(102.4).
			LinearGradient(ui.LinearGradient{From: srgbf(0.486274, 0.517647, 0.580392).Alpha(0.26), To: ui.Transparent, Angle: 180})
		a.detailBody(c, k, s, n)
		ui.Column(c).Absolute().Top(0).Left(0).Right(0).Children(func() {
			a.detailHeader(c, k, n)
			a.detailTags(c, k, s, n)
		})
		ui.Row(c).Absolute().Left(0).Right(0).Bottom(0).Padding(40, 16, 12, 16).Gap(4).Justify(ui.Center).AlignItems(ui.Center).
			Children(func() { a.detailDock(c, k, s, n) })
		a.detailSelectionBar(c, k, n)
	})
}

func (a *app) detailKeys(c *ui.Context, n store.Note) {
	if c.Shortcut(ui.Cmd, ui.KeyS) && a.detail.edit { // ⌘S 保留为保存的别名
		a.commitDetailEdit(n)
	}
	if c.Shortcut(ui.Cmd, ui.KeyEnter) {
		switch {
		case a.detail.imgNote: // 备注编辑中 ⌘⏎ 是保存（同 Tauri）
			a.saveImageNote()
		case a.detail.edit: // 编辑态 ⌘⏎ 只保存不发送（同 Tauri TextPreviewView save）
			a.commitDetailEdit(n)
		default:
			a.sendDetail(n)
		}
	}
	reading := !a.detail.edit && !a.detail.imgNote && !a.detail.tagOn
	if reading && c.Shortcut(ui.Cmd, ui.KeyZ) && a.hudUndo != nil { // 同 Tauri 查看态 ⌘Z：执行 HUD 的撤销
		fn := a.hudUndo
		a.hudUndo = nil
		fn()
		a.showHUD("undone", tr("已撤销"))
	}
	if c.Shortcut(ui.Cmd, ui.KeyW) { // ⌘W 关窗（关窗时保存）
		a.closeDetailWin()
	}
	if reading && !a.detail.pick && c.Shortcut(0, ui.KeySpace) { // 同 Tauri Quick Look 习惯：查看态空格关窗
		a.closeDetailWin()
	}
	if n.Kind == "image" && !a.detail.imgNote {
		if files := n.MediaFiles(); len(files) > 1 {
			if c.Shortcut(0, ui.KeyLeft) && a.detail.img > 0 {
				a.detailImageAt(n, a.detail.img-1)
			}
			if c.Shortcut(0, ui.KeyRight) && a.detail.img < len(files)-1 {
				a.detailImageAt(n, a.detail.img+1)
			}
		}
	}
	if c.Shortcut(ui.Cmd, ui.KeyV) && !a.detail.edit && !a.detail.imgNote { // 阅读态 ⌘V：把剪贴板图片加进当前卡
		a.pasteIntoDetail(n, "")
	}
	if c.Shortcut(0, ui.KeyW) && !a.detail.edit && n.Kind != "image" { // W 切换选词模式（同 Tauri）
		a.detail.pick, a.detail.pickAnchor, a.detail.pickEnd = !a.detail.pick, -1, -1
	}
	// ⌘+ / ⌘− 调字号（10–24），⌘0 复位 12，写回设置
	st := a.store.Settings()
	fs := st.DetailFontSize
	switch {
	case c.Shortcut(ui.Cmd, ui.KeyEqual):
		fs = min(24, fs+1)
	case c.Shortcut(ui.Cmd, ui.KeyMinus):
		fs = max(10, fs-1)
	case c.Shortcut(ui.Cmd, ui.Key0):
		fs = 12
	}
	if fs != st.DetailFontSize {
		st.DetailFontSize = fs
		_ = a.store.SetSettings(st)
	}
	if c.Shortcut(0, ui.KeyEscape) {
		switch {
		case a.detail.imgNote: // Esc 保存并退出（同 Tauri）
			a.saveImageNote()
		case a.detail.edit: // 同 Tauri exitEditing：保存并退出；草稿清空了才算放弃
			if a.detail.blocks == nil && strings.TrimSpace(a.detailText) == "" {
				a.detail.edit, a.detailText, a.detail.title = false, n.Text, n.Title
			} else {
				a.commitDetailEdit(n)
			}
		case a.detail.tagOn:
			a.detail.tagOn, a.detail.tagDraft = false, ""
		case a.detail.pick && a.detail.pickAnchor >= 0: // 逐层退：先清选中的词，再退选词模式，再关窗
			a.detail.pickAnchor, a.detail.pickEnd = -1, -1
		case a.detail.pick:
			a.detail.pick = false
		default:
			a.closeDetailWin()
		}
	}
}

func (a *app) detailHeader(c *ui.Context, k tokens, n store.Note) {
	ui.Row(c).Height(38).Padding(8, 12).Gap(8).AlignItems(ui.Center).DragWindow().Children(func() {
		ui.Box(c).Width(52) // 系统红绿灯占位
		parts := []string{}
		if n.SourceApp != "" {
			parts = append(parts, tr("来自 ")+n.SourceApp)
		} else {
			parts = append(parts, tr("笔记"))
		}
		parts = append(parts, tr("创建 ")+ago(n.CreatedAt, a.now()))
		if n.UpdatedAt.After(n.CreatedAt) {
			parts = append(parts, tr("改于 ")+ago(n.UpdatedAt, a.now()))
		}
		chars := utf8.RuneCountInString(n.Text)
		parts = append(parts, strconv.Itoa(chars)+tr(" 字"))
		spans := []ui.Span{{Text: strings.Join(parts, " · "), Color: k.muted}}
		if t := strings.TrimSpace(n.Title); t != "" {
			spans = append([]ui.Span{{Text: t + " · ", Color: k.fg, Weight: 500}}, spans...)
		}
		ui.RichText(c, spans...).Font(fontSans).FontSize(10).FixedLineHeight(14).SingleLine().Grow(1).Basis(0).
			Tooltip(fmt.Sprintf(tr("%d 字符 · %d 词 · %d 行"), chars, len(strings.Fields(n.Text)), strings.Count(n.Text, "\n")+1))
		pinTip := tr("固定窗口：发送后保持打开，新开的卡另开一扇窗")
		if a.detail.pinned {
			pinTip = tr("取消固定（发送后恢复自动关窗）")
		}
		pin := ui.Box(c).Size(22, 22).Radius(8).Center().Tooltip(pinTip).Role(ui.RoleButton).Label(pinTip)
		col := k.muted
		if a.detail.pinned {
			pin.Background(k.track)
			col = k.fg
		} else if pin.Hovered() {
			pin.Background(k.track)
		}
		pin.Children(func() {
			if a.detail.pinned {
				liconFilled(c, "pin", 14, col)
			} else {
				licon(c, "pin", 14, col)
			}
		})
		if pin.Clicked() {
			a.detail.pinned = !a.detail.pinned // 同 Tauri：固定只表示发送后不关窗、新卡另开一扇窗，不置顶
		}
	})
}

func (a *app) detailTags(c *ui.Context, k tokens, s settingsTokens, n store.Note) {
	ui.Row(c).Height(28).Padding(4, 12).Gap(4).AlignItems(ui.Center).Children(func() {
		for _, tag := range n.Tags {
			chip := ui.Row(c).Height(20).Padding(2, 6).Gap(2).Radius(10).Background(k.track).AlignItems(ui.Center).Key("tag-" + tag)
			chip.Children(func() {
				text(c, "#"+tag, 11, 16, 400, k.muted)
				if ghostIconButton(c, k, "tagx-"+tag, "x", tr("移除标签"), 14, 10, true, chip.Hovered()).Clicked() {
					_ = a.store.SetTags(n.ID, slices.DeleteFunc(slices.Clone(n.Tags), func(t string) bool { return t == tag }))
				}
			})
		}
		if a.detail.tagOn {
			ui.Row(c).Width(110).Height(20).Padding(0, 6).Radius(10).Border(1, s.inputBorder).AlignItems(ui.Center).Children(func() {
				ui.TextInputBase(c, &a.detail.tagDraft).Grow(1).Font(fontSans).FontSize(11).FixedLineHeight(16).TextColor(k.fg).
					PlaceholderColor(k.muted).Placeholder(tr("标签，回车添加")).Focus().OnTextKey(func(key ui.TextKey) bool {
					switch key.Key {
					case ui.KeyEnter:
						if t := strings.TrimSpace(key.Text()); t != "" {
							_ = a.store.SetTags(n.ID, append(slices.Clone(n.Tags), t))
						}
						a.detail.tagDraft = "" // 同 Tauri：回车后保持输入框，方便连续添加
						return true
					case ui.KeyEscape:
						a.detail.tagDraft, a.detail.tagOn = "", false
						return true
					}
					return false
				})
			})
			return
		}
		add := ui.Row(c).Height(20).Padding(2, 6).Radius(10).AlignItems(ui.Center)
		if add.Hovered() {
			add.Background(k.track)
		}
		add.Children(func() { text(c, tr("＋ 标签"), 11, 16, 400, k.muted.Alpha(0.7)) })
		if add.Clicked() {
			a.detail.tagOn = true
		}
	})
}

func (a *app) detailBody(c *ui.Context, k tokens, s settingsTokens, n store.Note) {
	sc := ui.Scroll(c).Fill().Scrollbars(false)
	if a.detail.edit { // 编辑态一圈内嵌描边 + 浅蓝底（同 Tauri editing && bg-primary/[0.04] ring-inset ring-primary/25）
		sc.Background(s.primary.Alpha(0.04)).InsetShadow(0, 0, 0, 1, s.primary.Alpha(0.25))
	}
	if files := sc.DroppedFiles(); len(files) > 0 { // 拖入图片文件：追加进当前卡（同 Tauri 详情窗拖入）
		a.dropIntoDetail(n, files)
	}
	if sc.FileDragOver() {
		sc.InsetShadow(0, 0, 0, 2, s.primary.Alpha(0.5))
	}
	sc.Children(func() {
		body := ui.Column(c).Padding(64, 20, 84, 20)
		if a.detail.enter { // 正文进场：opacity 0 → 1、y 6 → 0，springSnappy（Tauri motion.div key=gen）
			body.Jump("in", 0)
			a.detail.enter = false
		}
		in := body.AnimateTo("in", 1, springSnappy)
		body.Opacity(min(in, 1)).Translate(0, 6*(1-in))
		body.Children(func() {
			if n.Kind == "image" {
				a.detailImage(c, k, s, n)
			}
			switch {
			case n.Kind == "image":
				// 图片卡的文字在备注条里编辑
			case a.detail.edit:
				ui.Row(c).Margin(0, 0, 8, 0).Padding(0, 0, 8, 0).BorderWidth(0, 0, 1, 0).BorderColor(k.inputBorder.Alpha(0.5)).Children(func() {
					ui.TextInputBase(c, &a.detail.title).Grow(1).Font(fontSans).FontSize(16).FixedLineHeight(22).FontWeight(600).TextColor(k.fg).
						PlaceholderColor(k.muted.Alpha(0.5)).Placeholder(tr("添加标题（可选）")).Label(tr("笔记标题"))
				})
				if a.detail.blocks != nil {
					a.detailBlocksEdit(c, k, n)
					break
				}
				ta := ui.TextAreaBase(c, &a.detailText).FillWidth().Margin(5.85, 0, 0, 0).Lines(12, 1000).Font(fontSans).FontSize(13).
					FixedLineHeight(21.125).TextColor(k.fg).Focus().OnPaste(func(t string) bool { return a.pasteIntoDetail(n, t) })
				if sel := a.detail.editSel; sel[0] >= 0 { // 双击 / 划词进编辑：落在同一处（同 Tauri pendingSelectionRef）
					ta.SetTextSelection(sel[0], sel[1])
					a.detail.editSel = [2]int{-1, -1}
				}
				a.detail.editRange[0], a.detail.editRange[1] = ta.TextSelection()
				a.detailMediaStrip(c, k, n)
			case a.detail.pick:
				a.pickView(c, k, s, n.Text)
			default:
				// 阅读态整块共用一个选区：划词后点「编辑」或双击正文，进编辑时选区落在原文同一处
				read := ui.Column(c).Padding(5.85, 0, 0, 0).Gap(5.85).Selectable().Key("detail-read")
				read.Children(func() {
					if isCode(n) && !a.detail.raw { // 代码卡着色（同 Tauri 详情 highlightCode）
						ui.RichText(c, codeSpans(k, n.Text, n.CodeLang, 0)...).Font(fontMono).FontSize(13).FixedLineHeight(21.125).Wrap()
						a.detailMediaStrip(c, k, n)
					} else if a.detail.raw {
						text(c, n.Text, 13, 21.125, 400, k.fg).Font(fontMono).Wrap()
						a.detailMediaStrip(c, k, n)
					} else if len(n.MediaFiles()) > 0 {
						a.detailRichRead(c, k, n, float32(a.store.Settings().DetailFontSize)+1)
					} else {
						renderMarkdown(c, k, n.Text, float32(a.store.Settings().DetailFontSize)+1)
					}
				})
				// 可选文字在按下时就把双击拿去选词，DoubleClicked 收不到；在输入钩子里看点击数、不拦截，
				// 等选词落定（下下帧）再进编辑，编辑器里选中同一个词（同 Tauri 双击正文进编辑）
				read.HandleInput(func(ev ui.InputEvent) bool {
					if ev.Kind == ui.InputPointerDown && ev.Button == 0 && ev.Clicks == 2 && n.Kind != "image" {
						a.detail.dblFrames = 2
					}
					return false
				})
				a.detail.readSel = read.SelectedTexts()
				if a.detail.dblFrames > 0 {
					if a.detail.dblFrames--; a.detail.dblFrames == 0 {
						a.enterDetailEdit(n)
					} else {
						c.Invalidate()
					}
				}
			}
		})
	})
}

// ---- 常用 Markdown 块渲染（13/21.125，块间 0.45em） ----

var (
	olRe = regexp.MustCompile(`^(\d+)[.)]\s+(.*)$`)
	ulRe = regexp.MustCompile(`^[-*+]\s+(.*)$`)
	hRe  = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
)

func renderMarkdown(c *ui.Context, k tokens, src string, fs float32) {
	lh := fs * 1.625
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	for i := 0; i < len(lines); {
		line := lines[i]
		switch {
		case strings.TrimSpace(line) == "":
			i++
		case strings.HasPrefix(strings.TrimSpace(line), "```"):
			j := i + 1
			for j < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[j]), "```") {
				j++
			}
			code := strings.Join(lines[i+1:min(j, len(lines))], "\n")
			ui.Column(c).Padding(8, 10).Radius(8).Background(k.track).Key("code" + itoa(i)).Children(func() {
				text(c, code, 12, 18, 400, k.fg).Font(fontMono).Wrap()
			})
			i = j + 1
		case hRe.MatchString(line):
			m := hRe.FindStringSubmatch(line)
			size := fs * []float32{1.54, 1.31, 1.15, 1.08, 1, 1}[len(m[1])-1]
			text(c, m[2], size, size*1.4, 600, k.fg).Wrap()
			i++
		case olRe.MatchString(line) || ulRe.MatchString(line):
			ordered := olRe.MatchString(line)
			ui.Column(c).Gap(2).Key("list" + itoa(i)).Children(func() {
				for i < len(lines) {
					var marker, body string
					if m := olRe.FindStringSubmatch(lines[i]); ordered && m != nil {
						marker, body = m[1]+".", m[2]
					} else if m := ulRe.FindStringSubmatch(lines[i]); !ordered && m != nil {
						marker, body = "•", m[1]
					} else {
						break
					}
					ui.Row(c).AlignItems(ui.Start).Children(func() {
						text(c, marker, fs, lh, 400, k.fg).Width(18.2).Padding(0, 3.6, 0, 0).TextAlign(ui.End)
						text(c, body, fs, lh, 400, k.fg).Wrap().Grow(1).Basis(0)
					})
					i++
				}
			})
		default:
			j := i
			for j < len(lines) && strings.TrimSpace(lines[j]) != "" && !olRe.MatchString(lines[j]) && !ulRe.MatchString(lines[j]) &&
				!hRe.MatchString(lines[j]) && !strings.HasPrefix(strings.TrimSpace(lines[j]), "```") {
				j++
			}
			text(c, strings.Join(lines[i:j], "\n"), fs, lh, 400, k.fg).Wrap()
			i = j
		}
	}
}

// ---- 选词：按词 / 标点切成可点的块，点两次定区间，复制 / 发送只作用于所选 ----

type pickSeg struct {
	text string
	word bool
}

// pickSegments：ASCII 字母数字连写为一词，汉字逐字，空白与标点为分隔（Tauri 用 Intl.Segmenter，Go 无同等分词器）。
// paraSegments：按段选取——非空行各成一段，换行为分隔。
func paraSegments(s string) []pickSeg {
	var out []pickSeg
	for i, line := range strings.Split(s, "\n") {
		if i > 0 {
			out = append(out, pickSeg{"\n", false})
		}
		if strings.TrimSpace(line) != "" {
			out = append(out, pickSeg{line, true})
		}
	}
	return out
}

func (a *app) segments(s string) []pickSeg {
	if a.detail.pickPara {
		return paraSegments(s)
	}
	return pickSegments(s)
}

func pickSegments(s string) []pickSeg {
	var out []pickSeg
	var cur []rune
	flush := func() {
		if len(cur) > 0 {
			out = append(out, pickSeg{string(cur), true})
			cur = cur[:0]
		}
	}
	for _, r := range s {
		switch {
		case r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' || r == '.'):
			cur = append(cur, r)
		case unicode.Is(unicode.Han, r):
			flush()
			out = append(out, pickSeg{string(r), true})
		default:
			flush()
			out = append(out, pickSeg{string(r), false})
		}
	}
	flush()
	return out
}

func (a *app) pickedText(src string) string {
	d := a.detail
	if d.pickAnchor < 0 {
		return ""
	}
	lo, hi := min(d.pickAnchor, d.pickEnd), max(d.pickAnchor, d.pickEnd)
	segs := a.segments(src)
	var b strings.Builder
	for i := lo; i <= hi && i < len(segs); i++ {
		b.WriteString(segs[i].text)
	}
	return strings.TrimSpace(b.String())
}

func (a *app) pickView(c *ui.Context, k tokens, s settingsTokens, src string) {
	d := &a.detail
	lo, hi := min(d.pickAnchor, d.pickEnd), max(d.pickAnchor, d.pickEnd)
	ui.Row(c).Margin(5.85, 0, 0, 0).Gap(3).Wrap().Children(func() {
		for i, seg := range a.segments(src) {
			if !seg.word {
				if seg.text == "\n" {
					ui.Box(c).FillWidth().Height(0)
				}
				continue
			}
			on := d.pickAnchor >= 0 && i >= lo && i <= hi
			b := ui.Box(c).Height(24).Padding(2, 6).Radius(6).Border(1, s.inputBorder).Key("pk" + itoa(i))
			col := k.fg
			if on {
				b.Background(s.primary).Border(1, s.primary)
				col = gray(0.985, 1)
			} else if b.Hovered() {
				b.Background(k.track)
			}
			b.Children(func() { text(c, seg.text, 13, 18, 400, col) })
			if b.Clicked() {
				switch {
				case d.pickAnchor < 0 || d.pickAnchor != d.pickEnd:
					d.pickAnchor, d.pickEnd = i, i
				default:
					d.pickEnd = i
				}
			}
		}
	})
}

// ---- 操作坞 ----

func dockButton(c *ui.Context, k tokens, icon, label string, active bool) ui.Element {
	b := ui.Row(c).Height(29).Padding(6, 12).Gap(4).Radius(10).AlignItems(ui.Center).Key("dock-" + label)
	col := k.muted
	if active {
		b.Background(k.track)
		col = k.fg
	} else if b.Hovered() {
		b.Background(k.track)
		col = k.fg
	}
	b.Children(func() {
		if icon != "" {
			licon(c, icon, 12, col)
		}
		text(c, label, 12, 17, 400, col)
	})
	return b
}

func (a *app) detailDock(c *ui.Context, k tokens, s settingsTokens, n store.Note) {
	d := &a.detail
	if d.edit { // 同 Tauri 编辑态坞：自动保存语义，没有「取消」；正文为空时保存置灰
		b := dockButton(c, k, "", tr("保存 ⌘⏎"), true)
		if d.blocks == nil && strings.TrimSpace(a.detailText) == "" {
			b.Opacity(0.5).Tooltip(tr("笔记内容不能为空"))
		}
		if b.Clicked() {
			a.commitDetailEdit(n)
		}
		return
	}
	if n.Kind != "image" {
		if dockButton(c, k, "", tr("选词"), d.pick).Tooltip(tr("选词模式：点选词/段，可发送或复制选中片段（W）")).Clicked() {
			d.pick, d.pickAnchor, d.pickEnd = !d.pick, -1, -1
		}
		if d.pick {
			g := "word"
			if d.pickPara {
				g = "para"
			}
			if v, ok := miniSegmented(c, k, g, [][2]string{{"word", "词"}, {"para", "段"}}); ok {
				d.pickPara, d.pickAnchor, d.pickEnd = v == "para", -1, -1
			}
		}
		rawLabel := tr("原文")
		if d.raw {
			rawLabel = tr("渲染")
		}
		if dockButton(c, k, "", rawLabel, false).Clicked() {
			d.raw = !d.raw
		}
		if u := noteURL(n); u != "" && dockButton(c, k, "", tr("打开链接"), false).Clicked() {
			_ = exec.Command("/usr/bin/open", u).Start()
		}
		if a.aiBusy == n.ID && a.aiCancel != nil { // AI 改写进行中：可取消（同 Tauri 结果核对的「取消」）
			if dockButton(c, k, "x", tr("取消 AI 请求"), false).Clicked() {
				a.cancelAI()
			}
		}
		proc := dockButton(c, k, "wand-sparkles", tr("处理"), false)
		proc.PopoverMenuButton(func(m *ui.Menu) {
			for _, op := range textOps { // 本地文本处理（同 Tauri TEXT_OPS）：作用于全文，可撤销
				if m.Item(tr(op.label)).Chosen() {
					out, err := op.apply(n.Text)
					if err != nil {
						a.showHUD("warn", tr("处理失败：")+err.Error())
						continue
					}
					prev := n.Text
					_ = a.store.Update(n.ID, out)
					a.showHUDUndo("ok", tr("已处理 · ")+tr(op.label), func() { _ = a.store.Update(n.ID, prev) })
				}
			}
			m.Separator()
			for _, act := range aiActions {
				if m.Item(tr(act.label)).Chosen() {
					a.runAI(n, act)
				}
			}
		})
	}
	if dockButton(c, k, "", tr("复制"), false).Clicked() {
		txt := n.Text
		p := a.pickedText(n.Text)
		if d.pick && p != "" {
			txt = p
		} else if a.copyNoteMedia(n) {
			txt = ""
		}
		if txt != "" {
			a.copyPrivate(txt)
			a.showHUD("ok", tr("已复制"))
		}
	}
	if n.Kind != "image" && dockButton(c, k, "", tr("编辑"), false).Clicked() {
		a.enterDetailEdit(n)
	}
	// 分体发送钮：左「发送到 目标 ⌘⏎」，右下拉
	dark := k.dark
	fill, fg, border := gray(1, 1), gray(0.145, 1), gray(0, 0.1)
	if dark {
		fill, fg, border = gray(0.92, 1), gray(0.205, 1), gray(1, 0.08)
	}
	ui.Row(c).Margin(0, 0, 0, 4).Children(func() {
		label := tr("发送")
		if a.target.PID != 0 {
			label = tr("发送到 ") + a.target.Name
		}
		if d.pick && a.pickedText(n.Text) != "" {
			label = tr("发送所选")
		}
		left := ui.Row(c).Height(32).Padding(0, 12, 0, 20).Gap(6).Radius(16, 0, 0, 16).Background(fill).Border(1, border).AlignItems(ui.Center)
		if dark {
			left.Shadow(0, 1, 2, 0, gray(0, 0.5)).InsetShadow(0, 1, 0, 0, gray(1, 0.7))
		} else {
			left.Shadow(0, 1, 2, 0, gray(0, 0.12))
		}
		left.Children(func() {
			licon(c, "send", 12, fg)
			text(c, label, 13, 18, 500, fg).SingleLine()
			text(c, "⌘⏎", 9, 18, 500, fg).Opacity(0.7)
		})
		if left.Clicked() {
			a.sendDetail(n)
		}
		right := ui.Box(c).Size(28, 32).Radius(0, 16, 16, 0).Background(fill).Border(1, border).Center().Label(tr("更多发送选项"))
		right.Children(func() { licon(c, "chevron-down", 12, fg) })
		right.Menu(func(m *ui.Menu) {
			r, _ := a.resolution()
			// 发送方式（同 Tauri TextPreviewView）：仅本次换格式；代码卡与秘文保持原样，不提供去 Markdown
			m.Item(tr("发送方式")).Disabled(true)
			if m.Item(tr("原文发送")).Disabled(a.target.PID == 0).Chosen() {
				a.sendDetailMode(n, "plain")
			}
			if m.Item(tr("去 Markdown 后发送")).Disabled(a.target.PID == 0 || n.CodeLang != "" || n.Kind == "secret").Chosen() {
				a.sendDetailMode(n, "strip-markdown")
			}
			m.Separator()
			m.Item(tr("发送到…")).Disabled(true) // 同 Tauri：列出运行中的常规应用，选中即改为本次目标并发送
			apps := runningTargets()
			for _, app := range apps {
				if m.Item(app.Name).Chosen() {
					if a.adoptTarget(app) {
						a.sendDetail(n)
					} else {
						a.showHUD("warn", tr("该应用暂不可作为发送目标"))
					}
				}
			}
			if len(apps) == 0 {
				m.Item(tr("暂无其他可用应用")).Disabled(true)
			}
			m.Separator()
			on := r.Profile.EnterPolicy != "never"
			if m.Item(tr("粘贴后回车")).Checked(on).Disabled(a.target.PID == 0).Chosen() { // 本次覆盖当前目标的方案规则
				a.setRule(func(o *store.RuleOverrides) { o.EnterPolicy = map[bool]string{true: "never", false: "allow"}[on] })
			}
			if m.Item(tr("仅复制，不发送")).Chosen() {
				a.copyPrivate(n.Text)
				a.showHUD("ok", tr("已复制"))
			}
		})
	})
}

var runningTargets = macos.RegularApps // 测试替换

// adoptTarget 同 Tauri adopt_send_target：手动采信该应用为当前发送目标（身份锁定用内核启动时刻）。
func (a *app) adoptTarget(app macos.AppInfo) bool {
	if app.PID <= 0 || app.PID == a.sys.SelfPID() {
		return false
	}
	a.target = macos.FrontApp{PID: app.PID, BundleID: app.BundleID, Name: app.Name}
	a.targetStarted = app.StartedMs
	if a.targetStarted == 0 {
		a.targetStarted = macos.ProcessStartMs(app.PID)
	}
	return true
}

// sendDetailMode：详情窗「发送方式」——本次覆盖输出格式后照常发送（挂起时保留到确认 / 取消）。
func (a *app) sendDetailMode(n store.Note, mode string) {
	a.sendMode = mode
	a.sendDetail(n)
	if len(a.pending) == 0 && len(a.enterAsk) == 0 {
		a.sendMode = ""
	}
}

func (a *app) sendDetail(n store.Note) {
	if a.target.PID == 0 { // 同 Tauri：目标不可用时不关窗，改去选目标
		a.showHUD("warn", tr("没有发送目标：从发送钮右侧下拉「发送到…」选一个应用"))
		return
	}
	if p := a.pickedText(n.Text); a.detail.pick && p != "" {
		a.send([]store.Note{{Text: p}}) // 只发所选片段，不改卡片状态
	} else {
		if a.detail.edit {
			if !a.commitDetailEdit(n) {
				return
			}
			n.Text = a.detailText
		}
		a.send([]store.Note{n})
	}
	if !a.detail.pinned { // 未固定的窗发送后关闭（同 Tauri：📌 固定才保持打开；片段发送同样）
		a.closeDetailWin()
	}
}

// closeDetailWin 关当前详情窗（OnClose 里保存、回收空白新笔记）；放到帧外执行。
func (a *app) closeDetailWin() {
	if win := a.detailWin; win != nil {
		a.onMain(win.Close)
	}
}

// commitDetailEdit 保存编辑并退出编辑态（⌘⏎ / ⌘S / Esc / 保存钮）。正文为空时 warn 且留在编辑态（同 Tauri save）；
// 有改动时出可撤销的「已保存」（同 Tauri armNoteEditUndo）。
func (a *app) commitDetailEdit(n store.Note) bool {
	if a.detail.blocks == nil && strings.TrimSpace(a.detailText) == "" {
		a.showHUD("warn", tr("笔记内容不能为空"))
		return false
	}
	before, _ := a.store.Note(n.ID)
	a.saveDetail()
	a.detail.edit = false
	after, ok := a.store.Note(n.ID)
	if !ok || (after.Text == before.Text && after.Title == before.Title && slices.Equal(after.Blocks, before.Blocks)) {
		return true
	}
	a.showHUDUndo("ok", tr("已保存"), func() {
		if len(before.Blocks) > 0 {
			_, _ = a.store.SetBlocks(before.ID, before.Blocks)
		} else {
			_ = a.store.Update(before.ID, before.Text)
		}
		_ = a.store.SetTitle(before.ID, before.Title)
	})
	return true
}

// discardBlankDraft：新建流程打开的「新笔记」占位卡，关窗时仍是占位文字、无标题无标签无图就删掉（同 Tauri note-discard-blank）。
func (a *app) discardBlankDraft() {
	if !a.detail.blank {
		return
	}
	a.detail.blank = false
	n, ok := a.store.Note(a.detail.id)
	if ok && strings.TrimSpace(n.Text) == tr("新笔记") && strings.TrimSpace(n.Title) == "" && len(n.Tags) == 0 && len(n.MediaFiles()) == 0 {
		a.store.Delete(n.ID)
		a.reload()
	}
}

// enterDetailEdit：进编辑态；阅读态有划词选区时换算成原文偏移，编辑器里选中同一段。
func (a *app) enterDetailEdit(n store.Note) {
	a.saveDetail()
	a.detail.edit, a.detail.pick, a.detailText = true, false, n.Text
	a.detail.blocks = nil
	if store.HasMixedContent(n.Blocks) {
		a.detail.blocks = slices.Clone(n.Blocks)
	}
	a.detail.editSel = mapReadSelection(n.Text, a.detail.readSel)
	a.detail.editRange = [2]int{}
}

// mapReadSelection：阅读态各段的选区 → 原文 rune 区间。渲染出的段落 / 列表项 / 标题 / 代码块都是原文的子串，
// 按构建顺序依次在原文里定位；对不上时返回 {-1,-1}（编辑器光标照常在开头）。
func mapReadSelection(src string, parts []ui.SelectedText) [2]int {
	if len(parts) == 0 {
		return [2]int{-1, -1}
	}
	from, start, end := 0, -1, -1
	for i, p := range parts {
		idx := strings.Index(src[from:], p.Text)
		if idx < 0 {
			return [2]int{-1, -1}
		}
		idx += from
		base := utf8.RuneCountInString(src[:idx])
		if i == 0 {
			start = base + p.Start
		}
		end = base + p.End
		from = idx + len(p.Text)
	}
	if start < 0 || end < start {
		return [2]int{-1, -1}
	}
	return [2]int{start, end}
}

// detailImage：图片 + 多图上一张 / 下一张（圆形半透明钮）+ 底部「i / N · W × H」+ 文字备注条（同 Tauri ImagePreviewView）。
func (a *app) detailImage(c *ui.Context, k tokens, s settingsTokens, n store.Note) {
	files := n.MediaFiles()
	many := len(files) > 1
	if a.detail.full != nil {
		w, h := ui.ImageSize(a.detail.full)
		dw := min(w, 520)
		ui.Row(c).FillWidth().Margin(5.85, 0, 0, 0).Justify(ui.Center).Children(func() { // 翻页钮贴容器两侧（同 Tauri），小图也不重叠
			ui.Image(c, a.detail.full).Size(dw, h*dw/max(w, 1)).Radius(8)
			if !many {
				return
			}
			nav := func(icon, label string, left bool, disabled bool) {
				b := ui.Box(c).Absolute().Top(h*dw/max(w, 1)/2-14).Size(28, 28).Radius(14).Center().Key("img-" + icon).
					Role(ui.RoleButton).Label(label).Tooltip(label)
				if left {
					b.Left(8)
				} else {
					b.Right(8)
				}
				bg, fg := ui.RGBA(0, 0, 0, 0.4), ui.RGBA(255, 255, 255, 0.8)
				if b.Hovered() && !disabled {
					bg, fg = ui.RGBA(0, 0, 0, 0.6), ui.RGB(255, 255, 255)
				}
				if disabled {
					b.Opacity(0.3)
				}
				fadeColor(b, "bg", bg, tweenControl) // token-exception: 叠在图片上的固定暗钮（同 Tauri bg-black/40）
				b.Children(func() { licon(c, icon, 16, fg) })
				if b.Clicked() && !disabled {
					if left {
						a.detailImageAt(n, a.detail.img-1)
					} else {
						a.detailImageAt(n, a.detail.img+1)
					}
				}
			}
			nav("chevron-left", tr("上一张"), true, a.detail.img == 0)
			nav("chevron-right", tr("下一张"), false, a.detail.img == len(files)-1)
		})
	}
	var meta []string
	if many {
		meta = append(meta, fmt.Sprintf("%d / %d", a.detail.img+1, len(files)))
	}
	if a.detail.imgW > 0 {
		meta = append(meta, fmt.Sprintf("%d × %d", a.detail.imgW, a.detail.imgH))
	}
	if len(meta) > 0 {
		text(c, strings.Join(meta, " · "), 10, 14, 400, k.muted).TextAlign(ui.Center).FillWidth().Margin(6, 0, 0, 0)
	}
	// 文字备注条
	ui.Column(c).Margin(10, 0, 0, 0).Padding(6, 0, 0, 0).BorderWidth(1, 0, 0, 0).BorderColor(k.inputBorder).Children(func() {
		if a.detail.imgNote {
			ui.Row(c).Gap(6).AlignItems(ui.End).Children(func() {
				ui.Box(c).Grow(1).Basis(0).Padding(4, 8).Radius(6).Background(k.fg.Alpha(0.05)).Children(func() {
					ui.TextAreaBase(c, &a.detailText).FillWidth().Lines(2, 8).Font(fontSans).FontSize(12).FixedLineHeight(18).TextColor(k.fg).
						PlaceholderColor(k.muted).Placeholder(tr("给这张图片写点文字…")).Label(tr("图片文字备注")).Focus()
				})
				if ghostIconButton(c, k, "imgnote-save", "check", tr("保存（⌘⏎）；Esc 保存并退出"), 26, 14, false, true).Clicked() {
					a.saveImageNote()
				}
			})
			return
		}
		note := imageNoteText(n)
		label := tr("添加文字备注")
		if note != "" {
			label = tr("编辑文字备注")
		}
		b := ui.Row(c).Padding(4, 6).Gap(6).Radius(6).AlignItems(ui.Center).Key("imgnote").Role(ui.RoleButton).Label(label).Tooltip(label)
		pc := k.fg.Alpha(0.4)
		if b.Hovered() {
			b.Background(k.fg.Alpha(0.1))
			pc = k.fg.Alpha(0.8)
		}
		b.Children(func() {
			licon(c, "pencil", 12, pc)
			if note != "" {
				text(c, note, 12, 18, 400, k.fg.Alpha(0.85)).SingleLine().Grow(1).Basis(0)
			} else {
				text(c, tr("添加文字备注…"), 12, 18, 400, k.muted).Grow(1).Basis(0)
			}
		})
		if b.Clicked() {
			a.detailText, a.detail.imgNote = note, true
		}
	})
}

// noteURL：链接卡的网址（只放行 http / https）。
func noteURL(n store.Note) string {
	u := strings.TrimSpace(cmpOr(n.URL, n.Text))
	if n.Kind != "link" || !(strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")) {
		return ""
	}
	return u
}

// editInDetail：卡片「编辑」（悬停铅笔、右键菜单、↩）一律开详情窗进编辑态（同 Tauri openNoteDetail(id, true)）——
// 面板太窄不适合改长文。图片卡进文字备注编辑；秘文不进详情窗（通用编辑器保存会以明文改写密文信封）。
func (a *app) editInDetail(n store.Note) {
	if n.Kind == "secret" {
		a.showHUD("info", tr("秘文请在秘文页点击查看，不支持详情窗"))
		return
	}
	openDetailFn(a, n)
	if n.Kind == "image" {
		a.detailText, a.detail.imgNote = imageNoteText(n), true
		return
	}
	a.enterDetailEdit(n)
}
