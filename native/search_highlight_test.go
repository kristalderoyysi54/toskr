package main

import (
	"testing"
)

func TestSplitHighlight(t *testing.T) {
	segs := splitHighlight("Hello 世界 hello", "hello")
	if len(segs) != 3 || !segs[0].hit || segs[0].text != "Hello" || segs[1].text != " 世界 " || !segs[2].hit {
		t.Fatalf("%+v", segs)
	}
	if s := splitHighlight("abc", ""); len(s) != 1 || s[0].hit {
		t.Fatal(s)
	}
}

func TestSearchCountAndHighlight(t *testing.T) {
	a, tt := testApp(t, "周报草稿", "周会纪要", "买牛奶")
	a.searchOpen, a.query = true, "周"
	a.reload()
	tt.Frame()
	if a.searchMatchCount() != 2 || !tt.HasText("2") {
		t.Fatalf("命中计数：%d %v", a.searchMatchCount(), tt.Texts())
	}
	if !tt.HasText("周报草稿") {
		t.Fatal("高亮后正文仍完整可读", tt.Texts())
	}
	if err := tt.Click("关闭搜索"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.searchOpen || a.query != "" {
		t.Fatal("关闭搜索应清空")
	}
}
