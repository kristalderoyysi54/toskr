package main

import (
	"bytes"
	"image"
	"image/png"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
	"golang.org/x/image/draw"

	"github.com/toskr/native/internal/store"
)

// 竖版列表行的 5 种行首布局（用户 2026-11-17：给多个布局选，设置 → 语言与显示 → 列表样式）。
//   - tiles  方块：每行一个 36 方块——带图是缩略图，无图是应用图标放在它主色的浅底里；整列同尺寸同圆角
//   - trail  右图：左列恒为 18 小应用图标，图片缩略放在行尾
//   - mail   邮件：没有图标列，文字顶格；应用图标缩进次行行首，图片缩略放在行尾
//   - avatar 头像：圆形——应用头像 / 圆形裁切缩略图
//   - film   胶片：同方块，多图行次行是一排小缩略
// 所有缩略图共用：多图身后叠放（悬停扇形展开）、停留 360ms 弹原图窥视窗（← → 换张）、按住拖出原图到其他应用。

const (
	listTiles  = "tiles"
	listTrail  = "trail"
	listMail   = "mail"
	listAvatar = "avatar"
	listFilm   = "film"
)

var listStyles = []string{listTiles, listTrail, listMail, listAvatar, listFilm, listCard, listSide, listHero}

var listStyleNames = map[string]string{listTiles: "方块", listTrail: "右图", listMail: "邮件", listAvatar: "头像", listFilm: "胶片",
	listCard: "卡片 · 图片条", listSide: "卡片 · 图文左右", listHero: "卡片 · 大图在上"}

func (a *app) listStyle() string {
	s := a.store.Settings().NoteListStyle
	for _, x := range listStyles {
		if x == s {
			return s
		}
	}
	return listSide // 用户 2026-11-17 选定「卡片 · 图文左右」为默认
}

// listTextX：文字起点（分隔线从这里画起）。
func (a *app) listTextX() float32 {
	switch a.listStyle() {
	case listTrail, listCard, listSide, listHero:
		return listPadX + listIcon + listGap
	case listMail:
		return listPadX
	}
	return listPadX + listLeadW + listGap
}

// listThumbOf：行首 / 行尾要显示的缩略图（带图且未模糊、缩略已就绪）。
func (a *app) listThumbOf(n store.Note) ui.ImageSource {
	if files := n.MediaFiles(); len(files) > 0 && !n.Blur {
		return a.thumb(files[0])
	}
	return nil
}

// thumbCover：把 src 铺满裁切进 b（圆角或圆形），加一圈细内描边。
func (a *app) thumbCover(c *ui.Context, k tokens, b ui.Element, src ui.ImageSource, round bool) {
	r := rr(9)
	if round {
		r = listTile / 2
	}
	b.Radius(r).Clip().Center().Background(k.track).Children(func() {
		w, h := ui.ImageSize(src)
		sc := listTile / max(min(float32(w), float32(h)), 1)
		ui.Image(c, src).Size(float32(w)*sc, float32(h)*sc)
		ui.Box(c).Absolute().Left(0).Top(0).Right(0).Bottom(0).Radius(r).Border(1, k.fg.Alpha(0.08)).PassThrough()
	})
}

