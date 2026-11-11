package main

import (
	"strings"
	"testing"
)

func joinSide(segs []diffSeg, skip diffKind) string {
	var b strings.Builder
	for _, s := range segs {
		if s.kind != skip {
			b.WriteString(s.text)
		}
	}
	return b.String()
}

// 差分两边各自还原出原文 / 新文；替换为占位符时是一删一增。
func TestTextDiff(t *testing.T) {
	for _, c := range [][2]string{
		{"联系我 alice@example.com 谢谢", "联系我 [EMAIL_1] 谢谢"},
		{"", "新内容"},
		{"旧内容", ""},
		{"相同", "相同"},
		{"abc\ndef\nghi", "abc\nDEF\nghi\njkl"},
	} {
		segs := textDiff(c[0], c[1])
		if joinSide(segs, diffIns) != c[0] || joinSide(segs, diffDel) != c[1] {
			t.Fatalf("%q → %q 还原失败 %+v", c[0], c[1], segs)
		}
	}
	_, _, n := diffSides(textDiff("电话 13800138000，邮箱 a@b.co", "电话 [PHONE_1]，邮箱 [EMAIL_1]"))
	if n != 2 {
		t.Fatalf("应为 2 处改动，得到 %d", n)
	}
	long := strings.Repeat("甲乙丙丁戊", 2000)
	other := strings.Repeat("子丑寅卯辰", 2000)
	if segs := textDiff(long, other); joinSide(segs, diffIns) != long || joinSide(segs, diffDel) != other {
		t.Fatal("改动过多退回按行比也要能还原")
	}
}
