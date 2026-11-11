package main

import (
	"bytes"
	"fmt"
	"image/png"
	"math"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
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
	enter               bool              // 正文待播进场（每次打开一条内容）
	readSel             []ui.SelectedText // 阅读态的划词选区（上一帧）
	editSel             [2]int            // 进编辑时要落的选区（rune 偏移，-1 = 无）
	dblFrames           int               // 双击正文后再等几帧进编辑（等选词结果落进 readSel）
	editRange           [2]int            // 编辑器当前选区（上一帧，rune 偏移）
	title               string            // 编辑态标题草稿（同 Tauri draftTitle）
	img                 int               // 多图时当前第几张（主图 + 附件 + 内容块里的图）
	imgW, imgH          int               // 当前图原始尺寸
	view                zoomView          // 看图层缩放 / 平移（0 值 = 适配）
	pan                 *[4]float32       // 拖拽平移中：按下点 + 按下时的平移
	hi                  ui.ImageSource    // 放大时按需载入的高分辨率版（full 最宽 detailFullW）
	hiFile              string            // hi 对应的文件（"" = 未载入）
	hiLoading           bool
	imgSized            bool            // 窗口按图片尺寸开（图片卡）：关窗不记尺寸
	galleryBack         *mygo.Rectangle // 图文卡看图时放大前的窗口位置与尺寸
	chromeHidden        bool            // 无界剧场（同 Tauri chromeOn）：标题栏 / 标签行 / 操作坞收起中
	chromeOver          bool            // 上一帧光标在窗内
	altEdit             bool            // 看图层：正在给当前这张图写说明
	altDraft            string
	fullFile            string // a.detail.full 对应的文件（图被替换 / 撤销后据此重载）
	gallery             bool   // 图文 / 多图卡里点开某张图：窗内看图（同 Tauri quickLook 图片预览），Esc / 返回回到正文
	blkActive           int    // 图文卡编辑：当前文字块下标 + 1（划词工具条作用的块，0 = 无）
	blkRange            [2]int // 当前文字块的选区（块内 rune 偏移）
	blkSet              [3]int // 待落到块编辑器的选区 {块下标+1, lo, hi}（工具条改写后 / 进编辑定位）
	imgSel              int    // 编辑态图文卡选中的图片块：块下标 + 1（0 = 无，同 Tauri EditableRichImageBlock selected）
	imgNote             bool   // 图片文字备注编辑中
	pickPara            bool   // 选词粒度：段（同 Tauri pickGranularity）
	linkOn              bool   // 选中工具条的链接地址输入（⌘K）
	linkDraft           string
	aliasOn             bool    // 选中工具条「加入化名词典」浮层（阅读 / 选词态）
	aliasText           string  // 词条原文（可改）
	aliasCat            string  // 化名类别
	popSel              [2]int  // 浮层打开时的选区：选区变了就收起（同 Tauri 换选区重置）
	readGen             int     // 阅读区代次：+1 让可选文字容器重建，清掉划选（mygo 无清除选区接口）
	sel                 selGeom // 选区与窗口的几何（划词工具条贴着选区上方 / 下方）
	barHover            bool    // 上一帧指针在划词工具条上（按住鼠标点它的按钮时不收起）
	segSrc              string  // 选词分块缓存（系统分词每帧跑太贵）：原文 + 粒度
	segPara             bool
	// 阅读辅助（detail_find.go）：文内查找、标题大纲、阅读进度
	scroll             ui.ScrollState
	findOn, findFocus  bool
	findJump           bool // 待把当前命中滚进视口
	findQuery          string
	findCur, findTotal int
	heads              []mdHead
	review             *aiReview // AI 改写核对（ai_review.go）
	fanOpen            bool      // 「同时发到…」选目标浮层（fanout.go）
	compare            string    // 并排对比某组多目标发送的回复（组编号；空 = 不在对比）
	segs               []pickSeg
	blocks             []store.ContentBlock // 图文混排卡编辑态的内容块草稿（nil = 按纯文本编辑）
	blank              bool                 // 本次是新建的「新笔记」占位卡：关窗时一字未改就删掉（同 Tauri note-discard-blank）
	editPreview        bool                 // 编辑态「渲染」预览草稿（同 Tauri editPreviewOn）
	virt               *store.Note          // 只读合并预览（同 Tauri openNoteBatchDetail readOnly）：不在库里，只读、不可编辑 / 发送
	subtitle           string               // 只读预览的副标题（来源张数 · 发送记录不保存正文）
}

