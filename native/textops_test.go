package main

import (
	"strings"
	"testing"
	"time"

	"github.com/toskr/native/internal/store"
)

func TestTextOps(t *testing.T) {
	want := map[string][2]string{
		"trim":              {"  a  ", "a"},
		"strip-blank-lines": {"a\n\n  \nb", "a\nb"},
		"upper":             {"ab", "AB"},
		"json-pretty":       {`{"a":1}`, "{\n  \"a\": 1\n}"},
		"url-decode":        {"%E4%B8%AD+%20", "中+ "},
		"strip-md":          {"**粗**", "粗"},
		"base64-encode":     {"你好", "5L2g5aW9"},
		"base64-decode":     {"5L2g5aW9", "你好"},
		"dedupe-lines":      {"b\na\nb\na", "b\na"},
		"sort-lines":        {"b\nc\na", "a\nb\nc"},
		"to-halfwidth":      {"ＡＢＣ，１２　x", "ABC,12 x"},
		"to-fullwidth":      {"A1,", "Ａ１，"},
		"cjk-space":         {"用Go写了3个test 文件", "用 Go 写了 3 个 test 文件"},
		"extract-links":     {"见 https://a.com/x。还有（http://b.cn/y?z=1）和 https://a.com/x", "https://a.com/x\nhttp://b.cn/y?z=1"},
		"timestamp":         {"1700000000", time.Unix(1700000000, 0).Format("2006-01-02 15:04:05")},
	}
	seen := 0
	for _, op := range textOps {
		if w, ok := want[op.id]; ok {
			seen++
			if got, err := op.apply(w[0]); err != nil || got != w[1] {
				t.Errorf("%s(%q) = %q %v", op.id, w[0], got, err)
			}
		}
	}
	if _, err := textOps[4].apply("{坏"); err == nil {
		t.Fatal("JSON 不合法应报错")
	}
	if seen != len(want) {
		t.Fatalf("表里缺操作：命中 %d / %d", seen, len(want))
	}
	// 日期 → 时间戳往返；无法识别 / 无链接 / 坏 Base64 报错，草稿不动
	back, err := convertTimestamp(time.Unix(1700000000, 0).Format("2006-01-02 15:04:05"))
	if err != nil || back != "1700000000" {
		t.Fatalf("日期转时间戳 %q %v", back, err)
	}
	if ms, err := convertTimestamp("1700000000123"); err != nil || !strings.HasSuffix(ms, ".123") {
		t.Fatalf("毫秒时间戳 %q %v", ms, err)
	}
	for _, bad := range []struct {
		f  func(string) (string, error)
		in string
	}{{convertTimestamp, "明天"}, {convertTimestamp, "12345"}, {extractLinks, "没有链接"}, {base64Decode, "不是 b64!"}} {
		if _, err := bad.f(bad.in); err == nil {
			t.Fatalf("%q 应报错", bad.in)
		}
	}
}

// 输入区：魔棒处理草稿；↗ 转大窗编辑把草稿落成当前分组的卡并在详情窗编辑、清空输入区。
func TestComposerDraftTools(t *testing.T) {
	a, tt := testApp(t)
	old := openDetailFn
	defer func() { openDetailFn = old }()
	openDetailFn = func(a *app, n store.Note) { a.detail = detailState{id: n.ID} }
	a.draft = "  abc  "
	tt.Frame()
	_ = tt.Click("处理新增草稿")
	if err := tt.ChooseMenuItem("转大写"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	a.applyDraftOp(0) // 去首尾空白
	if a.draft != "ABC" {
		t.Fatalf("%q", a.draft)
	}
	if err := tt.Click("转大窗编辑"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	got := a.store.Section(store.SectionInbox)
	if len(got) != 1 || got[0].Text != "ABC" || a.draft != "" || a.detail.id != got[0].ID || !a.detail.edit {
		t.Fatalf("转大窗编辑 %+v draft=%q", got, a.draft)
	}
}
