package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// seedIfRequested：启动时环境变量 TOSKR_SEED=N 且队列为空，写入 N 条合成笔记
// （长度 80–1200 字符，接近 Tauri 版实际数据），仅用于性能对比测量。
func seedIfRequested(st *store.Store) {
	n, _ := strconv.Atoi(os.Getenv("TOSKR_SEED"))
	if n <= 0 || len(st.Notes()) > 0 {
		return
	}
	base := "这是一段用于性能对比的合成笔记内容，包含中文、English words 与代码 `fmt.Println(x)`。"
	started := time.Now()
	for i := 0; i < n; i++ {
		text := fmt.Sprintf("#%d %s", i, strings.Repeat(base, 1+i%12))
		section := store.SectionInbox
		if i%3 == 0 {
			section = store.SectionClipboard
		}
		_, _, _ = st.Add(store.Note{Section: section, Text: text, SourceApp: "Seed", CreatedAt: time.Now().Add(-time.Duration(i) * time.Minute)})
	}
	diag.Push("合成数据 %d 条 耗时 %dms", n, time.Since(started).Milliseconds())
}
