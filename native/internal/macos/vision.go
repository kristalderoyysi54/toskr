//go:build darwin

package macos

import (
	"errors"
	"strings"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

var visionOnce sync.Once

// OCR 用 Vision 的 VNRecognizeTextRequest 识别图片文字（精确模式 + 语言校正），
// 按行拼接。对应 Rust 版 screenshot/ocr.rs。任意线程可调。
func OCR(path string, languages []string) (string, error) {
	load()
	var loadErr error
	visionOnce.Do(func() {
		_, loadErr = purego.Dlopen("/System/Library/Frameworks/Vision.framework/Vision", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	})
	if loadErr != nil {
		return "", loadErr
	}
	var lines []string
	var err error
	withPool(func() {
		url := class("NSURL").Send(sel("fileURLWithPath:"), nsString(path))
		opts := class("NSDictionary").Send(sel("dictionary"))
		handler := class("VNImageRequestHandler").Send(sel("alloc")).Send(sel("initWithURL:options:"), url, opts)
		defer handler.Send(sel("release"))
		req := class("VNRecognizeTextRequest").Send(sel("alloc")).Send(sel("init"))
		defer req.Send(sel("release"))
		req.Send(sel("setRecognitionLevel:"), 0) // VNRequestTextRecognitionLevelAccurate
		req.Send(sel("setUsesLanguageCorrection:"), true)
		if len(languages) > 0 {
			ids := make([]objc.ID, len(languages))
			for i, l := range languages {
				ids[i] = nsString(l)
			}
			arr := class("NSArray").Send(sel("arrayWithObjects:count:"), unsafe.Pointer(&ids[0]), len(ids))
			req.Send(sel("setRecognitionLanguages:"), arr)
		}
		reqs := class("NSArray").Send(sel("arrayWithObject:"), req)
		var nserr objc.ID
		if !objc.Send[bool](handler, sel("performRequests:error:"), reqs, unsafe.Pointer(&nserr)) {
			err = errors.New("文字识别失败：" + goString(uintptr(nserr.Send(sel("localizedDescription")))))
			return
		}
		results := req.Send(sel("results"))
		n := objc.Send[uint](results, sel("count"))
		for i := range n {
			cands := results.Send(sel("objectAtIndex:"), i).Send(sel("topCandidates:"), 1)
			if objc.Send[uint](cands, sel("count")) == 0 {
				continue
			}
			lines = append(lines, goString(uintptr(cands.Send(sel("firstObject")).Send(sel("string")))))
		}
	})
	return strings.Join(lines, "\n"), err
}

// OCRLine 是一行识别结果，框为图片像素坐标（原点左上）。
type OCRLine struct {
	Text       string
	X, Y, W, H float64
}

// OCRLines 同 OCR，但逐行带位置（图内翻译要把译文盖回原处）；w/h 为图片像素尺寸。
// 语言固定简体中文 + 英文（与 Rust ocr.rs 一致）。
func OCRLines(path string, w, h int) ([]OCRLine, error) {
	load()
	var loadErr error
	visionOnce.Do(func() {
		_, loadErr = purego.Dlopen("/System/Library/Frameworks/Vision.framework/Vision", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	})
	if loadErr != nil {
		return nil, loadErr
	}
	var out []OCRLine
	var err error
	withPool(func() {
		url := class("NSURL").Send(sel("fileURLWithPath:"), nsString(path))
		opts := class("NSDictionary").Send(sel("dictionary"))
		handler := class("VNImageRequestHandler").Send(sel("alloc")).Send(sel("initWithURL:options:"), url, opts)
		defer handler.Send(sel("release"))
		req := class("VNRecognizeTextRequest").Send(sel("alloc")).Send(sel("init"))
		defer req.Send(sel("release"))
		req.Send(sel("setRecognitionLevel:"), 0)
		ids := []objc.ID{nsString("zh-Hans"), nsString("en-US")}
		req.Send(sel("setRecognitionLanguages:"), class("NSArray").Send(sel("arrayWithObjects:count:"), unsafe.Pointer(&ids[0]), len(ids)))
		reqs := class("NSArray").Send(sel("arrayWithObject:"), req)
		var nserr objc.ID
		if !objc.Send[bool](handler, sel("performRequests:error:"), reqs, unsafe.Pointer(&nserr)) {
			err = errors.New("文字识别失败：" + goString(uintptr(nserr.Send(sel("localizedDescription")))))
			return
		}
		results := req.Send(sel("results"))
		for i := range objc.Send[uint](results, sel("count")) {
			obs := results.Send(sel("objectAtIndex:"), i)
			cands := obs.Send(sel("topCandidates:"), 1)
			if objc.Send[uint](cands, sel("count")) == 0 {
				continue
			}
			s := goString(uintptr(cands.Send(sel("firstObject")).Send(sel("string"))))
			if strings.TrimSpace(s) == "" {
				continue
			}
			b := objc.Send[cgRect](obs, sel("boundingBox")) // 归一化、原点左下
			fw, fh := float64(w), float64(h)
			out = append(out, OCRLine{Text: s, X: b.X * fw, Y: (1 - b.Y - b.H) * fh, W: b.W * fw, H: b.H * fh})
		}
	})
	return out, err
}

// DetectBarcodes 识别图片里的二维码 / 条码，返回各自的文本内容（去重，保持识别顺序）。
func DetectBarcodes(path string) ([]string, error) {
	load()
	var loadErr error
	visionOnce.Do(func() {
		_, loadErr = purego.Dlopen("/System/Library/Frameworks/Vision.framework/Vision", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	})
	if loadErr != nil {
		return nil, loadErr
	}
	var out []string
	var err error
	withPool(func() {
		url := class("NSURL").Send(sel("fileURLWithPath:"), nsString(path))
		opts := class("NSDictionary").Send(sel("dictionary"))
		handler := class("VNImageRequestHandler").Send(sel("alloc")).Send(sel("initWithURL:options:"), url, opts)
		defer handler.Send(sel("release"))
		req := class("VNDetectBarcodesRequest").Send(sel("alloc")).Send(sel("init"))
		defer req.Send(sel("release"))
		reqs := class("NSArray").Send(sel("arrayWithObject:"), req)
		var nserr objc.ID
		if !objc.Send[bool](handler, sel("performRequests:error:"), reqs, unsafe.Pointer(&nserr)) {
			err = errors.New("二维码识别失败：" + goString(uintptr(nserr.Send(sel("localizedDescription")))))
			return
		}
		results := req.Send(sel("results"))
		for i := range objc.Send[uint](results, sel("count")) {
			p := results.Send(sel("objectAtIndex:"), i).Send(sel("payloadStringValue"))
			if p == 0 {
				continue
			}
			s := strings.TrimSpace(goString(uintptr(p)))
			dup := false
			for _, x := range out {
				dup = dup || x == s
			}
			if s != "" && !dup {
				out = append(out, s)
			}
		}
	})
	return out, err
}
