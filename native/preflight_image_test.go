package main

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

type pngSys struct {
	recSys
	pmu  sync.Mutex
	pngs [][]byte
}

func (r *pngSys) Write(items []macos.Item, enter bool) int {
	if len(items) > 0 {
		r.pmu.Lock()
		r.pngs = append(r.pngs, items[0][macos.TypePNG])
		r.pmu.Unlock()
	}
	return r.recSys.Write(items, enter)
}

func whitePNG(t *testing.T, w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = 255
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func imageNote(t *testing.T, a *app) store.Note {
	name, err := a.store.SaveImage(whitePNG(t, 200, 40))
	if err != nil {
		t.Fatal(err)
	}
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", ImageFile: name, ImageW: 200, ImageH: 40, Text: "图片 200×40"})
	return n
}

func TestImagePrivacyMaskAndSend(t *testing.T) {
	orig, origGo := pfOCR, pfGo
	t.Cleanup(func() { pfOCR, pfGo = orig, origGo })
	pfGo = func(f func()) { f() }
	pfOCR = func(img *image.RGBA) ([]macos.OCRLine, error) {
		return []macos.OCRLine{{Text: "mail " + "carol" + "@corp.io", X: 0, Y: 10, W: 200, H: 20}}, nil
	}
	a, tt := testApp(t)
	sys := &pngSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	n := imageNote(t, a)
	a.send([]store.Note{n})
	tt.Frame()
	waitFor(t, func() bool { tt.Frame(); return len(a.pf.images) == 1 && a.pf.images[0].status == "ready" })
	tt.Frame()
	if !tt.HasText("图片隐私检查 · 1 张") || !tt.HasText("1 项 · 发送原图") || len(sys.sent()) != 0 {
		t.Fatalf("应拦下等处理 %v", tt.Texts())
	}
	_ = tt.Click("遮挡全部敏感区域")
	tt.Frame()
	if !tt.HasText("1 项 · 已遮挡 1 处 · 发送副本") {
		t.Fatalf("%v", tt.Texts())
	}
	_ = tt.Click("发送")
	waitFor(t, func() bool { sys.pmu.Lock(); defer sys.pmu.Unlock(); return len(sys.pngs) > 0 })
	sys.pmu.Lock()
	sent := sys.pngs[0]
	sys.pmu.Unlock()
	img, err := png.Decode(bytes.NewReader(sent))
	if err != nil {
		t.Fatal(err)
	}
	if c := color.RGBAModel.Convert(img.At(100, 20)).(color.RGBA); c.R > 60 {
		t.Fatalf("命中区域应被实色遮挡，实为 %v", c)
	}
	if c := color.RGBAModel.Convert(img.At(2, 2)).(color.RGBA); c.R != 255 {
		t.Fatalf("区域外应保持原样，实为 %v", c)
	}
	if raw, _ := a.store.LoadImage(n.ImageFile); !bytes.Equal(raw, whitePNG(t, 200, 40)) {
		t.Fatal("原图不应修改")
	}
	tt.Key(0, ui.KeyEscape)
}

func TestImagePrivacyCleanAutoSendsAndFailurePolicy(t *testing.T) {
	orig, origGo := pfOCR, pfGo
	t.Cleanup(func() { pfOCR, pfGo = orig, origGo })
	pfGo = func(f func()) { f() }
	pfOCR = func(*image.RGBA) ([]macos.OCRLine, error) { return []macos.OCRLine{{Text: "hello", W: 10, H: 10}}, nil }
	a, tt := testApp(t)
	sys := &pngSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	a.send([]store.Note{imageNote(t, a)})
	waitFor(t, func() bool { tt.Frame(); sys.pmu.Lock(); defer sys.pmu.Unlock(); return len(sys.pngs) > 0 })

	// OCR 失败：requireRedaction 禁止发原图
	pfOCR = func(*image.RGBA) ([]macos.OCRLine, error) { return nil, errors.New("vision 不可用") }
	a.send([]store.Note{imageNote(t, a)})
	waitFor(t, func() bool { tt.Frame(); return len(a.pf.images) == 1 && a.pf.images[0].status == "failed" })
	if e := a.pfImageEval("requireRedaction"); e.canSend {
		t.Fatalf("%+v", e)
	}
	if e := a.pfImageEval("allowRaw"); e.canSend || e.needRaw != "block" {
		t.Fatalf("%+v", e)
	}
	a.pf.images[0].rawOK = true
	if e := a.pfImageEval("allowRaw"); !e.canSend || !e.noEnter {
		t.Fatalf("确认后可发、不回车 %+v", e)
	}
}
