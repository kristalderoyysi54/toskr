//go:build darwin

package macos

import (
	"strings"
	"sync"

	"github.com/ebitengine/purego"
)

type cfRange struct{ Loc, Len int }

var (
	wordsOnce              sync.Once
	cfStringTokenizerCreate func(alloc, s uintptr, r cfRange, options uint, locale uintptr) uintptr
	cfStringTokenizerNext   func(tok uintptr) uint
	cfStringTokenizerRange  func(tok uintptr) cfRange
	cfLocaleCreate          func(alloc, id uintptr) uintptr
)

// WordRanges 用系统分词（CFStringTokenizer 词粒度、zh-Hans 区域，ICU 词典分词）切词，返回各词在 s 里的字节区间；
// 对应 Tauri 详情窗选词的 Intl.Segmenter("zh-Hans", {granularity: "word"})（WebKit 同用 ICU）。
func WordRanges(s string) [][2]int {
	if s == "" {
		return nil
	}
	load()
	wordsOnce.Do(func() {
		purego.RegisterLibFunc(&cfStringTokenizerCreate, cf, "CFStringTokenizerCreate")
		purego.RegisterLibFunc(&cfStringTokenizerNext, cf, "CFStringTokenizerAdvanceToNextToken")
		purego.RegisterLibFunc(&cfStringTokenizerRange, cf, "CFStringTokenizerGetCurrentTokenRange")
		purego.RegisterLibFunc(&cfLocaleCreate, cf, "CFLocaleCreate")
	})
	// UTF-16 下标 → 字节下标（CFString 按 UTF-16 计）
	byteAt := make([]int, 0, len(s)+1)
	for i, r := range s {
		byteAt = append(byteAt, i)
		if r >= 0x10000 {
			byteAt = append(byteAt, i)
		}
	}
	byteAt = append(byteAt, len(s))
	str := CFStringCreateWithBytes(0, &[]byte(s)[0], len(s), kCFStringEncodingUTF8, false)
	if str == 0 {
		return nil
	}
	defer CFRelease(str)
	locID := CFStringCreateWithBytes(0, &[]byte("zh-Hans")[0], 7, kCFStringEncodingUTF8, false)
	defer CFRelease(locID)
	loc := cfLocaleCreate(0, locID)
	if loc != 0 {
		defer CFRelease(loc)
	}
	tok := cfStringTokenizerCreate(0, str, cfRange{0, CFStringGetLength(str)}, 0, loc) // kCFStringTokenizerUnitWord
	if tok == 0 {
		return nil
	}
	defer CFRelease(tok)
	var out [][2]int
	for cfStringTokenizerNext(tok) != 0 {
		r := cfStringTokenizerRange(tok)
		lo, hi := r.Loc, r.Loc+r.Len
		if lo < 0 || hi > len(byteAt)-1 || lo >= hi {
			continue
		}
		lo, hi = byteAt[lo], byteAt[hi]
		// 同 UAX #29 WB6/7、WB13：字母数字之间的 . ' _ 不断词（demo.user、example.com、a_b 各成一词）
		if n := len(out); n > 0 && lo-out[n-1][1] == 1 && strings.ContainsRune(".'_", rune(s[lo-1])) &&
			isAlnumByte(s[lo-2]) && isAlnumByte(s[lo]) {
			out[n-1][1] = hi
			continue
		}
		out = append(out, [2]int{lo, hi})
	}
	return out
}

func isAlnumByte(b byte) bool {
	return b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}
