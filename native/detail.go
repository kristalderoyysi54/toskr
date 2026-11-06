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
	enter               bool              // 正文待播进场（每次打开一条内容）
	readSel             []ui.SelectedText // 阅读态的划词选区（上一帧）
	editSel             [2]int            // 进编辑时要落的选区（rune 偏移，-1 = 无）
	dblFrames           int               // 双击正文后再等几帧进编辑（等选词结果落进 readSel）
	editRange           [2]int            // 编辑器当前选区（上一帧，rune 偏移）
	title               string            // 编辑态标题草稿（同 Tauri draftTitle）
	img                 int               // 多图时当前第几张（主图 + 附件 + 内容块里的图）
	imgW, imgH          int               // 当前图原始尺寸
	imgNote             bool              // 图片文字备注编辑中
	pickPara            bool              // 选词粒度：段（同 Tauri pickGranularity）
}

func (a *app) openDetail(n store.Note) {
	a.saveDetail()
	a.detailText = n.Text
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, enter: true, editSel: [2]int{-1, -1}, title: n.Title}
	if n.Kind == "image" {
		a.detailImageAt(n, 0)
	}
	if a.detailWin != nil {
		a.detailWin.Destroy() // 每次重建：位图随窗口释放
	}
	a.detailWin = mygo.NewWindow(mygo.WindowOptions{
		Title: preview(n.Text, 24), Width: 560, Height: 540, MinWidth: 380, Hidden: true,
		TitleBarStyle: mygo.TitleBarHidden, TrafficLightPosition: &mygo.Point{X: 12, Y: 13},
		Vibrancy: vibrancyFor(a.store.Settings().Glass), Transparent: true,
		Content: ui.View(a.detailView),
	})
	a.detailWin.OnClose(func(*mygo.CloseEvent) {
		a.saveDetail()
		a.detailWin, a.detail.id = nil, ""
	})
	a.detailWin.Show()
	a.detailWin.Focus()
}

func (a *app) saveDetail() {
	if a.detail.id != "" && a.detail.edit && strings.TrimSpace(a.detailText) != "" {
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
	if t == "" {
		t = fmt.Sprintf(tr("图片 %d×%d"), n.ImageW, n.ImageH)
	}
	_ = a.store.Update(n.ID, t)
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
	if c.Shortcut(ui.Cmd, ui.KeyS) && a.detail.edit {
		a.saveDetail()
		a.detail.edit = false
		a.showHUD("ok", tr("已保存"))
	}
	if c.Shortcut(ui.Cmd, ui.KeyEnter) {
		if a.detail.imgNote { // 备注编辑中 ⌘⏎ 是保存（同 Tauri）
			a.saveImageNote()
		} else {
			a.sendDetail(n)
		}
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
		case a.detail.edit:
			a.detail.edit, a.detailText = false, n.Text
		case a.detail.pick:
			a.detail.pick = false
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
		pin := ui.Box(c).Size(22, 22).Radius(8).Center().Tooltip(tr("钉在最前"))
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
			a.detail.pinned = !a.detail.pinned
			if a.detailWin != nil {
				a.detailWin.SetAlwaysOnTop(a.detail.pinned)
			}
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
						a.detail.tagDraft, a.detail.tagOn = "", false
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
				ta := ui.TextAreaBase(c, &a.detailText).FillWidth().Margin(5.85, 0, 0, 0).Lines(12, 1000).Font(fontSans).FontSize(13).
					FixedLineHeight(21.125).TextColor(k.fg).Focus()
				if sel := a.detail.editSel; sel[0] >= 0 { // 双击 / 划词进编辑：落在同一处（同 Tauri pendingSelectionRef）
					ta.SetTextSelection(sel[0], sel[1])
					a.detail.editSel = [2]int{-1, -1}
				}
				a.detail.editRange[0], a.detail.editRange[1] = ta.TextSelection()
			case a.detail.pick:
				a.pickView(c, k, s, n.Text)
			default:
				// 阅读态整块共用一个选区：划词后点「编辑」或双击正文，进编辑时选区落在原文同一处
				read := ui.Column(c).Padding(5.85, 0, 0, 0).Gap(5.85).Selectable().Key("detail-read")
				read.Children(func() {
					if a.detail.raw || n.Kind == "code" {
						text(c, n.Text, 13, 21.125, 400, k.fg).Font(fontMono).Wrap()
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
	if d.edit {
		if dockButton(c, k, "", tr("取消"), false).Clicked() {
			d.edit, a.detailText = false, n.Text
		}
		if dockButton(c, k, "", tr("保存（⌘S）"), true).Clicked() {
			a.saveDetail()
			d.edit = false
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
		if p := a.pickedText(n.Text); d.pick && p != "" {
			txt = p
		}
		a.copyPrivate(txt)
		a.showHUD("ok", tr("已复制"))
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
		right := ui.Box(c).Size(28, 32).Radius(0, 16, 16, 0).Background(fill).Border(1, border).Center()
		right.Children(func() { licon(c, "chevron-down", 12, fg) })
		right.Menu(func(m *ui.Menu) {
			r, _ := a.resolution()
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

func (a *app) sendDetail(n store.Note) {
	if p := a.pickedText(n.Text); a.detail.pick && p != "" {
		a.send([]store.Note{{Text: p}}) // 只发所选片段，不改卡片状态
		return
	}
	if a.detail.edit {
		a.saveDetail()
		a.detail.edit = false
		n.Text = a.detailText
	}
	a.send([]store.Note{n})
}

// enterDetailEdit：进编辑态；阅读态有划词选区时换算成原文偏移，编辑器里选中同一段。
func (a *app) enterDetailEdit(n store.Note) {
	a.saveDetail()
	a.detail.edit, a.detail.pick, a.detailText = true, false, n.Text
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
