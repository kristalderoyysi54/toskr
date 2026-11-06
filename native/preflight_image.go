package main

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"slices"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/shot"
)

// 图片隐私检查（同 Tauri ImageFirewallPanel + evaluateImageFirewallPolicy）：发送前对图片卡本机 OCR，
// 命中的文字区域逐项「遮挡（不可逆纯色）/ 保留原文」，可整图遮挡或全部不遮挡；OCR 失败时 requireRedaction 禁止发原图，
// 其余策略要显式确认。遮挡只作用于发送副本，原图不改。

var (
	pfOCR = ocrImage                  // 测试替换
	pfGo  = func(f func()) { go f() } // 测试里同步执行（无面板时 onMain 直接跑，异步会与帧竞争）
)

type pfRegion struct {
	id, cat, kind string
	box           shot.PxBox
}

func (r pfRegion) block() bool { return !slices.Contains(core.WarnCategories, r.cat) }

type pfImage struct {
	note     int
	status   string // scanning | ready | failed | disabled
	err      string
	img      *image.RGBA
	regions  []pfRegion
	masked   map[string]bool
	kept     map[string]bool
	rawOK    bool // 未经 OCR 的原图已确认发送
	gen      int
	thumb    *ui.Bitmap // 实际发送图（遮挡后）缩略
	thumbKey string
}

// imageRegions：OCR 行 → 敏感区域（按字符比例截框，外扩 2px），带类别。
func imageRegions(lines []macos.OCRLine, W, H int, rules core.Rules) []pfRegion {
	var out []pfRegion
	for li, l := range lines {
		total := utf8.RuneCountInString(l.Text)
		if total == 0 {
			continue
		}
		for _, f := range core.Scan(l.Text, rules) {
			s, e := utf8.RuneCountInString(l.Text[:f.Start]), utf8.RuneCountInString(l.Text[:f.End])
			x0 := l.X + l.W*float64(s)/float64(total) - 2
			x1 := l.X + l.W*float64(e)/float64(total) + 2
			if b, ok := shot.BoxFromDrag(x0, l.Y-2, x1, l.Y+l.H+2, W, H); ok {
				out = append(out, pfRegion{id: fmt.Sprintf("%s:%d:%d", f.Rule, li, f.Start), cat: f.Category, kind: f.Kind, box: b})
			}
		}
	}
	return out
}

func decodeRGBA(raw []byte) (*image.RGBA, error) {
	src, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, errors.New(tr("图片读取失败"))
	}
	img := image.NewRGBA(image.Rect(0, 0, src.Bounds().Dx(), src.Bounds().Dy()))
	draw.Draw(img, img.Rect, src, src.Bounds().Min, draw.Src)
	return img, nil
}

// pfScanImages 为待发送的图片卡（重新）跑 OCR；隐私检查关闭时标 disabled。
func (a *app) pfScanImages() {
	p := &a.pf
	rules := a.scanRules()
	old := p.images
	p.images = nil
	for i, n := range a.pending {
		if n.Kind != "image" || n.ImageFile == "" {
			continue
		}
		im := &pfImage{note: i, status: "scanning", masked: map[string]bool{}, kept: map[string]bool{}}
		for _, o := range old {
			if o.note == i {
				im.gen = o.gen + 1
			}
		}
		p.images = append(p.images, im)
		if rules.Off {
			im.status = "disabled"
			continue
		}
		raw, err := a.store.LoadImage(n.ImageFile)
		if err == nil {
			im.img, err = decodeRGBA(raw)
		}
		if err != nil {
			im.status, im.err = "failed", err.Error()
			continue
		}
		img, gen := im.img, im.gen
		pfGo(func() {
			lines, err := pfOCR(img)
			a.onMain(func() {
				if !slices.Contains(a.pf.images, im) || im.gen != gen {
					return // 已取消或已重新检测
				}
				if err != nil {
					im.status, im.err = "failed", err.Error()
					return
				}
				im.regions, im.status = imageRegions(lines, img.Rect.Dx(), img.Rect.Dy(), rules), "ready"
			})
		})
	}
}

