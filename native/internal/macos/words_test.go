//go:build darwin

package macos

import (
	"strings"
	"testing"
)

func TestWordRanges(t *testing.T) {
	s := "复现测试 一段文字 demo.user@example.com我·w 😀表情"
	var words []string
	for _, r := range WordRanges(s) {
		words = append(words, s[r[0]:r[1]])
	}
	t.Logf("%q", words)
	want := []string{"复现", "测试", "一", "段", "文字", "demo.user", "example.com", "我", "w", "😀", "表情"}
	if strings.Join(words, "|") != strings.Join(want, "|") {
		t.Fatalf("应按词切分（同 Intl.Segmenter）：%q", words)
	}
}
