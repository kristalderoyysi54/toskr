package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 剪贴 ⇄ 笔记换页的帧耗时（600 条合成数据，同用户实测数据量）。
func TestPerfPageSwitch(t *testing.T) {
	if os.Getenv("TOSKR_PERF") == "" {
		t.Skip("TOSKR_PERF=1 时运行")
	}
	a, _ := testApp(t)
	for i := range 600 {
		sec := store.SectionInbox
		if i%3 == 0 {
			sec = store.SectionClipboard
		}
		_, _, _ = a.store.Add(store.Note{Section: sec, Text: fmt.Sprintf("#%d %s", i, strings.Repeat("这是一段用于性能对比的合成笔记内容，English `x`。", 1+i%12))})
	}
	a.reload()
	tt := ui.NewTester(a.panelView, 380, 760)
	tt.Frame()
	for _, p := range []int{pageClip, pageNotes, pageClip, pageNotes} {
		a.switchPage(p)
		var worst, total time.Duration
		for i := range 30 {
			st := time.Now()
			tt.Advance(16 * time.Millisecond)
			tt.Frame()
			d := time.Since(st)
			total += d
			if d > worst {
				worst = d
			}
			_ = i
		}
		fmt.Printf("page %d: 首帧后 30 帧 平均 %v 最慢 %v\n", p, total/30, worst)
	}
}
