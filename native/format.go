package main

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
)

// preview 取首行前 n 个字符。
func preview(s string, n int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// ago 是相对时间（短格式，随界面语言）。
func ago(t, now time.Time) string {
	d := now.Sub(t)
	switch {
	case d < time.Minute:
		return tr("刚刚")
	case d < time.Hour:
		return fmt.Sprintf(tr("%d 分钟前"), int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf(tr("%d 小时前"), int(d.Hours()))
	case d < 7*24*time.Hour:
		return fmt.Sprintf(tr("%d 天前"), int(d.Hours()/24))
	}
	if langEN.Load() {
		return t.Format("Jan 2")
	}
	return t.Format("1月2日")
}

var pctRe = regexp.MustCompile(`\d+%`)

// numSlot：会随数值变化的文字（计数、百分比、张序）预留的最小宽度——数字一律按「8」量（配合 tnum 等宽数字），
// 百分比按 3 位预留。避免数值位数一变，同行后面的控件跟着左右跳。
func numSlot(c *ui.Context, s string, size float32, weight int) float32 {
	s = pctRe.ReplaceAllString(s, "888%")
	s = strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return '8'
		}
		return r
	}, s)
	w, _ := c.MeasureText(0, ui.Span{Text: s, Font: fontSans, Size: size, Weight: weight})
	return w + 1
}
