package main

import (
	"fmt"
	"testing"

	"github.com/toskr/native/internal/store"
)

// 同 Tauri SectionGroup sticky：滚过组首后区头吸顶，组尾把它推走；吸顶时点标题回到组首。
func TestSectionHeaderSticks(t *testing.T) {
	var texts []string
	for i := range 12 {
		texts = append(texts, fmt.Sprintf("卡片 %d", i))
	}
	a, tt := testApp(t, texts...)
	sec := a.store.AddSection("资料")
	for i := range 6 {
		_, _, _ = a.store.Add(store.Note{Section: sec, Text: fmt.Sprintf("资料卡 %d", i)})
	}
	a.reload()
	tt.Frame()
	a.noteScroll.Y = 400
	tt.Frame()
	tt.Frame()
	top, ok := a.stick.top[store.SectionInbox]
	if !ok {
		t.Fatalf("滚过组首后收件箱区头应吸顶 %v", a.stick.top)
	}
	if _, ok := a.stick.top[sec]; ok {
		t.Fatal("还没滚到的分组不吸顶")
	}
	a.noteScroll.Y = 1420
	tt.Frame()
	tt.Frame()
	a.noteScroll.Y = 0
	tt.Frame()
	tt.Frame()
	if len(a.stick.top) != 0 {
		t.Fatalf("回到顶部不吸顶 %v", a.stick.top)
	}
	_ = top
}
