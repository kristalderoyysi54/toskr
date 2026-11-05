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