// pfImageEval 同 Tauri evaluateImageFirewallPolicy。
func (a *app) pfImageEval(policy string) pfEval {
	p := &a.pf
	var e pfEval
	if len(p.images) == 0 || !slices.ContainsFunc(p.images, func(im *pfImage) bool { return im.status != "disabled" }) {
		e.canSend = true
		return e
	}
	for _, im := range p.images {
		if im.status == "scanning" {
			e.noEnter, e.unresolved, e.reason = true, e.unresolved+1, tr("图片本地隐私检查尚未完成")
		}
	}
	if e.reason != "" {
		return e
	}
	failedOK, failed := true, 0
	for _, im := range p.images {
		if im.status == "failed" {
			failed++
			failedOK = failedOK && im.rawOK
		}
	}
	if failed > 0 && (policy == "requireRedaction" || policy == "" || !failedOK) {
		e.noEnter, e.unresolved = true, failed
		if policy == "requireRedaction" || policy == "" {
			e.reason = tr("图片 OCR 失败；当前方案禁止发送未经检查的原图")
		} else {
			e.needRaw, e.reason = "block", tr("图片 OCR 失败，请显式确认本次发送未经检查的原图")
		}
		return e
	}
	var unresolved, ub, uw int
	anyBlock := failed > 0
	for _, im := range p.images {
		for _, r := range im.regions {
			anyBlock = anyBlock || r.block()
			if im.masked[r.id] || im.kept[r.id] {
				continue
			}
			unresolved++
			if r.block() {
				ub++
			} else {
				uw++
			}
		}
	}
	e.unresolved, e.noEnter = unresolved, anyBlock
	switch policy {
	case "requireRedaction", "":
		e.canSend = unresolved == 0
		if !e.canSend {
			e.reason = tr("请遮挡或逐项明确保留全部图片敏感区域")
		}
	case "confirmRaw":
		switch {
		case ub > 0:
			e.noEnter, e.reason = true, tr("图片高风险区域必须遮挡或逐项明确保留")
		case uw > 0 && p.imgRaw != "warn" && p.imgRaw != "block":
			e.needRaw, e.reason = "warn", tr("请确认本次保留图片中的提示级原文")
		default:
			e.canSend = true
		}
	default:
		if ub > 0 && p.imgRaw != "block" {
			e.needRaw, e.reason = "block", tr("图片高风险原文需要再次确认")
		} else {
			e.canSend = true
		}
	}
	return e
}

// maskedPNG：有遮挡时返回发送副本（实色不可逆），否则 nil = 发原图。
func (im *pfImage) maskedPNG() []byte {
	var regs []shot.Region
	for _, r := range im.regions {
		if im.masked[r.id] {
			regs = append(regs, shot.Region{PxBox: r.box, Style: shot.RedactStyle{Kind: shot.RedactSolid, Color: shot.RedactBlack}})
		}
	}
	if len(regs) == 0 || im.img == nil {
		return nil
	}
	var buf bytes.Buffer
	if png.Encode(&buf, shot.ApplyRedactions(im.img, regs)) != nil {
		return nil
	}
	return buf.Bytes()
}

func (a *app) pfMaskImages(sel func(*pfImage, pfRegion) bool, mask bool) {
	for _, im := range a.pf.images {
		for _, r := range im.regions {
			if sel(im, r) {
				if mask {
					im.masked[r.id], im.kept[r.id] = true, false
				} else {
					im.kept[r.id], im.masked[r.id] = true, false
				}
			}
		}
		im.thumbKey = ""
	}
}

func imageStatusLine(im *pfImage) string {
	switch im.status {
	case "scanning":
		return tr("本地 OCR 中…")
	case "failed":
		return tr("OCR 失败：") + im.err
	case "disabled":
		return tr("检查已关闭 · 发送原图")
	}
	n, masked := len(im.regions), 0
	for _, r := range im.regions {
		if im.masked[r.id] {
			masked++
		}
	}
	switch {
	case n == 0:
		return tr("无敏感区域，发送原图")
	case masked > 0:
		return fmt.Sprintf(tr("%d 项 · 已遮挡 %d 处 · 发送副本"), n, masked)
	}
	return fmt.Sprintf(tr("%d 项 · 发送原图"), n)
}

