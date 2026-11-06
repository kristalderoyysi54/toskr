package main

import (
	"testing"

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
	}
	for _, op := range textOps {
		if w, ok := want[op.id]; ok {
			if got, err := op.apply(w[0]); err != nil || got != w[1] {
				t.Errorf("%s(%q) = %q %v", op.id, w[0], got, err)
			}
		}
	}
	if _, err := textOps[4].apply("{坏"); err == nil {
		t.Fatal("JSON 不合法应报错")
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