// listThumbStack：36 缩略图 + 身后 1–2 张叠放卡。方形版错开旋转、悬停扇形展开；圆形版横向错开、悬停拉开。
func (a *app) listThumbStack(c *ui.Context, k tokens, n store.Note, img ui.ImageSource, active, round bool) {
	files := n.MediaFiles()
	for i := min(len(files), 3) - 1; i >= 1; i-- {
		src := a.thumb(files[i])
		if src == nil {
			continue
		}
		fi := float32(i)
		pose := ui.Pose{X: fi * 3.5, Y: -fi * 2, Rotate: fi * 8, Scale: 1 - fi*0.06}
		if active { // 悬停：扇形展开
			pose = ui.Pose{X: fi * 6, Y: -fi * 3, Rotate: fi * 15, Scale: 1 - fi*0.06}
		}
		if round {
			pose = ui.Pose{X: fi * 3, Scale: 1 - fi*0.1}
			if active {
				pose.X = fi * 5
			}
		}
		back := ui.Box(c).Absolute().Left(2).Top(2).Size(listTile, listTile).Border(1.5, k.card).Shadow(0, 1, 3, 0, k.floatShadowA).PassThrough().
			Key("stack-" + itoa(i))
		back.AnimatePose(pose, springControl)
		a.thumbCover(c, k, back, src, round)
	}
	front := ui.Box(c).Absolute().Left(2).Top(2).Size(listTile, listTile).Shadow(0, 1, 2, 0, k.floatShadowA).Key("thumb-front").Label(tr("拖出原图"))
	front.AnimatePose(ui.Pose{Scale: map[bool]float32{true: 1.06, false: 1}[active]}, springControl)
	a.thumbCover(c, k, front, img, round)
	if round && len(files) > 1 { // 圆形没有旋转叠放的层次感：补张数小角标
		ui.Box(c).Absolute().Right(0).Bottom(0).Height(14).MinWidth(14).Padding(0, 3).Radius(7).Background(k.fg).Border(1.5, k.card).Center().PassThrough().
			Children(func() { text(c, itoa(len(files)), 8.5, 11, 700, k.card) })
	}
	a.compactHover(c, front, n) // 停留弹原图窥视窗（与紧凑行同一套：不抢焦点、← → 换张）
	a.imageDragOut(front, n, files)
}

// listTileIcon：无图行的 36 方块（或圆）：来源应用图标放在用它主色调出的浅底里；没有应用图标用类型图标 + 类型色。
func (a *app) listTileIcon(c *ui.Context, k tokens, n store.Note, active, round bool) {
	icon, kindTint := "file-text", k.fg
	switch {
	case n.Kind == "link":
		icon, kindTint = "link-2", oklch(0.62, 0.15, 250, 1)
	case isCode(n):
		icon, kindTint = "braces", oklch(0.6, 0.17, 295, 1)
	case n.Kind == "image":
		icon = "image"
	}
	appImg := a.appIcon(n.BundleID)
	tint, ok := a.appIconColor(n.BundleID)
	if !ok || appImg == nil {
		tint = kindTint
	}
	bgA, edgeA := float32(0.11), float32(0.16)
	if k.dark {
		bgA, edgeA = 0.2, 0.24
	}
	if tint == k.fg { // 中性文字：灰底
		bgA, edgeA = 0.05, 0.08
	}
	r := rr(9)
	if round {
		r = listTile / 2
	}
	tile := ui.Box(c).Absolute().Left(2).Top(2).Size(listTile, listTile).Radius(r).Center().
		LinearGradient(ui.LinearGradient{From: tint.Alpha(bgA * 1.4), To: tint.Alpha(bgA * 0.6), Angle: 160}).Border(1, tint.Alpha(edgeA)).PassThrough()
	tile.AnimatePose(ui.Pose{Scale: map[bool]float32{true: 1.06, false: 1}[active]}, springControl)
	tile.Children(func() {
		switch {
		case appImg != nil:
			ui.Image(c, appImg).Size(24, 24)
		case n.Kind == "link" && a.favicon(n.LinkIcon) != nil:
			a.linkFavicon(c, n, 18)
		default:
			col := kindTint
			if tint == k.fg {
				col = k.muted
			}
			licon(c, icon, 16, col)
		}
	})
}

// listLead：右图样式的左列 18 小图标：来源应用图标 > 链接站标 > 类型图标。
func (a *app) listLead(c *ui.Context, k tokens, n store.Note) {
	const sz = listIcon
	ui.Box(c).Size(sz, sz).Center().Shrink(0).Children(func() {
		if img := a.appIcon(n.BundleID); img != nil {
			ui.Image(c, img).Size(sz, sz)
			return
		}
		if n.Kind == "link" && a.favicon(n.LinkIcon) != nil {
			a.linkFavicon(c, n, 14)
			return
		}
		icon := "file-text"
		switch {
		case n.Kind == "link":
			icon = "link-2"
		case isCode(n):
			icon = "braces"
		case n.Kind == "image":
			icon = "image"
		}
		licon(c, icon, 14, k.muted)
	})
}