// pfImagesSection：预检条里的图片隐私分区。
func (a *app) pfImagesSection(c *ui.Context, k tokens, policy string) {
	t := c.Theme()
	p := &a.pf
	if len(p.images) == 0 {
		return
	}
	var act func()
	defer func() {
		if act != nil {
			act()
		}
	}()
	ui.Column(c).Gap(6).Padding(6, 8).Radius(8).Background(t.Background.Alpha(0.6)).Key("pf-images").Children(func() {
		text(c, fmt.Sprintf(tr("图片隐私检查 · %d 张"), len(p.images)), 12, 17, 600, k.fg)
		for i, im := range p.images {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Key(fmt.Sprintf("pf-img-%d", i)).Children(func() {
				if bm := a.pfThumb(im); bm != nil {
					w, h := float32(im.img.Rect.Dx()), float32(im.img.Rect.Dy())
					ui.Image(c, bm).Size(min(48*w/max(h, 1), 96), 48).Radius(4).Tooltip(tr("实际发送"))
				}
				text(c, imageStatusLine(im), 11, 16, 400, k.muted).Wrap().Grow(1).Basis(0)
				if im.status == "failed" {
					if button(c, stok(c), "重试 OCR") {
						act = a.pfScanImages
					}
				}
			})
			if !p.open {
				continue
			}
			for _, r := range im.regions {
				masked, kept := im.masked[r.id], im.kept[r.id]
				ui.Row(c).Gap(6).Padding(2, 4).AlignItems(ui.Center).Key("pf-reg-" + r.id).Children(func() {
					col := k.amberText
					if r.block() {
						col = k.danger
					}
					text(c, r.kind, 11, 16, 400, col).SingleLine()
					text(c, fmt.Sprintf(tr("图片 %d 敏感区域"), i+1), 11, 16, 400, k.muted).SingleLine().Grow(1).Basis(0)
					switch {
					case masked:
						text(c, tr("已遮挡"), 11, 16, 400, k.muted).SingleLine()
					case kept:
						text(c, tr("已确认保留原文"), 11, 16, 400, k.muted).SingleLine()
					}
					id, cat := r.id, r.cat
					if !masked && ghostIconButton(c, k, "pf-mask-"+id, "eraser", tr("遮挡此文字区域"), 22, 13, false, true).Clicked() {
						act = func() { a.pfMaskImages(func(_ *pfImage, x pfRegion) bool { return x.id == id }, true) }
					}
					if !kept && ghostIconButton(c, k, "pf-ikeep-"+id, "check", tr("保留原文发送"), 22, 13, false, true).Clicked() {
						act = func() { a.pfMaskImages(func(_ *pfImage, x pfRegion) bool { return x.id == id }, false) }
					}
					m := ghostIconButton(c, k, "pf-imore-"+id, "ellipsis", tr("同类处理"), 22, 13, false, true)
					m.Menu(func(mm *ui.Menu) {
						if mm.Item(tr("同类全部保留")).Chosen() {
							act = func() { a.pfMaskImages(func(_ *pfImage, x pfRegion) bool { return x.cat == cat }, false) }
						}
						if mm.Item(tr("遮挡此图全部")).Chosen() {
							target := im
							act = func() { a.pfMaskImages(func(y *pfImage, _ pfRegion) bool { return y == target }, true) }
						}
					})
				})
			}
		}
		hasRegions := slices.ContainsFunc(p.images, func(im *pfImage) bool { return len(im.regions) > 0 })
		if hasRegions {
			ui.Row(c).Gap(6).Children(func() {
				if ui.Button(c, tr("遮挡全部图片敏感区域")).Clicked() {
					act = func() { a.pfMaskImages(func(*pfImage, pfRegion) bool { return true }, true) }
				}
				if ui.Button(c, tr("图片全部不遮挡")).Tooltip(tr("本次图片全部不遮挡，按原图发出；文字脱敏不受影响")).Clicked() {
					act = func() { a.pfMaskImages(func(*pfImage, pfRegion) bool { return true }, false) }
				}
			})
		}
		if policy != "requireRedaction" && policy != "" && slices.ContainsFunc(p.images, func(im *pfImage) bool { return im.status == "failed" && !im.rawOK }) {
			if ui.Button(c, tr("确认发送未经 OCR 的原图")).Clicked() {
				act = func() {
					for _, im := range a.pf.images {
						if im.status == "failed" {
							im.rawOK = true
						}
					}
				}
			}
		}
		text(c, tr("OCR 仅在本机运行；遮挡使用不可逆纯色，原图不会修改"), 10, 14, 400, k.muted).Wrap()
	})
}

// pfThumb：实际发送图的缩略（遮挡变化后重算）。
func (a *app) pfThumb(im *pfImage) *ui.Bitmap {
	if im.img == nil {
		return nil
	}
	key := im.status
	for _, r := range im.regions {
		if im.masked[r.id] {
			key += "|" + r.id
		}
	}
	if im.thumb != nil && im.thumbKey == key {
		return im.thumb
	}
	src := im.img
	var regs []shot.Region
	for _, r := range im.regions {
		if im.masked[r.id] {
			regs = append(regs, shot.Region{PxBox: r.box, Style: shot.RedactStyle{Kind: shot.RedactSolid, Color: shot.RedactBlack}})
		}
	}
	if len(regs) > 0 {
		src = shot.ApplyRedactions(src, regs)
	}
	im.thumb, im.thumbKey = ui.NewBitmap(src), key
	return im.thumb
}
