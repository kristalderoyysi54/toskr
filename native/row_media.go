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

// 列表行共用的小件：行首 18 小图标、把原图拖出到其他应用。

// listLead：行首 18 小图标：来源应用图标 > 链接站标 > 类型图标。
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

// imageDragOut：按住缩略图拖出 = 把原图（PNG）交给其他应用。同时给 PNG 数据和文件：聊天 / 文档类应用收数据，
// Finder / 上传框收文件。图片是加密存的，拖出时解到 0700 临时目录（每次拖出前清空上一次的，拖完 1 分钟后删除）。
// 拖出源会接走按下：单击 / 双击转交给所在行（同正文拖出，见 cardPressed）。
func (a *app) imageDragOut(e ui.Element, n store.Note, files []string) {
	if rowUnified { // 笔记页的行整行拖（rowDragOut），缩略图不单独是拖出源；点它仍转交给所在行
		if e.Clicked() || e.DoubleClicked() {
			textHit = cardTextHit{id: n.ID, click: e.Clicked(), dbl: e.DoubleClicked(), mods: e.ClickModifiers()}
		}
		return
	}
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