// detailNote：当前详情窗显示的内容；只读合并预览取 virt，其余按 id 从库里取。
func (a *app) detailNote() (store.Note, bool) {
	if v := a.detail.virt; v != nil {
		return *v, true
	}
	return a.store.Note(a.detail.id)
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

// detailFrame 同 Tauri window.rs 详情窗定位：首次按面板所在屏工作区定尺寸（半屏宽 480–640、七成高 400–680），
// 之后沿用用户拖过的尺寸；居中在面板所在屏。
func (a *app) detailFrame() (w, h, x, y int) {
	wa := a.detailWorkArea()
	if a.detailSize[0] > 0 {
		w, h = a.detailSize[0], a.detailSize[1]
	} else {
		w = min(max(wa.Width/2, 480), 640, wa.Width-24)
		h = min(max(wa.Height*7/10, 400), 680, wa.Height-24)
	}
	return w, h, wa.X + (wa.Width-w)/2, wa.Y + (wa.Height-h)/2
}

func (a *app) openDetail(n store.Note) {
	p, same := a.pickPane(n.ID)
	a.usePane(p)
	if same && a.detailWin != nil {
		a.armDetailChrome(p, a.detailWin)
		a.detailWin.Show()
		a.detailWin.Focus()
		return
	}
	a.saveDetail()
	if a.detailWin != nil {
		a.rememberDetailSize(a.detailWin)
		a.detailWin.Destroy() // 每次重建：位图随窗口释放
	}
	a.detailText = n.Text
	a.detail = detailState{id: n.ID, pickAnchor: -1, pickEnd: -1, enter: true, editSel: [2]int{-1, -1}, title: n.Title}
	w, h, x, y := a.detailFrame()
	if n.Kind == "image" { // 同 Tauri 图片预览窗：按图片原始尺寸开窗（不放大，最大到工作区 90%），不沿用文字详情窗的尺寸
		a.detailImageAt(n, 0)
		a.detail.imgSized = true
		r := imageWindowFrame(a.detailWorkArea(), a.detail.imgW, a.detail.imgH, imageChrome(n))
		w, h, x, y = r.Width, r.Height, r.X, r.Y
	}
	opts := mygo.WindowOptions{
		Title: preview(n.Text, 24), Width: w, Height: h, X: x, Y: y, MinWidth: 380, MinHeight: 300, Hidden: true,
		AlwaysOnTop:   true, // 同 Tauri window.rs always_on_top：面板置顶时详情窗不能被它压住（曾 Space 打开了却在面板后面看不见）
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
	win.SetVisibleOnAllWorkspaces(true) // 同 Tauri visible_on_all_workspaces：全屏 Space 上也能看
	a.detailWin = win
	win.OnFocus(func() { a.usePane(p) }) // 双击剪贴卡追加等外部操作落到最近获得焦点的窗
	win.OnClose(func(*mygo.CloseEvent) {
		if p.win != win && a.detailWin != win {
			return // 已被换成新窗（Destroy 旧窗）
		}
		a.usePane(p)
		a.rememberDetailSize(win) // 记住用户拖过的尺寸，下次打开沿用（同 Tauri TEXT_PREVIEW_SIZED）
		a.saveDetail()
		a.discardBlankDraft()
		a.detailWin, a.detail.id = nil, ""
		a.panes = slices.DeleteFunc(a.panes, func(x *detailPane) bool { return x == p })
		a.trimMemorySoon() // 详情窗全关后清掉内嵌大图
		a.curPane = nil
		if len(a.panes) > 0 {
			a.usePane(a.panes[len(a.panes)-1])
		}
	})
	a.armDetailChrome(p, win)
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
	if a.detail.altEdit { // 翻页前把当前这张的说明存掉
		a.commitImageAlt(n)
	}
	files := a.detailFiles(n)
	if len(files) == 0 {
		return
	}
	i = max(0, min(i, len(files)-1))
	a.detail.img, a.detail.full, a.detail.imgW, a.detail.imgH, a.detail.fullFile = i, nil, 0, 0, files[i]
	a.detail.view, a.detail.pan = fitView, nil // 翻页复位（同 Tauri [gen, idx] → FIT_VIEW）
	a.detail.hi, a.detail.hiFile = nil, ""
	if raw, err := a.store.LoadImage(files[i]); err == nil {
		if src, err := png.Decode(bytes.NewReader(raw)); err == nil {
			a.detail.full = scaledBitmap(src, detailFullW)
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
	if t == n.Text || shotCaption.MatchString(t) && imageNoteText(n) == "" { // 本来就没备注、清空仍是没备注：不算修改
		return
	}
	_ = a.store.Update(n.ID, t)
	prev := n.Text
	a.showHUDUndo("ok", tr("已保存"), func() { _ = a.store.Update(n.ID, prev) }) // 同 Tauri 经主面板保存的可撤销「已保存」
}

func (a *app) detailView(c *ui.Context) {
	registerFonts()
	k, s := tok(c), stok(c)
	n, ok := a.detailNote()
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
	if a.detail.compare != "" { // 回复对比占整窗
		a.compareView(c, k)
		return
	}
	a.detailKeys(c, n)
	if (n.Kind == "image" && a.detail.virt == nil) || a.detail.gallery {
		a.detailImageView(c, k, s, n)
		return
	}
	root := ui.Box(c).Fill()
	a.detail.sel.win, a.detail.sel.ok, a.detail.sel.floor, a.detail.sel.pickBot = root.Bounds(), false, 0, 0
	root.Children(func() {
		ui.Box(c).Absolute().Top(0).Left(0).Right(0).Height(102.4).PassThrough(). // 纯装饰：不挡正文首行的点击 / 划选（选词首行键帽曾点不动）
												LinearGradient(ui.LinearGradient{From: a.detailAccent(n).Alpha(0.26), To: ui.Transparent, Angle: 180})
		a.detailBody(c, k, s, n)
		// 同 Tauri：顶部 40pt 常驻拖动区（标题栏收起时也能拖窗）；正文从 64 开始，不挡首行
		ui.Box(c).Absolute().Top(0).Left(0).Right(0).Height(40).DragWindow().Key("detail-drag")
		_, _, over := root.PointerPosition()
		a.detailChromeTrack(over)
		a.detail.sel.hdr = ui.Rect{}
		if a.detailChromeVisible() {
			// 同 Tauri chromeVisible：贴缘唤出——淡入 + 微移（duration-overlay），收起时淡出
			fade := func(dy float32) ui.ElementTransition {
				return ui.ElementTransition{Duration: 180 * time.Millisecond, Ease: easeStandard, Colors: true,
					Enter: &ui.Motion{Y: dy}, Exit: &ui.Motion{Y: dy}}
			}
			hdr := ui.Column(c).Absolute().Top(0).Left(0).Right(0).Key("detail-chrome-top").Transition(fade(-4))
			a.detail.sel.hdr = hdr.Bounds()
			hdr.Children(func() {
				a.detailHeader(c, k, n)
				if a.detail.virt == nil {
					a.detailTags(c, k, s, n)
				}
			})
			// 坞底同 Tauri .detail-bottom-dock::before：自上而下由透明渐到窗口底色（65% 处实），正文滚到坞下不再和按钮叠字；
			// 容器本身同 pointer-events-none 透传点击，只有按钮接收
			ui.Row(c).Absolute().Left(0).Right(0).Bottom(0).Padding(40, 16, 12, 16).Gap(4).Justify(ui.Center).AlignItems(ui.Center).PassThrough().
				LinearGradient(ui.LinearGradient{From: bg.Alpha(0), To: bg, Angle: 180, Start: 0, End: 0.65}).Key("detail-chrome-dock").Transition(fade(6)).
				Children(func() { a.detailDock(c, k, s, n) })
		}
		if a.detailFindable(n) {
			a.detailProgress(c, k)
			a.detailOutline(c, k)
			a.detailFindBar(c, k)
		} else if a.detail.findOn {
			a.closeDetailFind()
		}
		a.fanoutPicker(c, k, n)
		a.detailThumbStrip(c, k, n) // 同 Tauri：非混排图文卡的缩略条常显在正文与操作坞之间（z 高于坞）
		a.detailSelectionBar(c, k, n)
	})
}

// detailChromeTrack 同 Tauri 无界剧场：光标进窗即唤出，离窗立即收起；打开窗口时先显示，光标不在窗内 2.5s 后收起。
func (a *app) detailChromeTrack(over bool) {
	d := &a.detail
	switch {
	case over:
		d.chromeHidden = false
	case d.chromeOver: // 刚离窗
		d.chromeHidden = true
	}
	d.chromeOver = over
}

// detailChromeVisible：编辑 / 选词 / 标签输入 / 图片说明期间常显（有操作要落地）。
func (a *app) detailChromeVisible() bool {
	d := a.detail
	return !d.chromeHidden || d.edit || d.pick || d.tagOn || d.altEdit
}

// armDetailChrome：打开详情时显示 chrome，2.5s 后光标仍不在窗内就收起（键盘唤出的情形）。
func (a *app) armDetailChrome(p *detailPane, win *mygo.Window) {
	a.detail.chromeHidden, a.detail.chromeOver = false, false
	id := a.detail.id
	time.AfterFunc(2500*time.Millisecond, func() {
		win.Update(func() {
			if a.detailWin != win { // 窗已关 / 已重建
				if p.win != win {
					return
				}
				a.usePane(p)
			}
			if a.detail.id == id && !a.detail.chromeOver {
				a.detail.chromeHidden = true
			}
		})
	})
}

func (a *app) detailKeys(c *ui.Context, n store.Note) {
	ro := a.detail.virt != nil
	if a.reviewKeys(c, n) { // AI 核对中：⌘⏎ / Esc 归它
		return
	}
	if c.Shortcut(ui.Cmd, ui.KeyS) && a.detail.edit { // ⌘S 保留为保存的别名
		a.commitDetailEdit(n)
	}
	if c.Shortcut(ui.Cmd, ui.KeyEnter) && !ro {
		switch {
		case a.detail.imgNote: // 备注编辑中 ⌘⏎ 是保存（同 Tauri）
			a.saveImageNote()
		case a.detail.edit: // 编辑态 ⌘⏎ 只保存不发送（同 Tauri TextPreviewView save）
			a.commitDetailEdit(n)
		default:
			a.sendDetail(n)
		}
	}
	if c.Shortcut(ui.Cmd, ui.KeyF) && a.detailFindable(n) { // ⌘F 文内查找（再按一次回到输入框）
		a.openDetailFind()
	}
	reading := !a.detail.edit && !a.detail.imgNote && !a.detail.tagOn && !a.detail.altEdit && !a.detail.findOn
	if reading && c.Shortcut(ui.Cmd, ui.KeyZ) && a.hudUndo != nil { // 同 Tauri 查看态 ⌘Z：执行 HUD 的撤销
		fn := a.hudUndo
		a.hudUndo = nil
		fn()
		a.showHUD("undone", tr("已撤销"))
	}
	if c.Shortcut(ui.Cmd, ui.KeyW) { // ⌘W 关窗（关窗时保存）
		a.closeDetailWin()
	}
	if a.detail.gallery && !a.detail.altEdit && c.Shortcut(0, ui.KeySpace) { // 看图层：空格同 Esc 回到正文（同 Tauri 预览窗空格关）
		a.exitGallery()
	} else if reading && !a.detail.pick && c.Shortcut(0, ui.KeySpace) { // 同 Tauri Quick Look 习惯：查看态空格关窗
		a.closeDetailWin()
	}
	if (n.Kind == "image" || a.detail.gallery) && !a.detail.imgNote && !a.detail.altEdit {
		if files := a.detailFiles(n); len(files) > 1 {
			if c.Shortcut(0, ui.KeyLeft) && a.detail.img > 0 {
				a.detailImageAt(n, a.detail.img-1)
			}
			if c.Shortcut(0, ui.KeyRight) && a.detail.img < len(files)-1 {
				a.detailImageAt(n, a.detail.img+1)
			}
		}
	}
	if c.Shortcut(ui.Cmd, ui.KeyV) && !a.detail.edit && !a.detail.imgNote && !a.detail.altEdit && !ro { // 阅读态 ⌘V：把剪贴板图片加进当前卡
		a.pasteIntoDetail(n, "")
	}
	if c.Shortcut(0, ui.KeyW) && !a.detail.edit && !a.detail.altEdit && !a.detail.gallery && !a.detail.findOn && n.Kind != "image" && !ro { // W 切换选词模式（同 Tauri）
		a.detail.pick, a.detail.pickAnchor, a.detail.pickEnd = !a.detail.pick, -1, -1
	}
	imgView := (n.Kind == "image" && a.detail.virt == nil) || a.detail.gallery
	if imgView && !a.detail.imgNote && !a.detail.altEdit {
		// 看图层：⌘+ / ⌘− 以窗口中心缩放，⌘0 适配窗口
		switch {
		case c.Shortcut(ui.Cmd, ui.KeyEqual):
			a.zoomStep(zoomKeyStep)
		case c.Shortcut(ui.Cmd, ui.KeyMinus):
			a.zoomStep(1 / zoomKeyStep)
		case c.Shortcut(ui.Cmd, ui.Key0):
			a.detail.view, a.detail.pan = fitView, nil
		}
	}
	// ⌘+ / ⌘− 调字号（10–24），⌘0 复位 12，写回设置（看图层里是缩放）
	if !imgView {
		st := a.store.Settings()
		size, def := &st.DetailFontSize, 12
		if a.msgView() { // 消息放大阅读单独记字号（默认 14，长告警读起来不费劲）
			size, def = &st.MessageFontSize, 14
		}
		fs := *size
		switch {
		case c.Shortcut(ui.Cmd, ui.KeyEqual):
			fs = min(24, fs+1)
		case c.Shortcut(ui.Cmd, ui.KeyMinus):
			fs = max(10, fs-1)
		case c.Shortcut(ui.Cmd, ui.Key0):
			fs = def
		}
		if fs != *size {
			*size = fs
			_ = a.store.SetSettings(st)
		}
	}
	if c.Shortcut(0, ui.KeyEscape) {
		switch {
		case a.detail.altEdit: // 图片说明：Esc 保存并退出（同图片备注条）
			a.commitImageAlt(n)
		case a.detail.gallery: // 看图层先退回正文（编辑草稿原样保留）
			a.exitGallery()
		case a.detail.imgNote: // Esc 保存并退出（同 Tauri）
			a.saveImageNote()
		case a.detail.edit: // 同 Tauri exitEditing：保存并退出；草稿清空了才算放弃
			if a.detailDraftEmpty(n) {
				a.detail.edit, a.detailText, a.detail.title = false, n.Text, n.Title
			} else {
				a.commitDetailEdit(n)
			}
		case a.detail.tagOn:
			a.detail.tagOn, a.detail.tagDraft = false, ""
		case a.detail.fanOpen: // 「同时发到」浮层先关
			a.detail.fanOpen = false
		case a.detail.findOn: // 查找栏先关
			a.closeDetailFind()
		case a.detail.pick && a.detail.pickAnchor >= 0: // 逐层退：先清选中的词，再退选词模式，再关窗
			a.detail.pickAnchor, a.detail.pickEnd = -1, -1
		case a.detail.pick:
			a.detail.pick = false
		default:
			a.closeDetailWin()
		}
	}
}

// detailAccent 同 Tauri accent = headerColor ?? icon.color ?? 中性灰：卡片通栏同款取色——分组色优先（剪贴卡不取），
// 关掉「卡片彩色通栏」时定死中性灰；没有分组色时用来源应用图标主色。只用于顶部晕光。
func (a *app) detailAccent(n store.Note) ui.Color {
	neutral := hexColor("#7c8494")
	if a.store.Settings().CardTintOff {
		return neutral
	}
	if n.Section != store.SectionClipboard {
		for _, s := range a.store.Sections() {
			if s.ID == n.Section && s.Color != "" {
				return hexColor(s.Color)
			}
		}
	}
	if c, ok := a.appIconColor(n.BundleID); ok {
		return c
	}
	return neutral
}

// detailSourceAndSave 同 Tauri 标题栏右端：来源应用图标（20pt 圆角 5）+ 剪贴卡「存入笔记分组」（点开即选分组）。
func (a *app) detailSourceAndSave(c *ui.Context, k tokens, n store.Note) {
	if img := a.appIcon(n.BundleID); img != nil {
		tip := n.SourceApp
		ui.Box(c).Size(20, 20).Radius(5).Clip().Shrink(0).Key("detail-src-icon").Tooltip(cmpOr(tip, n.BundleID)).Label(tr("来自 ") + cmpOr(tip, n.BundleID)).
			Children(func() { ui.Image(c, img).Size(20, 20) })
	}
	if n.Section != store.SectionClipboard || a.detail.virt != nil {
		return
	}
	b := ghostIconButton(c, k, "detail-save-notes", "folder-input", tr("存入笔记分组"), 22, 14, false, true)
	b.Menu(func(m *ui.Menu) {
		m.Item(tr("存入笔记分组")).Disabled(true)
		for _, s := range a.store.Sections() {
			if s.ID == store.SectionClipboard {
				continue
			}
			if m.Item(sectionName(s)).Chosen() {
				a.moveClipsTo([]store.Note{n}, s.ID) // 移走后卡片换到该分组，晕光随即换成分组色（同 Tauri headerColor）
			}
		}
	})
}

func (a *app) detailHeader(c *ui.Context, k tokens, n store.Note) {
	ui.Row(c).Height(38).Padding(8, 12).Gap(8).AlignItems(ui.Center).DragWindow().Children(func() {
		ui.Box(c).Width(52) // 系统红绿灯占位
		if a.detail.edit {  // 同 Tauri 编辑态指示：一枚呼吸主色点 + 小字「编辑中」
			p := stok(c).primary
			ui.Row(c).Gap(6).AlignItems(ui.Center).Shrink(0).Children(func() {
				dot := ui.Box(c).Size(6, 6).Radius(3).Background(p).Shadow(0, 0, 8, 1, p)
				dot.Opacity(1 - 0.5*dot.Loop("edit-pulse", 2*time.Second, ui.Bounce(easePulse))) // animate-pulse
				text(c, tr("编辑中"), 10, 14, 500, p)
			})
		}
		parts := []string{}
		if a.detail.virt != nil {
			parts = append(parts, a.detail.subtitle)
		} else if n.SourceApp != "" {
			parts = append(parts, tr("来自 ")+n.SourceApp)
		} else {
			parts = append(parts, tr("笔记"))
		}
		if a.detail.virt == nil {
			parts = append(parts, tr("创建 ")+ago(n.CreatedAt, a.now()))
		}
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
			Tooltip(fmt.Sprintf(tr("%d 字符 · %d 词 · %d 行"), chars, wordCount(n.Text), strings.Count(n.Text, "\n")+1))
		a.detailSourceAndSave(c, k, n)
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
						t := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(key.Text()), "#"))
						if t == "" { // 同 Tauri commitTagDraft：空回车收起输入
							a.detail.tagDraft, a.detail.tagOn = "", false
							return true
						}
						_ = a.store.SetTags(n.ID, append(slices.Clone(n.Tags), t)) // SetTags 去重、限 8 个、截长
						a.detail.tagDraft = ""                                     // 同 Tauri：回车后保持输入框，方便连续添加
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
		if len(n.Tags) >= store.TagMaxCount { // 同 Tauri：到上限隐藏「＋ 标签」
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
	sc := ui.Scroll(c).Fill().Scrollbars(false).TrackScroll(&a.detail.scroll)
	if a.detail.edit { // 编辑态一圈内嵌描边 + 浅蓝底（同 Tauri editing && bg-primary/[0.04] ring-inset ring-primary/25）
		sc.Background(s.primary.Alpha(0.04)).InsetShadow(0, 0, 0, 1, s.primary.Alpha(0.25))
	}
	if files := sc.DroppedFiles(); len(files) > 0 && a.detail.virt == nil { // 拖入图片文件：追加进当前卡（同 Tauri 详情窗拖入；只读合并预览不收）
		a.dropIntoDetail(n, files)
	}
	if sc.FileDragOver() && a.detail.virt == nil {
		sc.InsetShadow(0, 0, 0, 2, s.primary.Alpha(0.5))
	}
	sc.Children(func() {
		bottom := float32(84)
		if a.detailStripShown(n) {
			bottom += 68 // 给常显缩略条让位
		}
		body := ui.Column(c).Padding(64, 20, bottom, 20)
		if a.detail.enter { // 正文进场：opacity 0 → 1、y 6 → 0，springSnappy（Tauri motion.div key=gen）
			body.Jump("in", 0)
			a.detail.enter = false
		}
		in := body.AnimateTo("in", 1, springSnappy)
		body.Opacity(min(in, 1)).Translate(0, 6*(1-in))
		body.Children(func() {
			switch {
			case n.Kind == "image":
				// 图片卡的文字在备注条里编辑
			case a.detail.edit:
				titleRow := ui.Row(c).Margin(0, 0, 8, 0).Padding(0, 0, 8, 0).BorderWidth(0, 0, 1, 0).BorderColor(k.inputBorder.Alpha(0.5))
				if r := titleRow.Bounds(); r.H > 0 { // 划词工具条不盖标题输入框
					a.detail.sel.floor = r.Y + r.H
				}
				titleRow.Children(func() {
					ui.TextInputBase(c, &a.detail.title).Grow(1).Font(fontSans).FontSize(16).FixedLineHeight(22).FontWeight(600).TextColor(k.fg).
						PlaceholderColor(k.muted.Alpha(0.5)).Placeholder(tr("添加标题（可选）")).Label(tr("笔记标题"))
				})
				if a.detail.blocks != nil && a.detail.editPreview { // 「渲染」：按块预览草稿（文字 Markdown + 内嵌图）
					ui.Column(c).Margin(5.85, 0, 0, 0).Gap(5.85).Key("detail-edit-preview").Children(func() {
						a.detailBlocksRead(c, k, n, a.detail.blocks, a.detailFS(), false)
					})
					break
				}
				if a.detail.blocks != nil {
					a.detailBlocksEdit(c, k, n)
					break
				}
				if a.detail.editPreview { // 「渲染」：预览当前草稿，再点「原文」回到编辑器（同 Tauri editPreviewOn）
					ui.Column(c).Margin(5.85, 0, 0, 0).Gap(5.85).Key("detail-edit-preview").Children(func() {
						renderMarkdown(c, k, a.detailText, a.detailFS())
					})
					break
				}
				ui.Box(c).FillWidth().Margin(5.85, 0, 0, 0).Key("detail-ta").Children(func() { // 外包一层：拖放插入光标画在编辑器同一坐标系
					ta := ui.TextAreaBase(c, &a.detailText).FillWidth().Lines(12, 1000).Font(fontSans).FontSize(13).
						FixedLineHeight(21.125).TextColor(k.fg).AutoFocus().OnPaste(func(t string) bool { return a.pasteIntoDetail(n, t) }) // 只在进编辑时聚焦一次：每帧 Focus 会抢走标题输入框的焦点（标题输入不了）
					if sel := a.detail.editSel; sel[0] >= 0 { // 双击 / 划词进编辑 / 外部插入后：落在同一处（同 Tauri pendingSelectionRef）
						ta.Focus().SetTextSelection(sel[0], sel[1])
						a.detail.editSel = [2]int{-1, -1}
					}
					a.detail.editRange[0], a.detail.editRange[1] = ta.TextSelection()
					a.markEditSelection(ta.Bounds())
					if r, ok := a.detailDropZone(ta, n, a.detailText, -1); ok {
						dropCaret(c, r)
					}
				})
			case a.activeReview(n) != nil:
				a.reviewView(c, k, n, a.detail.review)
			case a.detail.pick:
				a.pickView(c, k, s, n.Text)
			default:
				// 阅读态整块共用一个选区：划词后点「编辑」或双击正文，进编辑时选区落在原文同一处
				read := ui.Column(c).Padding(5.85, 0, 0, 0).Gap(5.85).Selectable().Key("detail-read" + itoa(a.detail.readGen))
				if v, ok := ui.Drop[cardTextDrag](read); ok && a.detail.virt == nil { // 阅读态拖卡片进来：同「添加到打开的卡片」（有划词选区则替换）
					var ns []store.Note
					for _, id := range v.ids {
						if x, ok := a.store.Note(id); ok {
							ns = append(ns, x)
						}
					}
					a.addToOpenCard(ns)
				}
				if _, over := ui.DragOver[cardTextDrag](read); over && a.detail.virt == nil {
					read.Radius(8).Background(stok(c).primary.Alpha(0.05)).InsetShadow(0, 0, 0, 1, stok(c).primary.Alpha(0.35))
				}
				md := a.beginDetailMD(sc.Bounds())
				finding := md.query != ""
				read.Children(func() {
					if finding && (isCode(n) || a.detail.raw) && !store.HasMixedContent(n.Blocks) {
						// 查找中的代码 / 原文：逐行成块（视觉同整段等宽文本），命中才能定位到行；代码着色暂让位给命中标记
						ui.Column(c).Children(func() {
							for i, line := range strings.Split(n.Text, "\n") {
								mdText(c, k, cmpOr(line, " "), 13, 21.125, 400, true).Wrap().Key("fl-" + itoa(i))
							}
						})
					} else if isCode(n) && !a.detail.raw { // 代码卡着色（同 Tauri 详情 highlightCode）
						ui.RichText(c, codeSpans(k, n.Text, n.CodeLang, 0)...).Font(fontMono).FontSize(13).FixedLineHeight(21.125).Wrap()
					} else if a.detail.raw && store.HasMixedContent(n.Blocks) { // 图文卡「原文」：文字原样、图片保留原位
						a.detailBlocksRead(c, k, n, n.Blocks, 0, true)
					} else if a.detail.raw {
						text(c, n.Text, 13, 21.125, 400, k.fg).Font(fontMono).Wrap()
					} else if store.HasMixedContent(n.Blocks) { // 混排卡按块内嵌图片；非混排图文卡图片在底部缩略条（同 Tauri shownImages）
						a.detailRichRead(c, k, n, a.detailFS())
					} else {
						renderMarkdown(c, k, n.Text, a.detailFS())
					}
				})
				a.endDetailMD(c, md, sc.Bounds())
				// 可选文字在按下时就把双击拿去选词，DoubleClicked 收不到；在输入钩子里看点击数、不拦截，
				// 等选词落定（下下帧）再进编辑，编辑器里选中同一个词（同 Tauri 双击正文进编辑）
				read.HandleInput(func(ev ui.InputEvent) bool {
					if ev.Kind == ui.InputPointerDown && ev.Button == 0 && ev.Clicks == 2 && n.Kind != "image" && a.detail.virt == nil {
						a.detail.dblFrames = 2
					}
					a.trackReadPointer(ev)
					return false
				})
				a.detail.readSel = read.SelectedTexts()
				a.markReadSelection(read.Bounds(), a.detailFS())
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
				mdText(c, k, code, 12, 18, 400, true).Wrap()
			})
			i = j + 1
		case hRe.MatchString(line):
			m := hRe.FindStringSubmatch(line)
			size := fs * []float32{1.54, 1.31, 1.15, 1.08, 1, 1}[len(m[1])-1]
			mdHeading(mdText(c, k, m[2], size, size*1.4, 600, false).Wrap(), m[2], len(m[1]))
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
						mdText(c, k, body, fs, lh, 400, false).Wrap().Grow(1).Basis(0)
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
			mdText(c, k, strings.Join(lines[i:j], "\n"), fs, lh, 400, false).Wrap()
			i = j
		}
	}
}

// ---- 选词：按词 / 标点切成可点的块，点两次定区间，复制 / 发送只作用于所选 ----

type pickSeg struct {
	text string
	word bool
}

// pickSegments：系统分词（macos.WordRanges，同 Tauri Intl.Segmenter("zh-Hans") 词粒度）；词之间的空白、标点为不可点的分隔，
// 换行单独成段。paraSegments：按段选取——非空行各成一段，换行为分隔。
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
	d := &a.detail
	if d.segs != nil && d.segSrc == s && d.segPara == d.pickPara {
		return d.segs
	}
	if d.pickPara {
		d.segs = paraSegments(s)
	} else {
		d.segs = pickSegments(s)
	}
	d.segSrc, d.segPara = s, d.pickPara
	return d.segs
}

func pickSegments(s string) []pickSeg {
	var out []pickSeg
	gap := func(t string) { // 分隔：换行单独成段（排版换行用），其余原样保留（同 Tauri 词粒度保留原文标点）
		for i, part := range strings.Split(t, "\n") {
			if i > 0 {
				out = append(out, pickSeg{"\n", false})
			}
			// 开括号 / 开引号单独成段：「：（」这类混合分隔里，冒号随前一词、括号随后一词（pickGroups 避头尾）
			start, prevOpen := 0, false
			for j, r := range part {
				open := strings.ContainsRune(openingPunct, r)
				if j > start && open && !prevOpen {
					out = append(out, pickSeg{part[start:j], false})
					start = j
				}
				prevOpen = open
			}
			if start < len(part) {
				out = append(out, pickSeg{part[start:], false})
			}
		}
	}
	at := 0
	for _, r := range macos.WordRanges(s) {
		gap(s[at:r[0]])
		out = append(out, pickSeg{s[r[0]:r[1]], true})
		at = r[1]
	}
	gap(s[at:])
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
	hint := tr("点词块选中 · 再点另一块扩展范围 · 选好后底部工具条可发送或复制")
	label := tr("选词模式：点选词语，可再点另一词扩展范围")
	if d.pickPara {
		hint = tr("点段落选中 · 再点另一段扩展范围 · 选好后底部工具条可发送或复制")
		label = tr("选段模式：点选段落，可再点另一段扩展范围")
	}
	pickBox := ui.Column(c).Margin(5.85, 0, 0, 0).Label(label)
	if r := pickBox.Bounds(); r.H > 0 { // 选区上方放不下时工具条退到键帽区之下，不盖其他键帽
		a.detail.sel.pickBot = r.Y + r.H
	}
	pickBox.Children(func() {
		if d.pickAnchor < 0 { // 同 Tauri：只在还没选之前出现——选词模式最难懂的是「选完去哪操作」
			text(c, hint, 10, 14, 400, k.muted).Margin(0, 0, 8, 0).Wrap()
		}
		segs := a.segments(src)
		cell := func(i int) { // 一个分隔（标点 / 空白）或键帽
			seg := segs[i]
			on := d.pickAnchor >= 0 && i >= lo && i <= hi
			if !seg.word {
				switch {
				case seg.text == "\n":
					ui.Box(c).FillWidth().Height(0)
				case !d.pickPara: // 词粒度保留原文标点 / 空白（同 Tauri text-muted-foreground，区间内转主色）
					col := k.muted
					if on {
						col = s.primary
					}
					text(c, seg.text, 13, 29, 400, col).Font(fontMono)
				}
				return
			}
			// 键帽（同 Tauri 模板 B：浅底 + 细边 + 底边厚度，选中下沉转主色）
			b := ui.Box(c).Radius(7).Border(1, s.inputBorder.Alpha(0.5)).Background(k.track).Key("pk" + itoa(i))
			if d.pickPara {
				b.FillWidth().Padding(6, 10).Margin(4, 0, 4, 0)
			} else {
				b.Padding(1, 7).Margin(2, 3, 2, 3)
			}
			col := k.fg
			if on {
				b.Background(s.primary).Border(1, s.primary.Alpha(0.6)).Shadow(0, 1, 0, 0, gray(0, 0.45)).Translate(0, 1.5)
				col = gray(0.985, 1)
			} else {
				b.Shadow(0, 2.5, 0, 0, gray(0, 0.35))
				if b.Hovered() {
					b.Opacity(0.9)
				}
			}
			b.Children(func() {
				t := text(c, seg.text, 13, 21, 400, col).Font(fontMono)
				if d.pickPara {
					t.Wrap()
				}
			})
			if on { // 选中键帽的并集是工具条锚点（同 Tauri data-pick-selected）
				a.markSel(b.Bounds())
			}
			if b.Clicked() {
				d.pickAnchor, d.pickEnd = pickClick(d.pickAnchor, d.pickEnd, i)
			}
		}
		ui.Row(c).Wrap().AlignItems(ui.Center).Children(func() {
			for _, g := range pickGroups(segs, d.pickPara) {
				if len(g) == 1 {
					cell(g[0])
					continue
				}
				// 同浏览器避头尾：不在逗号句号前、开括号后折行——标点和相邻键帽同进退
				ui.Row(c).AlignItems(ui.Center).Shrink(0).Children(func() {
					for _, i := range g {
						cell(i)
					}
				})
			}
		})
	})
}

const openingPunct = "（(「『“‘《【[{<"

// pickGroups 把键帽与紧贴的标点编成不可拆的一组（下标保持 segments 的全局下标）：
// 不含空白的分隔并入前一个键帽（，。：@ · 等不落到行首）；纯开括号 / 开引号并入后一个键帽。段粒度不分组。
func pickGroups(segs []pickSeg, para bool) [][]int {
	var out [][]int
	opening := func(t string) bool { return strings.Trim(t, openingPunct) == "" }
	glue := func(t string) bool { return t != "\n" && strings.TrimSpace(t) == t && t != "" }
	for i := 0; i < len(segs); i++ {
		seg := segs[i]
		n := len(out)
		switch {
		case para:
			out = append(out, []int{i})
		case !seg.word && glue(seg.text) && opening(seg.text) && i+1 < len(segs) && segs[i+1].word:
			out = append(out, []int{i, i + 1}) // 开括号 + 后一词
			i++
		case !seg.word && glue(seg.text) && n > 0 && segs[out[n-1][len(out[n-1])-1]].word:
			out[n-1] = append(out[n-1], i) // 收尾标点并入前一词
		default:
			out = append(out, []int{i})
		}
	}
	return out
}

// pickClick 同 Tauri onPickToken：未选 → 选这一块；再点唯一选中的那块 → 取消；否则锚点不动、终点移到这一块。
func pickClick(anchor, end, i int) (int, int) {
	switch {
	case anchor < 0:
		return i, i
	case anchor == i && end == i:
		return -1, -1
	default:
		return anchor, i
	}
}

// ---- 操作坞 ----

func dockButton(c *ui.Context, k tokens, icon, label string, active bool) ui.Element {
	// 不收缩、不折行（同 Tauri whitespace-nowrap）：坞放不下时只截断发送钮里的目标名（选词模式多了词/段切换，曾把「选词」挤成竖排）
	b := ui.Row(c).Height(29).Padding(6, 12).Gap(4).Radius(10).AlignItems(ui.Center).Shrink(0).Key("dock-" + label)
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
		text(c, label, 12, 17, 400, col).SingleLine()
	})
	return b
}

func (a *app) detailDock(c *ui.Context, k tokens, s settingsTokens, n store.Note) {
	d := &a.detail
	if rv := a.activeReview(n); rv != nil {
		a.reviewDock(c, k, n, rv)
		return
	}
	if d.edit { // 同 Tauri 编辑态坞：原文/渲染 · 处理 · 粘贴图片 · 保存 ⌘⏎；自动保存语义，没有「取消」；正文为空时保存置灰
		if !isCode(n) && noteURL(n) == "" { // 图文卡同样可预览（同纯文字卡）
			label := tr("渲染")
			if d.editPreview {
				label = tr("原文")
			}
			if dockButton(c, k, "", label, d.editPreview).Clicked() {
				d.editPreview = !d.editPreview
			}
		}
		if d.blocks != nil || strings.TrimSpace(a.detailText) != "" {
			a.editTextOpMenu(c, k, n)
		}
		img := dockButton(c, k, "image-plus", "", false).Role(ui.RoleButton).Label(tr("粘贴图片（⌘V）")).Tooltip(tr("粘贴图片（⌘V）"))
		if img.Clicked() {
			imgs, _ := a.pasteImages()
			a.addImagesToDetail(n, imgs, tr("剪贴板里没有可用图片"))
		}
		b := dockButton(c, k, "", tr("保存 ⌘⏎"), true)
		if a.detailDraftEmpty(n) {
			b.Opacity(0.5).Tooltip(tr("笔记内容不能为空"))
		}
		if b.Clicked() {
			a.commitDetailEdit(n)
		}
		return
	}
	if d.virt != nil { // 只读合并预览：只看不改不发（同 Tauri readOnly：writable=false 隐藏编辑 / 处理 / 发送）
		if n.Kind != "image" {
			rawLabel := tr("原文")
			if d.raw {
				rawLabel = tr("渲染")
			}
			if dockButton(c, k, "", rawLabel, false).Clicked() {
				d.raw = !d.raw
			}
		}
		if dockButton(c, k, "", tr("复制"), false).Clicked() && !a.copyNoteMedia(n) && n.Text != "" { // 合并预览含图：图文一起复制
			a.copyPrivate(n.Text)
			a.showHUD("ok", tr("已复制"))
		}
		return
	}
	hasText := strings.TrimSpace(n.Text) != ""
	if n.Kind != "image" {
		if hasText && dockButton(c, k, "", tr("选词"), d.pick).Tooltip(tr("选词模式：点选词/段，可发送或复制选中片段（W）")).Clicked() {
			d.pick, d.pickAnchor, d.pickEnd = !d.pick, -1, -1
		}
		if d.pick {
			g := "word"
			if d.pickPara {
				g = "para"
			}
			ui.Row(c).Shrink(0).AlignItems(ui.Center).Children(func() {
				if v, ok := miniSegmented(c, k, g, [][2]string{{"word", "词"}, {"para", "段"}}); ok {
					d.pickPara, d.pickAnchor, d.pickEnd = v == "para", -1, -1
				}
			})
		}
		// 同 Tauri：「原文 / 渲染」只给像 Markdown 的正文（非图文混排、非代码 / 链接、不在选词）；代码卡的着色 / 原文照旧可切
		if (looksLikeMarkdown(n.Text) && !store.HasMixedContent(n.Blocks) && !isCode(n) && n.Kind != "link" && !d.pick) || isCode(n) || d.raw {
			rawLabel := tr("原文")
			if d.raw {
				rawLabel = tr("渲染")
			}
			if dockButton(c, k, "", rawLabel, false).Clicked() {
				d.raw = !d.raw
			}
		}
		if u := noteURL(n); u != "" && dockButton(c, k, "", tr("打开链接"), false).Clicked() {
			_ = exec.Command("/usr/bin/open", u).Start()
		}
		if a.aiBusy == n.ID && a.aiCancel != nil { // AI 改写进行中：可取消（同 Tauri 结果核对的「取消」）
			if dockButton(c, k, "x", tr("取消 AI 请求"), false).Clicked() {
				a.cancelAI()
			}
		}
		if hasText { // 没有文字时不给「处理」（同 Tauri textOpsAvailable）
			proc := dockButton(c, k, "wand-sparkles", tr("处理"), false)
			proc.PopoverMenuButton(func(m *ui.Menu) {
				for _, op := range textOps { // 本地文本处理（同 Tauri TEXT_OPS）：作用于全文，可撤销
					if m.Item(tr(op.label)).Chosen() {
						prev := n                            // 撤销整卡还原
						if store.HasMixedContent(n.Blocks) { // 图文卡逐文字块处理，图片位置不变（同编辑态）
							bs, err := mapTextBlocks(n.Blocks, op.apply)
							if err != nil {
								a.showHUD("warn", tr("处理失败：")+err.Error())
								continue
							}
							_, _ = a.store.SetBlocks(n.ID, bs)
							a.showHUDUndo("ok", tr("已处理 · ")+tr(op.label), func() { a.store.RestoreContent(prev) })
							continue
						}
						out, err := op.apply(n.Text)
						if err != nil {
							a.showHUD("warn", tr("处理失败：")+err.Error())
							continue
						}
						_ = a.store.Update(n.ID, out)
						a.showHUDUndo("ok", tr("已处理 · ")+tr(op.label), func() { a.store.RestoreContent(prev) })
					}
				}
				m.Separator()
				for _, act := range a.allAIActions() {
					if m.Item(tr(act.label)).Chosen() {
						a.runAI(n, act)
					}
				}
			})
		}
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
	editTip := tr("编辑")
	if store.HasMixedContent(n.Blocks) {
		editTip = tr("编辑图文")
	}
	if n.Kind != "image" && dockButton(c, k, "", tr("编辑"), false).Tooltip(editTip).Clicked() {
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
		if _, _, sel := a.detailSelection(n.Text); strings.TrimSpace(sel) != "" && n.Kind != "image" {
			label = tr("发送整卡") // 同 Tauri：选中工具条的「发送选中」露面时，页脚改口「发送整卡」以示区别
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
		sendMenu := func(m *ui.Menu) {
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
			if len(apps) >= 2 && a.detail.virt == nil {
				m.Separator()
				if m.Item(tr("同时发到…")).Chosen() { // 勾 2–3 个应用依次发送，回复可并排对比
					a.detail.fanOpen = true
				}
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
		}
		if a.target.PID == 0 { // 同 Tauri：没有可用目标时点发送钮改为展开目标菜单（窗不关）
			left.Menu(sendMenu).Label(tr("发送：选择目标应用"))
		} else if left.Clicked() {
			a.sendDetail(n)
		}
		right := ui.Box(c).Size(28, 32).Radius(0, 16, 16, 0).Background(fill).Border(1, border).Center().Label(tr("更多发送选项"))
		right.Children(func() { licon(c, "chevron-down", 12, fg) })
		right.Menu(sendMenu)
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
	// 主发送钮 / ⌘⏎ 恒发整卡（同 Tauri send）；只发选中走选中工具条「发送选中」
	if a.detail.edit {
		if !a.commitDetailEdit(n) {
			return
		}
		n.Text = a.detailText
	}
	a.send([]store.Note{n})
	if !a.detail.pinned { // 未固定的窗发送后关闭（同 Tauri：📌 固定才保持打开；片段发送同样）
		a.closeDetailWin()
	}
}

// sendDetailFragment 同 Tauri sendSelection：只发选中文字（图片附件不随行），仍以本卡为来源；
// 没有目标时不发不关窗；未固定的窗发完关闭，与整卡发送一致。
func (a *app) sendDetailFragment(n store.Note, frag string) {
	if strings.TrimSpace(frag) == "" || a.detail.virt != nil {
		return
	}
	if a.target.PID == 0 {
		a.showHUD("warn", tr("没有发送目标：从发送钮右侧下拉「发送到…」选一个应用"))
		return
	}
	a.send([]store.Note{{ID: n.ID, Section: n.Section, SourceApp: n.SourceApp, BundleID: n.BundleID, Text: frag}})
	if !a.detail.pinned {
		a.closeDetailWin()
	}
}

// closeDetailWin 关当前详情窗（OnClose 里保存、回收空白新笔记）；放到帧外执行。
func (a *app) closeDetailWin() {
	if win := a.detailWin; win != nil {
		a.onMain(win.Close)
	}
}

// wordCount 同 Tauri textStats：汉字 / 假名每字一词，ASCII 字母数字（含 _ ' -）连写为一词。
func wordCount(s string) int {
	n, in := 0, false
	for _, r := range s {
		switch {
		case r >= 0x4e00 && r <= 0x9fff || r >= 0x3040 && r <= 0x30ff:
			n, in = n+1, false
		case r < 128 && (r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r == '_' || r == '\'' || r == '-'):
			if !in {
				n++
			}
			in = true
		default:
			in = false
		}
	}
	return n
}

// detailDraftEmpty 同 Tauri draftEmpty && draftImages.length === 0：文字和图片都没了才算空；只留附件图的卡可以保存。
func (a *app) detailDraftEmpty(n store.Note) bool {
	return a.detail.blocks == nil && strings.TrimSpace(a.detailText) == "" && len(n.MediaFiles()) == 0
}

// commitDetailEdit 保存编辑并退出编辑态（⌘⏎ / ⌘S / Esc / 保存钮）。正文为空时 warn 且留在编辑态（同 Tauri save）；
// 有改动时出可撤销的「已保存」（同 Tauri armNoteEditUndo）。
func (a *app) commitDetailEdit(n store.Note) bool {
	if a.detailDraftEmpty(n) {
		a.showHUD("warn", tr("笔记内容不能为空"))
		return false
	}
	before, _ := a.store.Note(n.ID)
	a.saveDetail()
	a.detail.edit, a.detail.editPreview = false, false
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
	a.detail.blocks, a.detail.editPreview = nil, false
	a.detail.blkActive, a.detail.blkRange, a.detail.blkSet = 0, [2]int{}, [3]int{}
	a.detail.editSel = mapReadSelection(n.Text, a.detail.readSel)
	a.detail.editRange = [2]int{-1, -1} // 光标未知：编辑器排出来后才有；外部插入按「追加到末尾」处理
	if a.detail.editSel[0] < 0 {        // 没有划词选区：光标落在正文末尾（面板里点卡片添加进来时接在后面）
		e := len([]rune(n.Text))
		a.detail.editSel = [2]int{e, e}
	}
	if store.HasMixedContent(n.Blocks) {
		a.detail.blocks = slices.Clone(n.Blocks)
		if sel := a.detail.editSel; sel[0] >= 0 { // 划词 / 双击进编辑：落到对应文字块的同一处
			b0, l0, ok0 := store.BlockAtRune(n.Blocks, sel[0])
			b1, l1, ok1 := store.BlockAtRune(n.Blocks, sel[1])
			if ok0 {
				if !ok1 || b1 != b0 {
					l1 = l0
				}
				a.detail.blkActive, a.detail.blkSet = b0+1, [3]int{b0 + 1, l0, l1}
			}
			a.detail.editSel = [2]int{-1, -1}
		}
	}
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
// detailImageView 同 Tauri ImagePreviewView：标题栏「图片 / 图片 i/N」+ 钉住 / 打码 / 标注 / 发送；
// 图片铺满中间区域（object-contain，适配态拖动整窗）；下方备注条与「i / N · W×H」页脚；没有标签行与底部坞。
func (a *app) detailImageView(c *ui.Context, k tokens, s settingsTokens, n store.Note) {
	files := a.detailFiles(n)
	if len(files) == 0 { // 看图层里图被删光：回正文
		a.exitGallery()
		return
	}
	if a.detail.img >= len(files) || files[a.detail.img] != a.detail.fullFile { // 图被替换 / 撤销 / 删除：重载当前张
		a.detailImageAt(n, a.detail.img)
	}
	many := len(files) > 1
	ro := a.detail.virt != nil
	cur := files[a.detail.img]
	ui.Column(c).Fill().Children(func() {
		ui.Row(c).Height(38).Padding(8, 12).Gap(6).AlignItems(ui.Center).DragWindow().Children(func() {
			ui.Box(c).Width(52)   // 系统红绿灯占位
			if a.detail.gallery { // 从图文卡点开：返回正文
				if ghostIconButton(c, k, "img-back", "chevron-left", tr("返回正文（Esc）"), 22, 14, false, true).Clicked() {
					if a.detail.altEdit {
						a.commitImageAlt(n)
					}
					a.exitGallery()
				}
			}
			title := tr("图片")
			if many {
				title = fmt.Sprintf(tr("图片 %d/%d"), a.detail.img+1, len(files))
			}
			text(c, title, 12, 17, 500, k.fg.Alpha(0.8)).Grow(1).Basis(0)
			if a.detail.imgNote { // 同 Tauri：编辑备注时收起标题栏按钮
				return
			}
			pinTip := tr("固定窗口：发送后保持打开")
			if a.detail.pinned {
				pinTip = tr("取消固定（发送后恢复自动关窗）")
			}
			pin := ghostIconButton(c, k, "img-pin", "pin", pinTip, 22, 14, false, true)
			if a.detail.pinned {
				pin.Background(k.track)
			}
			if pin.Clicked() {
				a.detail.pinned = !a.detail.pinned
			}
			if !ro && ghostIconButton(c, k, "img-redact", "shield", tr("图片打码"), 22, 14, false, true).Clicked() { // 作用于当前这张（多图逐张）
				a.onMain(func() { a.openRedactorFile(n, cur) })
			}
			if !ro && ghostIconButton(c, k, "img-annotate", "pen-line", tr("标注 / 裁剪：加标注或裁剪，完成后替换卡片里的原图（可撤销）"), 22, 14, false, true).Clicked() {
				a.onMain(func() { a.annotateFile(n, cur) })
			}
			sendTip := tr("发送")
			if a.target.PID != 0 {
				sendTip = tr("发送到 ") + a.target.Name
			}
			if !ro && ghostIconButton(c, k, "img-send", "send", sendTip, 22, 14, false, true).Clicked() { // 同 Tauri：预览里发送的是整张卡
				a.sendDetail(n)
			}
		})
		area := ui.Box(c).Grow(1).Basis(0).FillWidth().Padding(8).Center().Clip()
		if a.detail.view.zoom <= 1 { // 同 Tauri：适配 / 缩小态整体拖窗，放大后拖拽归平移
			area.DragWindow()
		}
		if files := area.DroppedFiles(); len(files) > 0 && !ro {
			a.dropIntoDetail(n, files)
		}
		area.Children(func() {
			if a.detail.full != nil {
				a.detailZoomLayer(c, a.detail.full)
				defer a.detailZoomControls(c, area.Hovered()) // 最后画：不插在翻页钮前面打乱它们的元素次序
			}
			if !many {
				return
			}
			nav := func(icon, label string, left, disabled bool) {
				col := ui.Box(c).Absolute().Top(0).Bottom(0).Width(28).Center()
				if left {
					col.Left(8)
				} else {
					col.Right(8)
				}
				col.Children(func() {
					b := ui.Box(c).Size(28, 28).Radius(14).Center().Key("img-" + icon).Role(ui.RoleButton).Label(label).Tooltip(label)
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
				})
			}
			nav("chevron-left", tr("上一张"), true, a.detail.img == 0)
			nav("chevron-right", tr("下一张"), false, a.detail.img == len(files)-1)
		})
		if n.Kind == "image" { // 文字备注条只属于图片卡；图文卡的文字在正文里编辑
			a.detailImageCaption(c, k, n)
		}
		var meta []string
		if many {
			meta = append(meta, fmt.Sprintf("%d / %d", a.detail.img+1, len(files)))
		}
		if a.detail.imgW > 0 {
			meta = append(meta, fmt.Sprintf("%d × %d", a.detail.imgW, a.detail.imgH))
		}
		if z := a.detail.view.zoom; z > 1 {
			meta = append(meta, fmt.Sprintf("%d%%", int(math.Round(float64(z)*100))))
		}
		a.imageAltBar(c, k, n, cur, strings.Join(meta, " · "), !ro && (n.Kind != "image" || many))
	})
}

// detailImageCaption 同 Tauri 备注条：border-t px-3 py-1.5；查看态一行截断 + 铅笔，编辑态多行输入 + 保存。
func (a *app) detailImageCaption(c *ui.Context, k tokens, n store.Note) {
	ui.Column(c).FillWidth().Shrink(0).Padding(6, 12).BorderWidth(1, 0, 0, 0).BorderColor(k.inputBorder).Children(func() {
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

// mapTextBlocks：对每个文字块套用 fn，图片块原样。
func mapTextBlocks(bs []store.ContentBlock, fn func(string) (string, error)) ([]store.ContentBlock, error) {
	out := slices.Clone(bs)
	for i, b := range out {
		if b.Type == "image" {
			continue
		}
		t, err := fn(b.Text)
		if err != nil {
			return nil, err
		}
		out[i].Text = t
	}
	return out, nil
}

// editTextOpMenu：编辑态坞的「处理」（同 Tauri renderTextOpMenu 编辑分支）：有选区只处理选中内容并选中结果，
// 否则处理整篇草稿（图文卡逐文字块，图片位置不变）；结果无变化出 info「内容无变化」。改的是草稿，保存时落库。
func (a *app) editTextOpMenu(c *ui.Context, k tokens, n store.Note) {
	scope := tr("处理当前草稿")
	if _, _, sel := a.detailSelection(n.Text); sel != "" {
		scope = tr("处理选中内容")
	}
	dockButton(c, k, "wand-sparkles", tr("处理"), false).Tooltip(scope).PopoverMenuButton(func(m *ui.Menu) {
		for _, op := range textOps {
			if m.Item(tr(op.label)).Chosen() {
				a.applyEditTextOp(n, op.apply)
			}
		}
	})
}

func (a *app) applyEditTextOp(n store.Note, apply func(string) (string, error)) {
	fail := func(err error) { a.showHUD("warn", tr("处理失败：")+err.Error()) }
	if lo, hi, sel := a.detailSelection(n.Text); sel != "" && a.detail.blocks != nil { // 图文卡有选区：只处理选中内容（同纯文字卡）
		out, err := apply(sel)
		if err != nil {
			fail(err)
			return
		}
		if out == sel {
			a.showHUD("info", tr("内容无变化"))
			return
		}
		a.replaceDetailRange(n, lo, hi, out)
		return
	}
	if bs := a.detail.blocks; bs != nil {
		next, changed := slices.Clone(bs), false
		for i, b := range next {
			if b.Type != "text" {
				continue
			}
			out, err := apply(b.Text)
			if err != nil {
				fail(err)
				return
			}
			changed = changed || out != b.Text
			next[i].Text = out
		}
		if !changed {
			a.showHUD("info", tr("内容无变化"))
			return
		}
		a.detail.blocks = next
		return
	}
	if lo, hi, sel := a.detailSelection(n.Text); sel != "" {
		out, err := apply(sel)
		if err != nil {
			fail(err)
			return
		}
		if out == sel {
			a.showHUD("info", tr("内容无变化"))
			return
		}
		a.replaceDetailRange(n, lo, hi, out)
		return
	}
	out, err := apply(a.detailText)
	if err != nil {
		fail(err)
		return
	}
	if out == a.detailText {
		a.showHUD("info", tr("内容无变化"))
		return
	}
	a.detailText = out
	a.detail.editSel = [2]int{len([]rune(out)), len([]rune(out))}
}

// openBatchDetail：发送记录「查看发送内容」含多张来源卡时，按当前仍存在的来源重建只读合并预览
// （同 Tauri openNoteBatchDetail：正文与多卡发送同一拼法，图片去重附后；单卡照旧开原详情）。
func (a *app) openBatchDetail(src []store.Note, expected int) {
	if len(src) == 0 {
		return
	}
	if len(src) == 1 && expected <= 1 {
		openDetailFn(a, src[0])
		return
	}
	var texts, files []string
	for _, n := range src {
		if t := imageNoteText(n); strings.TrimSpace(t) != "" {
			texts = append(texts, t)
		}
		for _, f := range n.MediaFiles() {
			if !slices.Contains(files, f) {
				files = append(files, f)
			}
		}
	}
	v := store.Note{ID: "delivery-source-" + strconv.FormatInt(a.now().UnixNano(), 36), Title: tr("合并发送内容"), CreatedAt: a.now()}
	if len(texts) > 0 {
		v.Text, v.Attachments = sendText(texts), files
	} else if len(files) > 0 {
		v.Kind, v.ImageFile, v.Attachments = "image", files[0], files[1:]
	}
	exp := max(len(src), expected)
	count := fmt.Sprintf(tr("%d 张当前来源卡片"), len(src))
	if len(src) != exp {
		count = fmt.Sprintf(tr("%d/%d 张当前可用来源卡片"), len(src), exp)
	}
	openDetailFn(a, v)
	a.detail.virt, a.detail.subtitle = &v, count+tr(" · 发送记录不保存正文")
}

// looksLikeMarkdown 同 Tauri markdownDetection：标题 / 列表 / 引用 / 代码围栏 / 粗斜体 / 链接 / 行内代码。
var mdLike = regexp.MustCompile("(^|\\n)\\s{0,3}(#{1,6}\\s|[-*+]\\s|\\d+\\.\\s|>\\s|```)|\\*\\*[^*\\n]+\\*\\*|(^|[^*])\\*[^*\\s]([^*\\n]*\\S)?\\*([^*]|$)|\\[[^\\]\\n]+\\]\\([^)\\n]+\\)|`[^`\\n]+`")

func looksLikeMarkdown(s string) bool { return mdLike.MatchString(s) }