// filmStrip：胶片样式多图行的次行——一排 16 高小缩略（最多 6 张，余下写 +N）。
func (a *app) filmStrip(c *ui.Context, k tokens, n store.Note) {
	files := n.MediaFiles()
	for i, f := range files {
		if i == 6 {
			text(c, "+"+itoa(len(files)-6), 10, 14, 500, k.muted).Shrink(0)
			break
		}
		src := a.thumb(f)
		if src == nil {
			continue
		}
		b := ui.Box(c).Size(22, 16).Radius(4).Clip().Center().Background(k.track).Shrink(0).PassThrough()
		b.Children(func() {
			w, h := ui.ImageSize(src)
			sc := max(22/max(float32(w), 1), 16/max(float32(h), 1))
			ui.Image(c, src).Size(float32(w)*sc, float32(h)*sc)
		})
	}
	text(c, cardImageMeta(n), 10.5, 16, 400, k.muted).SingleLine().Shrink(1)
}

// imageDragOut：按住缩略图拖出 = 把原图（PNG）交给其他应用。同时给 PNG 数据和文件：聊天 / 文档类应用收数据，
// Finder / 上传框收文件。图片是加密存的，拖出时解到 0700 临时目录（每次拖出前清空上一次的，拖完 1 分钟后删除）。
// 拖出源会接走按下：单击 / 双击转交给所在行（同正文拖出，见 cardPressed）。
func (a *app) imageDragOut(e ui.Element, n store.Note, files []string) {
	var opts []transfer.DragOptions
	if e.Hovered() && len(files) > 0 {
		if prev := a.dragThumbPreview(files[0]); prev != nil {
			opts = append(opts, transfer.DragOptions{Preview: prev, Hotspot: image.Pt(prev.Bounds().Dx()/2, prev.Bounds().Dy()/2),
				Done: func(transfer.Result) { time.AfterFunc(time.Minute, cleanImageDragDir) }})
		}
	}
	tipOf(buildCtx, e.DragDataFrom(func() transfer.Data { return a.imageDragData(files) }, opts...), tr("拖出原图到其他应用；停留预览大图"))
	if e.Clicked() || e.DoubleClicked() {
		textHit = cardTextHit{id: n.ID, click: e.Clicked(), dbl: e.DoubleClicked(), mods: e.ClickModifiers()}
	}
}

func imageDragDir() string { return filepath.Join(os.TempDir(), "toskr-drag") }

func cleanImageDragDir() { _ = os.RemoveAll(imageDragDir()) }

func (a *app) imageDragData(files []string) transfer.Data {
	cleanImageDragDir()
	dir := imageDragDir()
	if os.MkdirAll(dir, 0o700) != nil {
		return transfer.Data{}
	}
	var items []transfer.Item
	for i, f := range files {
		raw, err := a.store.LoadImage(f)
		if err != nil {
			continue
		}
		path := filepath.Join(dir, "Toskr-"+time.Now().Format("20060102-150405")+"-"+itoa(i+1)+".png")
		if os.WriteFile(path, raw, 0o600) != nil {
			continue
		}
		u := (&url.URL{Scheme: "file", Path: path}).String()
		items = append(items, transfer.NewItem(transfer.Bytes(transfer.PNG, raw), transfer.Bytes(transfer.FileList, []byte(u)), transfer.Bytes(transfer.URIList, []byte(u))))
	}
	return transfer.New(items...)
}

// dragThumbPreview：拖出时跟手的小图（最长边 96 像素，按文件缓存一张）。
func (a *app) dragThumbPreview(file string) image.Image {
	if a.dragPrevFile == file && a.dragPrev != nil {
		return a.dragPrev
	}
	raw, err := a.store.LoadImage(file)
	if err != nil {
		return nil
	}
	src, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil
	}
	b := src.Bounds()
	s := 96 / float64(max(b.Dx(), b.Dy(), 1))
	dst := image.NewRGBA(image.Rect(0, 0, max(1, int(float64(b.Dx())*s)), max(1, int(float64(b.Dy())*s))))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
	a.dragPrevFile, a.dragPrev = file, dst
	return dst
}
